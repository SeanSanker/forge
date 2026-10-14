import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Cause, Effect, Exit, Schedule } from 'effect';
import { Headers as HttpHeaders, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';

import { apiKey, make } from '../src/auth.js';
import { int64, object } from '../src/codec.js';
import { type ClientError, type ClientOptions, EffectTransport } from '../src/effect.js';
import type { Operation } from '../src/index.js';
import { json, mock } from './mock.js';

const base: ClientOptions = { baseUrl: 'https://api.test/v1/' };

const getThing: Operation = {
  method: 'GET',
  route: '/things/{id}',
  query: { verbose: 'verbose', tags: 'tag' },
  joined: ['tags'],
  response: object([
    ['id', null, int64],
    ['display_name', 'displayName'],
  ]),
  errors: { '404': true },
};

const createThing: Operation = { method: 'POST', route: '/things', body: 'flat', response: null };

const send = <T>(
  operation: Operation,
  request: object | undefined,
  responses: Response[],
  options: ClientOptions = base,
) => {
  const { sent, client } = mock(...responses);
  const transport = new EffectTransport(client, options);
  return { sent, effect: transport.send<T>(operation, request, undefined) };
};

test('send builds the URL, and decodes the response with its codec', async () => {
  const { sent, effect } = send(getThing, { id: 'a/b', verbose: true, tags: ['x', 'y'] }, [
    new Response('{"id": 9007199254740993, "display_name": "Rex"}', { status: 200 }),
  ]);
  const thing = await Effect.runPromise(effect);

  assert.deepEqual(thing, { id: 9007199254740993n, displayName: 'Rex' });
  assert.equal(sent[0]!.method, 'GET');
  assert.equal(sent[0]!.url, 'https://api.test/v1/things/a%2Fb?verbose=true&tag=x%2Cy');
  assert.equal(sent[0]!.headers['accept'], 'application/json');
});

test('send puts the fields that are not parameters in a flat body', async () => {
  const { sent, effect } = send(createThing, { name: 'Tom' }, [json(201, { ok: true })]);
  assert.deepEqual(await Effect.runPromise(effect), { ok: true });
  assert.equal(sent[0]!.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(sent[0]!.body!), { name: 'Tom' });
});

test('client and call options add headers and query parameters', async () => {
  const { sent, client } = mock(json(200, {}));
  const transport = new EffectTransport(client, {
    ...base,
    headers: { 'x-client': '1', 'x-both': 'client' },
    query: new URLSearchParams({ from: 'client' }),
  });
  await Effect.runPromise(
    transport.send(createThing, {}, { headers: { 'x-both': 'call' }, query: new URLSearchParams({ from: 'call' }) }),
  );
  assert.equal(sent[0]!.url, 'https://api.test/v1/things?from=client&from=call');
  assert.equal(sent[0]!.headers['x-client'], '1');
  assert.equal(sent[0]!.headers['x-both'], 'call');
});

test('an error response is an ApiError, with the declared body as details', async () => {
  const { effect } = send(getThing, { id: '1' }, [json(404, { message: 'no such thing' })]);
  const error = await Effect.runPromise(Effect.flip(effect));

  assert.equal(error._tag, 'ApiError');
  if (error._tag === 'ApiError') {
    assert.equal(error.status, 404);
    assert.equal(error.message, 'no such thing');
    assert.deepEqual(error.details, { message: 'no such thing' });
  }
});

test('an undeclared error keeps its body as text', async () => {
  const { effect } = send(getThing, { id: '1' }, [new Response('down', { status: 503 })]);
  const error = await Effect.runPromise(Effect.flip(effect));
  assert.ok(error._tag === 'ApiError');
  assert.equal(error.message, '503');
  assert.equal(error.details, 'down');
});

test('a success response that is not JSON is an ApiError', async () => {
  const { effect } = send(getThing, { id: '1' }, [new Response('{', { status: 200 })]);
  const error = await Effect.runPromise(Effect.flip(effect));
  assert.ok(error._tag === 'ApiError');
  assert.equal(error.message, 'the response body is not valid JSON');
});

test('a missing path parameter is a defect', async () => {
  const { sent, effect } = send(getThing, { id: '' }, []);
  const exit = await Effect.runPromiseExit(effect);
  assert.ok(Exit.isFailure(exit));
  assert.ok(Cause.hasDies(exit.cause));
  assert.match(String(exit.cause), /id is required/);
  assert.equal(sent.length, 0);
});

test('a baseUrl is required', () => {
  const { client } = mock();
  assert.throws(() => new EffectTransport(client, { baseUrl: '' }), /baseUrl is required/);
});

test('after a 401, an Auth that can refresh does, and the request is sent once more', async () => {
  let refreshed = 0;
  let current = 'one';
  const auth = make({
    authenticate: (request) => Effect.sync(() => HttpClientRequest.setHeader(request, 'x-key', current)),
    refresh: Effect.sync(() => {
      refreshed++;
      current = 'two';
    }),
  });
  const { sent, effect } = send(createThing, {}, [json(401, {}), json(200, { ok: true })], { ...base, auth });

  assert.deepEqual(await Effect.runPromise(effect), { ok: true });
  assert.equal(refreshed, 1);
  assert.deepEqual(
    sent.map((s) => s.headers['x-key']),
    ['one', 'two'],
  );
});

test('a second 401 after a refresh is an ApiError, with no third try', async () => {
  const auth = make({ authenticate: Effect.succeed, refresh: Effect.void });
  const { sent, effect } = send(createThing, {}, [json(401, {}), json(401, { message: 'still no' })], {
    ...base,
    auth,
  });
  const error = await Effect.runPromise(Effect.flip(effect));
  assert.ok(error._tag === 'ApiError');
  assert.equal(error.status, 401);
  assert.equal(sent.length, 2);
});

test("the HttpClient's middleware applies, such as retries", async () => {
  const { sent, client } = mock(json(503, {}), json(200, { ok: true }));
  const retrying = HttpClient.retryTransient(client, { schedule: Schedule.spaced(1), times: 2 });
  const transport = new EffectTransport(retrying, base);
  const result: Effect.Effect<{ ok: boolean }, ClientError> = transport.send(createThing, {}, undefined);
  assert.deepEqual(await Effect.runPromise(result), { ok: true });
  assert.equal(sent.length, 2);
});

test('a content type in the headers wins over the operation', async () => {
  const { sent, client } = mock(json(200, {}));
  const transport = new EffectTransport(client, base);
  await Effect.runPromise(
    transport.send(createThing, { name: 'Tom' }, { headers: { 'content-type': 'application/merge-patch+json' } }),
  );
  assert.equal(sent[0]!.headers['content-type'], 'application/merge-patch+json');
});

test("the HttpClient's span is named after the operation, and an Auth's headers are redacted", async () => {
  const seen: { span: string; redacted: readonly (string | RegExp)[] }[] = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const name = yield* HttpClient.SpanNameGenerator;
      const redacted = yield* HttpHeaders.CurrentRedactedNames;
      seen.push({ span: name(request), redacted });
      return HttpClientResponse.fromWeb(request, json(200, {}));
    }),
  );
  const transport = new EffectTransport(client, { ...base, auth: apiKey('k', { header: 'x-things-key' }) });
  await Effect.runPromise(transport.send(getThing, { id: '1' }, undefined));

  assert.equal(seen[0]!.span, 'GET /things/{id}');
  assert.ok(seen[0]!.redacted.includes('x-things-key'));
  assert.ok(seen[0]!.redacted.includes('authorization'));
});
