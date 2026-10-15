import { Console, Effect, Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { Api } from '../sdk/effect.js';
import { dnsReport } from './report.js';

// The API token comes from CLOUDFLARE_API_TOKEN, as Cloudflare's document
// names it. One with Zone Read and DNS Read is enough. Requests that are
// safe to repeat are retried.
const CloudflareLive = Api.layerConfig({ retry: true }).pipe(Layer.provide(FetchHttpClient.layer));

const program = dnsReport.pipe(
  Effect.flatMap((zones) =>
    Effect.forEach(zones, ({ zone, records }) => {
      const counts = Object.entries(records).map(([type, count]) => `${count} ${type}`);
      return Console.log(`${zone}: ${counts.join(', ') || 'no records'}`);
    }),
  ),
  // Cloudflare declares its 4XX responses, so their errors are typed.
  Effect.catchReason('ApiError', 'Status4XX', (reason) =>
    Console.error(`Cloudflare said: ${reason.details.errors.map((e) => e.message).join('; ')}`),
  ),
  Effect.provide(CloudflareLive),
  Effect.catchTag('ConfigError', () => Console.error('Set CLOUDFLARE_API_TOKEN to an API token.')),
);

Effect.runPromise(program);
