import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Effect, Stream } from 'effect';

import { object } from '../src/codec.js';
import { ApiError, EffectTransport } from '../src/effect.js';
import type { Operation } from '../src/index.js';
import { json, mock } from './mock.js';

const send = <T>(operation: Operation, request: object | undefined, ...responses: Response[]) => {
  const { sent, client } = mock(...responses);
  const transport = new EffectTransport(client, { baseUrl: 'https://api.test/v1/' });
  return { sent, effect: transport.send<T>(operation, request, undefined) };
};

test('a multipart body is form data, with files and JSON parts', async () => {
  const upload: Operation = {
    method: 'PUT',
    route: '/scripts/{name}',
    body: 'flat',
    encoding: 'multipart',
    request: object([['metadata', null, object([['main_module', 'mainModule']])]]),
  };
  const { sent, effect } = send(
    upload,
    {
      name: 'demo',
      metadata: { mainModule: 'worker.js' },
      files: [new File(['export default {}'], 'worker.js', { type: 'application/javascript+module' })],
    },
    new Response(null, { status: 204 }),
  );
  await Effect.runPromise(effect);
  const form = sent[0]!.form!;
  assert.equal(form.get('metadata'), '{"main_module":"worker.js"}');
  const file = form.get('files') as File;
  assert.equal(file.name, 'worker.js');
  assert.equal(await file.text(), 'export default {}');
  // The form data sets the content type, with its boundary.
  assert.equal(sent[0]!.headers['content-type'], undefined);
  assert.equal(sent[0]!.url, 'https://api.test/v1/scripts/demo');
});

test('a form body is URL-encoded', async () => {
  const { sent, effect } = send(
    {
      method: 'POST',
      route: '/logos',
      body: 'flat',
      encoding: 'form',
      contentType: 'application/x-www-form-urlencoded',
    },
    { tag: 'a', url: 'https://x.test' },
    new Response(null, { status: 204 }),
  );
  await Effect.runPromise(effect);
  assert.equal(sent[0]!.body, 'tag=a&url=https%3A%2F%2Fx.test');
  assert.equal(sent[0]!.headers['content-type'], 'application/x-www-form-urlencoded');
});

test("a raw body is sent as bytes, with a Blob's type or the operation's", async () => {
  const put: Operation = {
    method: 'PUT',
    route: '/objects/{key}',
    body: 'nested',
    encoding: 'raw',
    contentType: 'application/octet-stream',
    response: null,
  };
  const bytes = send(put, { key: 'a', body: new Uint8Array([1, 2]) }, json(200, { etag: 'e' }));
  assert.deepEqual(await Effect.runPromise(bytes.effect), { etag: 'e' });
  assert.deepEqual(bytes.sent[0]!.bytes, new Uint8Array([1, 2]));
  assert.equal(bytes.sent[0]!.headers['content-type'], 'application/octet-stream');

  const blob = send(put, { key: 'b', body: new Blob(['<p>'], { type: 'text/html' }) }, json(200, {}));
  await Effect.runPromise(blob.effect);
  assert.equal(blob.sent[0]!.body, '<p>');
  assert.equal(blob.sent[0]!.headers['content-type'], 'text/html');
});

test('bytes and text responses are read as they are, asked for by their media type', async () => {
  const get: Operation = { method: 'GET', route: '/objects/a', response: null };
  const bytes = send(
    { ...get, responseType: 'bytes', accept: 'application/octet-stream' },
    undefined,
    new Response(new Uint8Array([0, 255])),
  );
  assert.deepEqual(await Effect.runPromise(bytes.effect), new Uint8Array([0, 255]));
  assert.equal(bytes.sent[0]!.headers['accept'], 'application/octet-stream');

  // Text that looks like JSON is still text, with no envelope unwrapped.
  const text = send({ ...get, responseType: 'text', accept: 'text/plain' }, undefined, new Response('{"result":1}'));
  assert.equal(await Effect.runPromise(text.effect), '{"result":1}');
});

test('stream reads bytes as they arrive, and fails with an ApiError on an error status', async () => {
  const get: Operation = {
    method: 'GET',
    route: '/objects/{key}',
    response: null,
    responseType: 'bytes',
    accept: 'application/octet-stream',
    errors: { '4XX': true },
  };
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  const { sent, client } = mock(new Response(body), json(404, { errors: [{ code: 10009, message: 'key not found' }] }));
  const transport = new EffectTransport(client, { baseUrl: 'https://api.test/v1/' });

  const read = await Effect.runPromise(Stream.runCollect(transport.stream(get, { key: 'a' }, undefined)));
  assert.deepEqual(
    read.flatMap((chunk) => [...chunk]),
    [1, 2, 3],
  );
  assert.equal(sent[0]!.url, 'https://api.test/v1/objects/a');
  assert.equal(sent[0]!.headers['accept'], 'application/octet-stream');

  const missing = await Effect.runPromise(
    Effect.flip(Stream.runCollect(transport.stream(get, { key: 'b' }, undefined))),
  );
  assert.ok(missing instanceof ApiError);
  assert.equal(missing.status, 404);
  assert.equal(missing.message, 'key not found');
});

test('nothing is sent until the stream is read', async () => {
  const { sent, client } = mock(new Response(new Uint8Array([1])));
  const transport = new EffectTransport(client, { baseUrl: 'https://api.test/v1/' });
  const stream = transport.stream(
    { method: 'GET', route: '/a', response: null, responseType: 'bytes' },
    undefined,
    undefined,
  );
  assert.equal(sent.length, 0);
  await Effect.runPromise(Stream.runDrain(stream));
  assert.equal(sent.length, 1);
});

test('a DELETE with only path parameters sends no body; with fields, it sends them', async () => {
  const remove: Operation = { method: 'DELETE', route: '/buckets/{bucket}/queues/{queue}', body: 'flat' };
  const bare = send(remove, { bucket: 'b', queue: 'q' }, new Response(null, { status: 204 }));
  await Effect.runPromise(bare.effect);
  assert.equal(bare.sent[0]!.body, undefined);
  const withIds = send(remove, { bucket: 'b', queue: 'q', ruleIds: ['r'] }, new Response(null, { status: 204 }));
  await Effect.runPromise(withIds.effect);
  assert.equal(withIds.sent[0]!.body, '{"ruleIds":["r"]}');
});
