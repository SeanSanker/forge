import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';

import { make } from '../src/auth.js';
import { type ClientOptions, EffectTransport, type RetryOptions } from '../src/effect.js';
import type { Operation } from '../src/index.js';
import { json, mock } from './mock.js';

const get: Operation = { method: 'GET', route: '/things', response: null };
const post: Operation = { method: 'POST', route: '/things', body: 'flat', response: null };
const fast: RetryOptions = { delay: 0 };

const send = (
  operation: Operation,
  responses: Response[],
  options: Omit<ClientOptions, 'baseUrl'>,
  headers?: Record<string, string>,
) => {
  const { sent, client } = mock(...responses);
  const transport = new EffectTransport(client, { baseUrl: 'https://api.test', ...options });
  const effect = transport.send(operation, {}, headers === undefined ? undefined : { headers });
  return { sent, run: () => Effect.runPromise(Effect.result(effect)) };
};

test('a GET is retried after a transient response, and authenticated again each time', async () => {
  let authenticated = 0;
  const auth = make({ authenticate: (request) => Effect.sync(() => (authenticated++, request)) });
  const { sent, run } = send(get, [json(503, {}), json(200, { ok: true })], { auth, retry: fast });
  const result = await run();
  assert.equal(result._tag, 'Success');
  assert.equal(sent.length, 2);
  assert.equal(authenticated, 2);
});

test('a POST is not retried, unless it has an Idempotency-Key, or gets a 429', async () => {
  const once = send(post, [json(503, {}), json(200, {})], { retry: fast });
  assert.equal((await once.run())._tag, 'Failure');
  assert.equal(once.sent.length, 1);

  // A 429 says the request wasn't processed, so it is safe to send again.
  const limited = send(post, [json(429, {}), json(200, {})], { retry: fast });
  assert.equal((await limited.run())._tag, 'Success');
  assert.equal(limited.sent.length, 2);

  const keyed = send(post, [json(503, {}), json(200, {})], { retry: fast }, { 'Idempotency-Key': 'k1' });
  assert.equal((await keyed.run())._tag, 'Success');
  assert.equal(keyed.sent.length, 2);
});

test('nothing is retried without the retry option', async () => {
  const { sent, run } = send(get, [json(503, {}), json(200, {})], {});
  assert.equal((await run())._tag, 'Failure');
  assert.equal(sent.length, 1);
});

test('retries stop after times, and the last response is the error', async () => {
  const { sent, run } = send(get, [json(503, {}), json(503, {}), json(502, { message: 'still down' })], {
    retry: { times: 2, delay: 0 },
  });
  const result = await run();
  assert.equal(sent.length, 3);
  assert.ok(result._tag === 'Failure' && result.failure._tag === 'ApiError');
  assert.equal(result.failure.status, 502);
});

test('a Retry-After is waited for, and one longer than maxRetryAfter is not retried', async () => {
  const soon = new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
  const waited = send(get, [soon, json(200, {})], { retry: fast });
  assert.equal((await waited.run())._tag, 'Success');
  assert.equal(waited.sent.length, 2);

  const later = new Response('{}', { status: 503, headers: { 'retry-after': '120' } });
  const gaveUp = send(get, [later, json(200, {})], { retry: { delay: 0, maxRetryAfter: '60 seconds' } });
  assert.equal((await gaveUp.run())._tag, 'Failure');
  assert.equal(gaveUp.sent.length, 1);
});

test('a request that gets no response is retried', async () => {
  let calls = 0;
  const client = HttpClient.make((request) =>
    ++calls === 1
      ? Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request }) }))
      : Effect.succeed(HttpClientResponse.fromWeb(request, json(200, { ok: true }))),
  );
  const transport = new EffectTransport(client, { baseUrl: 'https://api.test', retry: fast });
  assert.deepEqual(await Effect.runPromise(transport.send(get, {}, undefined)), { ok: true });
  assert.equal(calls, 2);
});

test('a Retry-After of a few minutes is waited for by default', async () => {
  const later = new Response('{}', { status: 429, headers: { 'retry-after': '120' } });
  const { sent, client } = mock(later, json(200, {}));
  const transport = new EffectTransport(client, { baseUrl: 'https://api.test', retry: fast });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.result(transport.send(get, {}, undefined)));
      yield* TestClock.adjust('2 minutes');
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  assert.equal(result._tag, 'Success');
  assert.equal(sent.length, 2);
});

test('an attempt with no response in time fails as a transport error, which a retry repeats', async () => {
  let calls = 0;
  const client = HttpClient.make((request) =>
    ++calls === 1 ? Effect.never : Effect.succeed(HttpClientResponse.fromWeb(request, json(200, { ok: true }))),
  );
  const slow = new EffectTransport(client, { baseUrl: 'https://api.test', timeout: '10 millis' });
  const result = await Effect.runPromise(Effect.result(slow.send(get, {}, undefined)));
  assert.ok(
    result._tag === 'Failure' &&
      result.failure._tag === 'HttpClientError' &&
      result.failure.reason._tag === 'TransportError',
  );
  assert.match(String(result.failure.reason.description), /no response within/);

  calls = 0;
  const retried = new EffectTransport(client, { baseUrl: 'https://api.test', timeout: '10 millis', retry: fast });
  assert.deepEqual(await Effect.runPromise(retried.send(get, {}, undefined)), { ok: true });
  assert.equal(calls, 2);
});
