import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Effect, Stream } from 'effect';
import type { HttpClient } from 'effect/http';

import { EffectTransport } from '../src/effect.js';
import type { Operation } from '../src/index.js';
import { type Pagination, paginate } from '../src/paginate.js';
import { json, mockWith } from './mock.js';

const operation: Operation = {
  method: 'GET',
  route: '/things',
  query: { page: 'page', offset: 'offset', limit: 'limit', cursor: 'cursor' },
  response: null,
};

const things = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i }));

const all = <I>(
  client: HttpClient.HttpClient,
  pagination: Pagination,
  request?: object,
  take?: number,
): Promise<readonly I[]> => {
  const transport = new EffectTransport(client, { baseUrl: 'https://api.test' });
  const stream = paginate<I>(transport, operation, pagination, request, undefined);
  return Effect.runPromise(Stream.runCollect(take === undefined ? stream : Stream.take(stream, take)));
};

const search = (url: string) => new URL(url).search;

test('offset: page numbers from 1, until has-next-page is false, keeping the other fields', async () => {
  const { sent, client } = mockWith((_, i) => json(200, { data: things(i * 2 + 1, 2), more: i < 2 }));
  const items = await all<{ id: number }>(
    client,
    { kind: 'offset', offset: 'page', results: ['data'], hasNextPage: ['more'] },
    { limit: 2 },
  );

  assert.deepEqual(
    items.map((t) => t.id),
    [1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    sent.map((s) => search(s.url)),
    ['?page=1&limit=2', '?page=2&limit=2', '?page=3&limit=2'],
  );
});

test('offset: starts from the page the request picks', async () => {
  const { sent, client } = mockWith(() => json(200, { data: [], more: false }));
  await all(client, { kind: 'offset', offset: 'page', results: ['data'], hasNextPage: ['more'] }, { page: 4 });
  assert.deepEqual(
    sent.map((s) => search(s.url)),
    ['?page=4'],
  );
});

test('offset with step: an item index from 0, moved on by the page size, until a short page', async () => {
  const { sent, client } = mockWith((request) => {
    const offset = Number(new URL(request.url).searchParams.get('offset'));
    return json(200, { items: things(offset, offset < 20 ? 10 : 4) });
  });
  const items = await all(
    client,
    { kind: 'offset', offset: 'offset', step: 'limit', results: ['items'] },
    { limit: 10 },
  );

  assert.equal(items.length, 24);
  assert.deepEqual(
    sent.map((s) => search(s.url)),
    ['?offset=0&limit=10', '?offset=10&limit=10', '?offset=20&limit=10'],
  );
});

test('offset: without has-next-page or a page size, an empty page is the last', async () => {
  const { sent, client } = mockWith((_, i) => json(200, { data: i < 2 ? things(i, 3) : [] }));
  const items = await all(client, { kind: 'offset', offset: 'page', results: ['data'] });
  assert.equal(items.length, 6);
  assert.equal(sent.length, 3);
});

test('pages are fetched only as the stream is read', async () => {
  const { sent, client } = mockWith(() => json(200, { data: things(1, 10), more: true }));
  const items = await all(client, { kind: 'offset', offset: 'page', results: ['data'], hasNextPage: ['more'] }, {}, 3);
  assert.equal(items.length, 3);
  assert.equal(sent.length, 1);
});

test('cursor: follows the cursor at its path until there is none', async () => {
  const cursors: Record<string, string | undefined> = { '': 'c2', c2: 'c3', c3: undefined };
  const { sent, client } = mockWith((request) => {
    const cursor = new URL(request.url).searchParams.get('cursor') ?? '';
    const next = cursors[cursor];
    return json(200, {
      result: [{ id: `after-${cursor || 'start'}` }],
      resultInfo: next === undefined ? {} : { cursor: next },
    });
  });
  const items = await all<{ id: string }>(
    client,
    { kind: 'cursor', cursor: 'cursor', nextCursor: ['resultInfo', 'cursor'], results: ['result'] },
    { limit: 1 },
  );

  assert.deepEqual(
    items.map((e) => e.id),
    ['after-start', 'after-c2', 'after-c3'],
  );
  assert.deepEqual(
    sent.map((s) => search(s.url)),
    ['?limit=1', '?limit=1&cursor=c2', '?limit=1&cursor=c3'],
  );
});

test('cursor: stops when the cursor does not move', async () => {
  const { sent, client } = mockWith(() => json(200, { result: [], next: 'same' }));
  await all(client, { kind: 'cursor', cursor: 'cursor', nextCursor: ['next'], results: ['result'] });
  assert.equal(sent.length, 2);
});

test('a failed page fails the stream, after the items before it', async () => {
  const { client } = mockWith((_, i) =>
    i === 0 ? json(200, { data: things(1, 2), more: true }) : json(500, { message: 'down' }),
  );
  const transport = new EffectTransport(client, { baseUrl: 'https://api.test' });
  const seen: unknown[] = [];
  const stream = paginate<{ id: number }>(
    transport,
    operation,
    { kind: 'offset', offset: 'page', results: ['data'], hasNextPage: ['more'] },
    {},
    undefined,
  );
  const error = await Effect.runPromise(
    Effect.flip(Stream.runForEach(stream, (thing) => Effect.sync(() => seen.push(thing.id)))),
  );

  assert.deepEqual(seen, [1, 2]);
  assert.equal(error._tag, 'ApiError');
});
