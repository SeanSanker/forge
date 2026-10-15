import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';

import { Api, Auth } from '../sdk/effect.js';

test('a dotted query parameter is typed, and sent under its own name', async () => {
  const urls: URL[] = [];
  const client = HttpClient.make((request, url) => {
    urls.push(url);
    const body = { success: true, errors: [], messages: [], result: [] };
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
  });
  const layer = Api.layer({ auth: Auth.bearer('test') }).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* Api;
      yield* api.zones.list({ accountId: 'acc' });
    }).pipe(Effect.provide(layer)),
  );
  assert.equal(urls[0]?.searchParams.get('account.id'), 'acc');
  assert.equal(urls[0]?.searchParams.has('accountId'), false);
});
