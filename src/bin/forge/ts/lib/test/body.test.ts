import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { formData, rawBytes, urlEncoded } from '../src/body.js';

describe('formData', () => {
  test('makes each field a part: files for binary values, text for the rest', async () => {
    const form = formData({
      module: new File(['export default {}'], 'worker.js', { type: 'application/javascript+module' }),
      blob: new Blob(['b']),
      bytes: new Uint8Array([1, 2]),
      name: 'demo',
      count: 3,
      big: 2n ** 64n,
      metadata: { main_module: 'worker.js' },
      skipped: undefined,
    });
    const module = form.get('module');
    assert.ok(module instanceof File);
    assert.equal(module.name, 'worker.js');
    assert.equal(module.type, 'application/javascript+module');
    assert.equal(await module.text(), 'export default {}');
    // A Blob or bytes without a name are named after their field.
    assert.equal((form.get('blob') as File).name, 'blob');
    assert.deepEqual(new Uint8Array(await (form.get('bytes') as File).arrayBuffer()), new Uint8Array([1, 2]));
    assert.equal((form.get('bytes') as File).name, 'bytes');
    assert.equal(form.get('name'), 'demo');
    assert.equal(form.get('count'), '3');
    assert.equal(form.get('big'), '18446744073709551616');
    assert.equal(form.get('metadata'), '{"main_module":"worker.js"}');
    assert.equal(form.has('skipped'), false);
  });

  test('makes a part of each element of an array', () => {
    const form = formData({ files: [new File(['a'], 'a.js'), new File(['b'], 'b.js')], tags: ['x', 'y'] });
    assert.deepEqual(
      form.getAll('files').map((f) => (f as File).name),
      ['a.js', 'b.js'],
    );
    assert.deepEqual(form.getAll('tags'), ['x', 'y']);
  });

  test('sends a string in a file field as a file, named after the field', async () => {
    const form = formData({ value: 'héllo', note: 'text' }, ['value']);
    const value = form.get('value');
    assert.ok(value instanceof File);
    assert.equal(value.name, 'value');
    assert.equal(await value.text(), 'héllo');
    assert.equal(form.get('note'), 'text');
  });
});

describe('urlEncoded', () => {
  test('writes each field, an array as the field repeated, and objects as JSON', () => {
    const params = urlEncoded({ tag: 'a b', ids: [1, 2], meta: { k: 'v' }, none: undefined });
    assert.equal(params.toString(), 'tag=a+b&ids=1&ids=2&meta=%7B%22k%22%3A%22v%22%7D');
  });
});

describe('rawBytes', () => {
  test("uses a Blob's own type, or else the operation's", async () => {
    const typed = await rawBytes(new Blob(['png'], { type: 'image/png' }), 'application/octet-stream');
    assert.equal(typed.contentType, 'image/png');
    assert.equal(new TextDecoder().decode(typed.bytes), 'png');
    const untyped = await rawBytes(new Blob(['x']), 'application/octet-stream');
    assert.equal(untyped.contentType, 'application/octet-stream');
  });

  test('sends a string as UTF-8, and bytes as they are', async () => {
    assert.deepEqual((await rawBytes('é', undefined)).bytes, new Uint8Array([0xc3, 0xa9]));
    const bytes = new Uint8Array([1, 2, 3]);
    assert.equal((await rawBytes(bytes, undefined)).bytes, bytes);
    assert.deepEqual((await rawBytes(bytes.buffer, undefined)).bytes, bytes);
  });
});
