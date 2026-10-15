import { Cause, Console, Effect, Exit, Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { Api } from '../sdk/effect.js';
import { accountLayer } from './account.js';
import { workerPreview } from './worker.js';

// Deploys a Worker preview in the account: a KV namespace and a D1 database,
// and a Worker bound to both, live on workers.dev. It calls the Worker, then
// deletes it all. With --fail, the Worker has a syntax error, so its upload
// is rejected, and the namespace and database are still deleted. The token
// comes from CLOUDFLARE_API_TOKEN and needs Workers Scripts Edit, Workers KV
// Storage Edit and D1 Edit. The account is CLOUDFLARE_ACCOUNT_ID, or else
// the token's first account.

const broken = process.argv.includes('--fail');
// --name pr-42 names the resources; a name unique to the run by default.
const named = process.argv.indexOf('--name');
const name = named === -1 ? `preview-${Date.now().toString(36)}` : process.argv[named + 1]!;

const ApiLive = Api.layerConfig({ retry: true }).pipe(Layer.provide(FetchHttpClient.layer));

const program = workerPreview(name, { broken }).pipe(
  Effect.andThen(Console.log('\nnothing left behind')),
  // Cloudflare's message, up to its details.
  Effect.catchTag('ApiError', (error) => Console.log(`\nfailed: ${error.message.split(': ')[0]}\nnothing left behind`)),
  // The Worker didn't answer within a minute, as when a network blocks
  // workers.dev.
  Effect.catchTag('Unreachable', ({ cause }) =>
    Console.log(
      `\nfailed: the Worker didn't answer: ${String((cause as Error).message ?? cause)}\nnothing left behind`,
    ),
  ),
  Effect.provide(accountLayer()),
  Effect.provide(Layer.merge(ApiLive, FetchHttpClient.layer)),
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
