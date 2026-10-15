import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';

import { Api, Auth } from '../sdk/effect.js';

// An HttpClient that keeps each request, and answers with `answer`.
function fake(answer: (url: URL) => Response) {
  const requests: { url: URL; body: unknown; headers: Record<string, string> }[] = [];
  const client = HttpClient.make((request, url) => {
    const body = request.body;
    requests.push({
      url,
      headers: { ...request.headers },
      body: body._tag === 'FormData' ? body.formData : body._tag === 'Uint8Array' ? body.body : undefined,
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, answer(url)));
  });
  const layer = Api.layer({ auth: Auth.bearer('test') }).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );
  return { requests, layer };
}

test('a KV value is written as multipart, with its metadata as JSON, and read as bytes', async () => {
  const { requests, layer } = fake((url) =>
    url.pathname.endsWith('/values/greeting') && requests.at(-1)?.body === undefined
      ? new Response(new TextEncoder().encode('héllo'))
      : Response.json({ success: true, errors: [], messages: [], result: null }),
  );
  const value = await Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* Api;
      yield* api.kv.keys.put({
        accountId: 'acc',
        namespaceId: 'ns',
        keyName: 'greeting',
        value: 'héllo',
        metadata: { by: 'forge' },
        expirationTtl: 60,
      });
      return yield* api.kv.keys.get({ accountId: 'acc', namespaceId: 'ns', keyName: 'greeting' });
    }).pipe(Effect.provide(layer)),
  );
  const form = requests[0]!.body as FormData;
  assert.equal(form.get('metadata'), '{"by":"forge"}');
  assert.equal(await (form.get('value') as File).text(), 'héllo');
  assert.equal(requests[0]!.url.searchParams.get('expiration_ttl'), '60');
  assert.equal(requests[1]!.headers['accept'], 'application/octet-stream');
  assert.equal(new TextDecoder().decode(value), 'héllo');
});

test('an R2 object is uploaded as raw bytes, with its own content type', async () => {
  const { requests, layer } = fake(() =>
    Response.json({ success: true, errors: [], messages: [], result: { key: 'a.txt', etag: 'e' } }),
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* Api;
      return yield* api.r2.objects.put({
        accountId: 'acc',
        bucketName: 'b',
        objectKey: 'a.txt',
        body: new Blob(['hi'], { type: 'text/plain' }),
      });
    }).pipe(Effect.provide(layer)),
  );
  assert.equal(new TextDecoder().decode(requests[0]!.body as Uint8Array), 'hi');
  assert.equal(requests[0]!.headers['content-type'], 'text/plain');
  assert.equal(result.etag, 'e');
});
