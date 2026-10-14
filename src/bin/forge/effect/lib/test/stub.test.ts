import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Cause, Effect, Exit, Stream } from 'effect';

import { type ClientError, EffectTransport, stub } from '../src/effect.js';
import type { Operation } from '../src/index.js';
import { type Pagination, paginate } from '../src/paginate.js';

// A client as the generator makes one: a method, a paginated twin, and a
// group, made the first time it is read.
interface Things {
  get(request: { id: string }): Effect.Effect<{ id: string }, ClientError>;
  listAll(request?: object): Stream.Stream<{ id: string }, ClientError>;
  readonly parts: { count(request?: object): Effect.Effect<number, ClientError> };
}
const getThing: Operation = { method: 'GET', route: '/things/{id}', response: null };
const listThings: Operation = { method: 'GET', route: '/things', response: null };
const countParts: Operation = { method: 'GET', route: '/parts/count', response: null };
const pages: Pagination = { kind: 'cursor', cursor: 'cursor', nextCursor: ['next'], results: ['data'] };
function bind(transport: EffectTransport): Things {
  let parts: Things['parts'] | undefined;
  return {
    get: (request) => transport.send(getThing, request, undefined),
    listAll: (request) => paginate(transport, listThings, pages, request, undefined),
    get parts() {
      return (parts ??= { count: (request) => transport.send(countParts, request, undefined) });
    },
  };
}

const died = async (effect: Effect.Effect<unknown, unknown>) => {
  const exit = await Effect.runPromiseExit(effect);
  assert.ok(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
  return String(exit.cause);
};

test('stubbed methods answer, in groups too', async () => {
  const things = stub(bind, {
    get: ({ id }) => Effect.succeed({ id }),
    parts: { count: () => Effect.succeed(3) },
  });
  assert.deepEqual(await Effect.runPromise(things.get({ id: 'a' })), { id: 'a' });
  assert.equal(await Effect.runPromise(things.parts.count()), 3);
});

test('a method or Stream that is not stubbed dies, naming its operation', async () => {
  const things = stub(bind, { get: ({ id }) => Effect.succeed({ id }) });
  assert.match(await died(things.parts.count()), /GET \/parts\/count isn't stubbed/);
  assert.match(await died(Stream.runCollect(things.listAll())), /GET \/things isn't stubbed/);
});
