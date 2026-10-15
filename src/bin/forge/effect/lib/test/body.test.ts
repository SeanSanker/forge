import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Effect } from 'effect';

import { object } from '../src/codec.js';
import { EffectTransport } from '../src/effect.js';
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
