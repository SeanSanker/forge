import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Effect, Layer, Stream } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';

import { Api, Auth } from '../sdk/effect.js';

// An HttpClient that answers as Cloudflare does: each body in its envelope.
function cloudflare(answer: (url: URL) => { result: unknown; result_info?: unknown }) {
  const urls: URL[] = [];
  const client = HttpClient.make((request, url) => {
    urls.push(url);
    const body = { success: true, errors: [], messages: [], ...answer(url) };
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
  });
  const layer = Api.layer({ auth: Auth.bearer('test') }).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );
  return { urls, layer };
}

test('R2 buckets page by the cursor in the envelope, beside the unwrapped result', async () => {
  const pages: { [cursor: string]: { names: string[]; next?: string } } = {
    '': { names: ['a', 'b'], next: 'c1' },
    c1: { names: ['c'], next: 'c2' },
    c2: { names: [] },
  };
  const { urls, layer } = cloudflare((url) => {
    const page = pages[url.searchParams.get('cursor') ?? '']!;
    return {
      result: { buckets: page.names.map((name) => ({ name })) },
      result_info: page.next === undefined ? { per_page: 2 } : { cursor: page.next, per_page: 2 },
    };
  });
  const names = await Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* Api;
      return yield* api.r2.buckets.listAll({ accountId: 'acc' }).pipe(Stream.runCollect);
    }).pipe(Effect.provide(layer)),
  );
  assert.deepEqual(
    names.map((b) => b.name),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    urls.map((u) => u.searchParams.get('cursor')),
    [null, 'c1', 'c2'],
  );
});

test('a single result is unwrapped from its envelope', async () => {
  const { layer } = cloudflare(() => ({ result: { id: 'ns1', title: 'tour' } }));
  const namespace = await Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* Api;
      return yield* api.kv.namespaces.get({ accountId: 'acc', namespaceId: 'ns1' });
    }).pipe(Effect.provide(layer)),
  );
  assert.deepEqual(namespace, { id: 'ns1', title: 'tour' });
});
