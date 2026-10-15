import { Cause, Console, Effect, Exit, Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { Api } from '../sdk/effect.js';
import { accountLayer } from './account.js';
import { preview } from './preview.js';

// Makes a preview stack in the account, uses it, and deletes it. With
// --fail, one create is rejected while the others are in flight, and
// everything that was made is still deleted. The token comes from
// CLOUDFLARE_API_TOKEN and needs Workers KV Storage Edit, D1 Edit and
// Queues Edit. The account is CLOUDFLARE_ACCOUNT_ID, or else the token's
// first account.

const failing = process.argv.includes('--fail');
// --name pr-42 names the resources; a name unique to the run by default.
const named = process.argv.indexOf('--name');
const name = named === -1 ? `preview-${Date.now().toString(36)}` : process.argv[named + 1]!;

const ApiLive = Api.layerConfig({ retry: true }).pipe(Layer.provide(FetchHttpClient.layer));

const program = preview(name, { failing }).pipe(
  Effect.andThen(Console.log('\nnothing left behind')),
  // Cloudflare's message, up to its details.
  Effect.catchTag('ApiError', (error) => Console.log(`\nfailed: ${error.message.split(': ')[0]}\nnothing left behind`)),
  Effect.provide(accountLayer()),
  Effect.provide(ApiLive),
  Effect.catchTag('ConfigError', () => Console.error('Set CLOUDFLARE_API_TOKEN to an API token.')),
);

// Ctrl-C interrupts the program, which still deletes what it made.
const interrupt = new AbortController();
process.once('SIGINT', () => interrupt.abort());
Effect.runPromiseExit(program, { signal: interrupt.signal }).then((exit) => {
  if (Exit.isSuccess(exit)) {
    return;
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    console.log('\ninterrupted, after deleting what it made');
  } else {
    console.error(Cause.pretty(exit.cause));
  }
  process.exitCode = 1;
});
