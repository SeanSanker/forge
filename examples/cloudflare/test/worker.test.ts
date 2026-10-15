import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Effect, Exit, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';

import type { CreateResponse as D1Database } from '../sdk/d1/index.js';
import { Api, ApiError } from '../sdk/effect.js';
import type { WorkersKvNamespace } from '../sdk/kv/namespaces/index.js';
import type { UpdateRequest, UpdateResponse } from '../sdk/workers/legacy/scripts/index.js';
import type { WorkersApiResponseCommonFailure } from '../sdk/index.js';
import { Account } from '../src/tour.js';
import { workerPreview } from '../src/worker.js';

// A fake Cloudflare that keeps what exists, in the order it happens, and
// rejects a Worker whose source doesn't parse; and a fake workers.dev that
// counts visits.
function fake() {
  const events: string[] = [];
  const uploads: UpdateRequest[] = [];
  let visits = 0;
  const cloudflare = Api.layerTest({
    kv: {
      namespaces: {
        create: ({ title }) => Effect.sync(() => (events.push('+kv'), { id: 'kv1', title } as WorkersKvNamespace)),
        delete: () => Effect.sync(() => (events.push('-kv'), null)),
      },
      keys: { put: () => Effect.sync(() => (events.push('seed kv'), null)) },
    },
    d1: {
      create: ({ name }) => Effect.sync(() => (events.push('+d1'), { uuid: 'd1', name } as D1Database)),
      delete: () => Effect.sync(() => (events.push('-d1'), null)),
      query: () => Effect.sync(() => (events.push('seed d1'), { result: [] })),
    },
    workers: {
      subdomains: { get: () => Effect.succeed({ subdomain: 'acme' }) },
      legacy: {
        scripts: {
          update: (request) =>
            Effect.gen(function* () {
              uploads.push(request);
              const source = yield* Effect.promise(() => (request.files![0] as File).text());
              if (source.includes('fetch((')) {
                const details: WorkersApiResponseCommonFailure = {
                  errors: [{ code: 10021, message: 'Uncaught SyntaxError' }],
                  messages: [],
                  result: null,
                  success: false,
                };
                return yield* Effect.fail(ApiError.fake({ _tag: 'Status4XX', status: 400, details }));
              }
              events.push('+worker');
              return { id: request.scriptName } as UpdateResponse;
            }),
          delete: () => Effect.sync(() => (events.push('-worker'), null)),
          subdomain: {
            create: () => Effect.sync(() => (events.push('url'), { enabled: true, previewsEnabled: false })),
          },
        },
      },
    },
  });
  // A new URL answers with a challenge page first, as workers.dev does.
  let tries = 0;
  const workersDev = HttpClient.make((request, url) =>
    Effect.sync(() => {
      assert.equal(url.host, 'pr-42.acme.workers.dev');
      if (url.pathname === '/health') {
        tries++;
        return HttpClientResponse.fromWeb(request, new Response('ok', { status: tries === 1 ? 403 : 200 }));
      }
      visits++;
      return HttpClientResponse.fromWeb(request, Response.json({ greeting: 'hello from pr-42', visits }));
    }),
  );
  const layer = Layer.mergeAll(
    cloudflare,
    Layer.succeed(Account, Account.of({ id: 'acc' })),
    Layer.succeed(HttpClient.HttpClient, workersDev),
  );
  return { events, uploads, layer };
}

test('a Worker preview is deployed with its bindings, called, and deleted, the Worker first', async () => {
  const cf = fake();
  const answer = await Effect.runPromise(workerPreview('pr-42').pipe(Effect.provide(cf.layer)));
  assert.deepEqual(answer, { greeting: 'hello from pr-42', visits: 3 });

  const upload = cf.uploads[0]!;
  assert.equal(upload.metadata.mainModule, 'worker.js');
  assert.deepEqual(
    upload.metadata.bindings?.map((b) => [b.type, b.name]),
    [
      ['kv_namespace', 'KV'],
      ['d1', 'DB'],
    ],
  );
  assert.equal((upload.files![0] as File).name, 'worker.js');

  // The namespace and database come first, in either order.
  assert.deepEqual(cf.events.slice(0, 2).toSorted(), ['+d1', '+kv']);
  assert.deepEqual(cf.events.slice(2, 4).toSorted(), ['seed d1', 'seed kv']);
  assert.deepEqual(cf.events.slice(4, 6), ['+worker', 'url']);
  assert.equal(cf.events[6], '-worker');
  assert.deepEqual(cf.events.slice(7).toSorted(), ['-d1', '-kv']);
});

test('a Worker that fails to upload leaves nothing behind', async () => {
  const cf = fake();
  const exit = await Effect.runPromiseExit(workerPreview('pr-42', { broken: true }).pipe(Effect.provide(cf.layer)));
  assert.ok(Exit.isFailure(exit));
  assert.ok(!cf.events.includes('+worker'));
  assert.deepEqual(cf.events.filter((e) => e.startsWith('-')).toSorted(), ['-d1', '-kv']);
});
