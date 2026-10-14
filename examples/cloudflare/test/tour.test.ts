import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Effect, Exit, Layer, Stream } from 'effect';
import { HttpClientRequest, HttpClientResponse } from 'effect/http';

import type { CreateResponse as D1Database, QueryResponse } from '../sdk/d1/index.js';
import { Api, ApiError } from '../sdk/effect.js';
import type { WorkersKvKey } from '../sdk/kv/keys/index.js';
import type { WorkersKvApiResponseCommonFailure } from '../sdk/kv/index.js';
import type { WorkersKvNamespace } from '../sdk/kv/namespaces/index.js';
import { Account, tour } from '../src/tour.js';

// A fake Cloudflare with one account, which keeps what the tour makes so
// the test can check it's all gone at the end.
function fake(options: { readonly failWrites?: boolean } = {}) {
  const namespaces = new Map<string, string[]>();
  const databases = new Set<string>();
  const layer = Api.layerTest({
    kv: {
      namespaces: {
        create: ({ title }) =>
          Effect.sync(() => {
            namespaces.set('ns1', []);
            return { id: 'ns1', title } as WorkersKvNamespace;
          }),
        delete: ({ namespaceId }) => Effect.sync(() => (namespaces.delete(namespaceId), null)),
        // No other namespace exists: a 404, as Cloudflare answers it.
        get: () => {
          const errors = [{ code: 10013, message: "get namespace: 'namespace not found'" }];
          const response = HttpClientResponse.fromWeb(
            HttpClientRequest.get('https://api.cloudflare.com/'),
            new Response(JSON.stringify({ success: false, errors }), { status: 404 }),
          );
          const details: WorkersKvApiResponseCommonFailure = { errors, messages: [], result: null, success: false };
          const reason = { _tag: 'Status4XX', status: 404, details } as const;
          return Effect.fail(new ApiError({ message: errors[0]!.message, status: 404, response, reason }));
        },
      },
      bulk: {
        put: ({ namespaceId, body }) =>
          options.failWrites
            ? Effect.die(new Error('the write failed'))
            : Effect.sync(() => {
                namespaces.get(namespaceId)!.push(...body.map((entry) => entry.key));
                return {};
              }),
      },
      keys: {
        listAll: ({ namespaceId, prefix }) =>
          Stream.fromIterable(
            (namespaces.get(namespaceId) ?? [])
              .filter((name) => prefix === undefined || name.startsWith(prefix))
              .sort()
              .map((name) => ({ name }) as WorkersKvKey),
          ),
      },
    },
    d1: {
      create: ({ name }) =>
        Effect.sync(() => {
          databases.add('db1');
          return { uuid: 'db1', name } as D1Database;
        }),
      delete: ({ databaseId }) => Effect.sync(() => (databases.delete(databaseId), null)),
      query: () => Effect.succeed({ result: [{ results: [] }] } as unknown as QueryResponse),
      listAll: () => Stream.fromIterable([...databases].map((uuid) => ({ uuid }))),
    },
  });
  return { namespaces, databases, layer: Layer.merge(layer, Layer.succeed(Account, Account.of({ id: 'acc' }))) };
}

test('the tour writes 100 keys, reads them back, and deletes what it made', async () => {
  const cloudflare = fake();
  await Effect.runPromise(tour.pipe(Effect.provide(cloudflare.layer)));
  assert.equal(cloudflare.namespaces.size, 0);
  assert.equal(cloudflare.databases.size, 0);
});

test('a tour that fails part way still deletes what it made', async () => {
  const cloudflare = fake({ failWrites: true });
  const exit = await Effect.runPromiseExit(tour.pipe(Effect.provide(cloudflare.layer)));
  assert.ok(Exit.isFailure(exit));
  assert.equal(cloudflare.namespaces.size, 0);
});
