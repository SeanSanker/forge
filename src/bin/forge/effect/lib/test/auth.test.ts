import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Context, Effect, Redacted } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';

import * as Auth from '../src/auth.js';
import { EffectTransport } from '../src/effect.js';
import type { Operation } from '../src/index.js';
import { json, mock, mockWith } from './mock.js';

const baseUrl = 'https://api.test';
const list: Operation = { method: 'GET', route: '/things', response: null };
const create: Operation = { method: 'POST', route: '/things', body: 'flat', response: null };
const ok = () => json(200, {});

// Sends `operation` with `auth`, as many times as `calls`, with `client`.
const call = (client: HttpClient.HttpClient, auth: Auth.Auth | undefined, calls = 1, operation = list) => {
  const transport = new EffectTransport(client, { baseUrl, ...(auth === undefined ? {} : { auth }) });
  return Effect.runPromise(
    Effect.forEach(Array.from({ length: calls }), () => transport.send(operation, { name: 'Rex' }, undefined)),
  );
};

test('no auth sends no credentials', async () => {
  const { sent, client } = mock(ok());
  await call(client, undefined);
  assert.equal(sent[0]!.headers['authorization'], undefined);
});

test('bearer, basic and API keys, which can be Redacted', async () => {
  const { sent, client } = mock(ok(), ok(), ok(), ok());
  await call(client, Auth.bearer(Redacted.make('one')));
  await call(client, Auth.basic('ada', Redacted.make('two')));
  await call(client, Auth.apiKey('three', { header: 'x-api-key' }));
  await call(client, Auth.apiKey('four', { query: 'key' }));

  assert.equal(sent[0]!.headers['authorization'], 'Bearer one');
  assert.equal(sent[1]!.headers['authorization'], `Basic ${btoa('ada:two')}`);
  assert.equal(sent[2]!.headers['x-api-key'], 'three');
  assert.equal(sent[3]!.url, `${baseUrl}/things?key=four`);
});

test('a fixed token gets no second try after a 401', async () => {
  const { sent, client } = mock(json(401, { message: 'bad token' }));
  await assert.rejects(call(client, Auth.bearer('one')), /bad token/);
  assert.equal(sent.length, 1);
});

test('cachedToken shares one fetch, and fetches again after a 401', async () => {
  let fetches = 0;
  const auth = await Effect.runPromise(
    Auth.cachedToken({ fetch: Effect.sync(() => ({ token: `t${++fetches}`, expiresIn: 3600 })) }),
  );
  // The API revokes t1 after three requests.
  const { sent, client } = mockWith((request) =>
    request.headers['authorization'] === 'Bearer t1' && sent.length > 3 ? json(401, {}) : ok(),
  );
  await call(client, auth, 4);

  assert.equal(fetches, 2);
  assert.deepEqual(
    sent.map((s) => s.headers['authorization']),
    ['Bearer t1', 'Bearer t1', 'Bearer t1', 'Bearer t1', 'Bearer t2'],
  );
});

test('cachedToken fetches once for concurrent requests', async () => {
  let fetches = 0;
  const auth = await Effect.runPromise(
    Auth.cachedToken({ fetch: Effect.sync(() => ({ token: `t${++fetches}` })).pipe(Effect.delay(5)) }),
  );
  const { client } = mockWith(ok);
  const transport = new EffectTransport(client, { baseUrl, auth });
  await Effect.runPromise(
    Effect.all(
      [1, 2, 3, 4].map(() => transport.send(list, {}, undefined)),
      { concurrency: 'unbounded' },
    ),
  );
  assert.equal(fetches, 1);
});

test('cachedToken fetches one new token for requests that get a 401 at once', async () => {
  let fetches = 0;
  const auth = await Effect.runPromise(
    Auth.cachedToken({ fetch: Effect.sync(() => ({ token: `t${++fetches}` })).pipe(Effect.delay(5)) }),
  );
  // The API has revoked t1. The first 401 comes back at once, and the
  // others once t2 has been fetched.
  const { sent, client: answer } = mockWith((request) =>
    request.headers['authorization'] === 'Bearer t1' ? json(401, {}) : ok(),
  );
  let revoked = 0;
  const client = HttpClient.make((request) =>
    answer
      .execute(request)
      .pipe(Effect.delay(request.headers['authorization'] === 'Bearer t1' && revoked++ > 0 ? 20 : 0)),
  );
  const transport = new EffectTransport(client, { baseUrl, auth });
  await Effect.runPromise(
    Effect.all(
      [1, 2, 3, 4].map(() => transport.send(list, {}, undefined)),
      { concurrency: 'unbounded' },
    ),
  );
  assert.equal(fetches, 2);
  assert.equal(sent.filter((s) => s.headers['authorization'] === 'Bearer t2').length, 4);
});

test('cachedToken can send the token as it likes', async () => {
  const auth = await Effect.runPromise(
    Auth.cachedToken({
      fetch: Effect.succeed({ token: 'abc' }),
      apply: (request, token) => HttpClientRequest.setHeader(request, 'x-session', token),
    }),
  );
  const { sent, client } = mock(ok());
  await call(client, auth);
  assert.equal(sent[0]!.headers['x-session'], 'abc');
});

test('oauth2ClientCredentials posts the grant, and keeps the token until it expires', async () => {
  const { sent, client, layer } = mockWith((request) =>
    request.url.endsWith('/oauth/token') ? json(200, { access_token: 'access', expires_in: 3600 }) : ok(),
  );
  const auth = await Effect.runPromise(
    Auth.oauth2ClientCredentials({
      tokenUrl: `${baseUrl}/oauth/token`,
      clientId: 'app',
      clientSecret: 'xyz',
      scope: 'things:read',
    }).pipe(Effect.provide(layer)),
  );
  await call(client, auth, 2);

  const [grant, ...calls] = sent;
  assert.equal(grant!.method, 'POST');
  assert.equal(grant!.headers['authorization'], `Basic ${btoa('app:xyz')}`);
  assert.equal(grant!.body, 'grant_type=client_credentials&scope=things%3Aread');
  assert.deepEqual(
    calls.map((s) => s.headers['authorization']),
    ['Bearer access', 'Bearer access'],
  );
});

test('a token that expires within the skew is fetched for each request', async () => {
  const { sent, client, layer } = mockWith((request) =>
    request.url.endsWith('/oauth/token') ? json(200, { access_token: 'brief', expires_in: 10 }) : ok(),
  );
  const auth = await Effect.runPromise(
    Auth.oauth2ClientCredentials({ tokenUrl: `${baseUrl}/oauth/token`, clientId: 'a', clientSecret: 'b' }).pipe(
      Effect.provide(layer),
    ),
  );
  await call(client, auth, 2);
  assert.equal(sent.filter((s) => s.url.endsWith('/oauth/token')).length, 2);
});

test('a failed token request is an AuthError', async () => {
  const { client, layer } = mock(json(400, { error: 'invalid_client' }));
  const auth = await Effect.runPromise(
    Auth.oauth2ClientCredentials({ tokenUrl: `${baseUrl}/oauth/token`, clientId: 'a', clientSecret: 'b' }).pipe(
      Effect.provide(layer),
    ),
  );
  const transport = new EffectTransport(client, { baseUrl, auth });
  const error = await Effect.runPromise(Effect.flip(transport.send(list, {}, undefined)));
  assert.equal(error._tag, 'AuthError');
});

test('make can sign the request it gets, body and all', async () => {
  const { sent, client } = mock(ok());
  const signing = Auth.make({
    authenticate: (request) =>
      Effect.sync(() => {
        const body = request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : '';
        return HttpClientRequest.setHeader(request, 'x-signed', `${request.method} ${request.url} ${body}`);
      }),
  });
  await call(client, signing, 1, create);
  assert.equal(sent[0]!.headers['x-signed'], `POST ${baseUrl}/things {"name":"Rex"}`);
});

test('cachedToken fetches with the services it was made with, in the context of the request', async () => {
  // A service only the Auth's maker has, and a reference both set.
  class Login extends Context.Service<Login, { readonly user: string }>()('test/Login') {}
  const Where = Context.Reference<string>('test/Where', { defaultValue: () => 'nowhere' });
  const seen: string[] = [];
  const auth = await Effect.runPromise(
    Auth.cachedToken({
      fetch: Effect.gen(function* () {
        const login = yield* Login;
        seen.push(`${login.user} at ${yield* Where}`);
        return { token: 't' };
      }),
    }).pipe(Effect.provideService(Login, { user: 'ada' }), Effect.provideService(Where, 'build')),
  );
  const { client } = mock(ok());
  const transport = new EffectTransport(client, { baseUrl, auth });
  await Effect.runPromise(transport.send(list, {}, undefined).pipe(Effect.provideService(Where, 'request')));
  assert.deepEqual(seen, ['ada at request']);
});

test('cachedToken keeps no failed fetch', async () => {
  let fetches = 0;
  const auth = await Effect.runPromise(
    Auth.cachedToken({
      fetch: Effect.suspend(() =>
        ++fetches === 1 ? Effect.fail(new Auth.AuthError({ message: 'down' })) : Effect.succeed({ token: 't' }),
      ),
    }),
  );
  const { sent, client } = mock(ok());
  const transport = new EffectTransport(client, { baseUrl, auth });
  const error = await Effect.runPromise(Effect.flip(transport.send(list, {}, undefined)));
  assert.equal(error._tag, 'AuthError');
  await Effect.runPromise(transport.send(list, {}, undefined));
  assert.equal(fetches, 2);
  assert.equal(sent[0]!.headers['authorization'], 'Bearer t');
});

test('an Auth that signs requests sees the whole URL, query and all', async () => {
  const query: Operation = { method: 'GET', route: '/things', query: { limit: 'limit' }, response: null };
  const { sent, client } = mock(ok());
  const signing = Auth.make({
    authenticate: (request) => Effect.succeed(HttpClientRequest.setHeader(request, 'x-signed', request.url)),
  });
  const transport = new EffectTransport(client, { baseUrl, auth: signing });
  await Effect.runPromise(transport.send(query, { limit: 2 }, undefined));
  assert.equal(sent[0]!.headers['x-signed'], `${baseUrl}/things?limit=2`);
  assert.equal(sent[0]!.url, `${baseUrl}/things?limit=2`);
});

test('an operation that needs no credentials is sent without them, and never refreshes them', async () => {
  let refreshed = 0;
  const auth = Auth.make({
    authenticate: (request) => Effect.succeed(HttpClientRequest.bearerToken(request, 'one')),
    refresh: () => Effect.sync(() => void refreshed++),
  });
  const { sent, client } = mock(json(401, {}));
  const transport = new EffectTransport(client, { baseUrl, auth });
  await Effect.runPromise(Effect.flip(transport.send(list, {}, undefined, { auth: false })));
  assert.equal(sent[0]!.headers['authorization'], undefined);
  assert.equal(refreshed, 0);
  assert.equal(sent.length, 1);
});
