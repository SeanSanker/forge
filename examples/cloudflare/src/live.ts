// Node 24 has no Temporal yet; the SDK decodes date-times to it.
import 'temporal-polyfill/global';

import { Cause, Console, Duration, Effect, Exit, Layer } from 'effect';
import { FetchHttpClient, HttpClient, type HttpClientError, type HttpClientResponse } from 'effect/http';

import { Api } from '../sdk/effect.js';
import { accountLayer } from './account.js';
import { tour } from './tour.js';

// The tour writes to the account: it makes a KV namespace and a D1
// database, and deletes them at the end. The token comes from
// CLOUDFLARE_API_TOKEN and needs Workers KV Storage Edit and D1 Edit. The
// account is CLOUDFLARE_ACCOUNT_ID, or else the token's first account.

const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;

// Prints each request as it completes, with ids left out and long cursors
// cut short, and counts them.
const logged = (accountId: () => string | undefined) =>
  HttpClient.transformResponse(
    (response: Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>) =>
      Effect.timed(response).pipe(
        Effect.tap(([took, { request, status }]) => {
          const url = new URL(request.url);
          const id = accountId();
          const path = (id === undefined ? url.pathname : url.pathname.replace(id, '…'))
            .replace(/^\/client\/v4/, '')
            .replace(/\/([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f-]{27})(?=\/|$)/g, '/…');
          const query = [...url.searchParams]
            .map(([key, value]) => `${key}=${value.length > 12 ? `${value.slice(0, 8)}…` : value}`)
            .join('&');
          requests++;
          const ms = `${Math.round(Duration.toMillis(took))}ms`;
          return Console.log(dim(`  ${request.method.padEnd(6)} ${path}${query && `?${query}`}  ${status}  ${ms}`));
        }),
        Effect.map(([, response]) => response),
      ),
  );

let accountId: string | undefined;
let requests = 0;

const HttpLive = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(
    HttpClient.HttpClient,
    logged(() => accountId),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));

const ApiLive = Api.layerConfig({ retry: true }).pipe(Layer.provide(HttpLive));

const AccountLive = accountLayer((id) => {
  accountId = id;
});

const program = Effect.timed(tour).pipe(
  Effect.flatMap(([took]) =>
    Console.log(`\n${requests} requests in ${(Duration.toMillis(took) / 1000).toFixed(1)}s, and nothing left behind`),
  ),
  Effect.catchReason('ApiError', 'Status4XX', (reason) =>
    Console.error(`Cloudflare said: ${reason.details.errors.map((e) => `${e.code} ${e.message}`).join('; ')}`),
  ),
  Effect.provide(AccountLive),
  Effect.provide(ApiLive),
  Effect.catchTag('ConfigError', () => Console.error('Set CLOUDFLARE_API_TOKEN to an API token.')),
);

// Ctrl-C interrupts the tour, which still deletes what it made.
const interrupt = new AbortController();
process.once('SIGINT', () => interrupt.abort());
Effect.runPromiseExit(program, { signal: interrupt.signal }).then((exit) => {
  if (Exit.isSuccess(exit)) {
    return;
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    console.log('\n✗ interrupted, after deleting what it made');
  } else {
    console.error(Cause.pretty(exit.cause));
  }
  process.exitCode = 1;
});
