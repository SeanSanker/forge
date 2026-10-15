# Cloudflare's API as an Effect SDK

A small prototype. [forge](https://github.com/cloudflare/forge) is Cloudflare's
generator that turns an OpenAPI document into a TypeScript SDK. This fork adds
an `effect` target to it, which also writes an [Effect](https://effect.website)
client. This example points it at the OpenAPI document Cloudflare publishes
for forge, and uses the result.

It's an experiment, and it isn't affiliated with or endorsed by Cloudflare.

```sh
forge openapi.json --target effect --out sdk
```

From Cloudflare's document, that takes about a second and writes 3,094 typed
methods in 1,304 groups: one for each operation with JSON bodies (forge leaves
out the others). The whole SDK typechecks in about two seconds.

## What it looks like

The SDK is an Effect service, `Api`. Your code asks for it, and a layer
provides it:

```ts
import { Effect, Layer, Stream } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Api } from './sdk/effect.js';

const program = Effect.gen(function* () {
  const api = yield* Api;
  const zone = yield* api.zones.get({ zoneId });
  // ...
});

// Reads CLOUDFLARE_API_TOKEN, the variable Cloudflare's document names.
const CloudflareLive = Api.layerConfig({ retry: true }).pipe(Layer.provide(FetchHttpClient.layer));

program.pipe(Effect.provide(CloudflareLive), Effect.runPromise);
```

### Errors

Each method fails with the error responses its operation declares, with their
bodies decoded and typed. Cloudflare declares its 4XX responses, so:

```ts
api.kv.namespaces.get({ accountId, namespaceId }).pipe(
  Effect.catchReason('ApiError', 'Status4XX', ({ details }) =>
    // details.errors: { code: number; message: string }[]
    Console.log(details.errors),
  ),
);
```

Asking the live API for a namespace that doesn't exist gives code `10013`,
"namespace not found", as a typed value rather than a thrown `unknown`.

### Pagination

Each paginated method gets an `All` twin that returns a `Stream` of every item,
and fetches pages as the stream is read. The SDK handles the cursors and page
numbers:

```ts
// Every DNS record of every active zone, four zones at a time.
api.zones
  .listAll({ status: 'active' })
  .pipe(Stream.flatMap((zone) => api.dns.records.listAll({ zoneId: zone.id }), { concurrency: 4 }));

// Three keys: one request, since the stream stops after the first page.
api.kv.keys.listAll({ accountId, namespaceId, prefix: 'dog:' }).pipe(Stream.take(3));
```

### Cleanup

Calls are Effects, so a resource can be scoped: it's deleted when the scope
closes, whether the program finishes, fails, or is interrupted with Ctrl-C.

```ts
const tour = Effect.scoped(
  Effect.gen(function* () {
    const api = yield* Api;
    const namespace = yield* Effect.acquireRelease(api.kv.namespaces.create({ accountId, title }), (ns) =>
      api.kv.namespaces.delete({ accountId, namespaceId: ns.id }).pipe(Effect.orDie),
    );
    // ... use the namespace
  }),
);
```

### Testing

App code depends on `Api`, not on `fetch`, so a test provides a fake one.
`Api.layerTest` fakes the methods you stub, and anything else fails, naming its
route (`GET /zones/{zoneId}/dns_records isn't stubbed`).

```ts
const Fake = Api.layerTest({
  zones: { listAll: () => Stream.make(zone('example.com')) },
});

program.pipe(Effect.provide(Fake));
```

### Other details

- **Retries** (`retry: true`) repeat requests that are safe to repeat (GET,
  PUT, DELETE, or a POST with an `Idempotency-Key`), and any request that
  got a 429. They wait for `Retry-After`, up to Cloudflare's 5-minute rate
  limit window, and authenticate each attempt again.
- **Each attempt times out** after 60 seconds by default (`timeout`).
- **The token** is read as a `Redacted` secret, and the `Authorization` header
  is redacted from logs and traces.
- **Each request is a span** named after its route, such as
  `GET /zones/{zoneId}/dns_records`.
- **The Promise client is still there.** The Effect client is generated next
  to it, from the same types and codecs.

## Try it

You need Node 24, pnpm, and Rust (cargo), since forge is built from this
repository.

```sh
pnpm install
pnpm generate     # downloads Cloudflare's document and writes sdk/
pnpm test         # runs the examples against a fake Cloudflare
```

Two programs talk to a real account. Keep the token in your environment,
never in a file here.

```sh
# Reads only: counts the DNS records of each of your zones by type.
# A token with Zone Read and DNS Read is enough.
CLOUDFLARE_API_TOKEN=... pnpm start

# Writes, then deletes what it wrote: 100 KV keys and 100 D1 rows, read back
# a page at a time, with each request printed. Needs Workers KV Storage Edit
# and D1 Edit.
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... pnpm tour
```

For a throwaway account to run the tour in, Wrangler's `--temporary` flag makes
one that lasts an hour, with no sign-up.

## How it's made

- `scripts/generate.sh` downloads Cloudflare's document from a pinned forge
  release, checks its SHA-256, and runs forge with
  `--target effect --name @example/cloudflare-effect`. `sdk/` isn't committed.
- `scripts/paginate.ts` marks which list operations page, since the document
  pages them without saying so: a GET with a `result` array and either a
  `cursor` parameter, with the next cursor at `result_info.cursor` (KV keys,
  for one), or a `page` parameter. That gives 214 `All` Streams.
- `scripts/envelope.ts` replaces forge's envelope hook. Cloudflare wraps each
  payload in `{ success, errors, messages, result }`, and the document
  describes a single result without that wrapper, so the hook unwraps a result
  that isn't an array. Lists keep theirs, as the document describes them.
- `src/report.ts` and `src/tour.ts` are the programs, and `test/` runs them
  against fakes made with `Api.layerTest`.

## Limits

- It's a prototype on a fork, not a published package.
- Operations without JSON bodies aren't in the SDK, as in forge's TypeScript
  target.
- About 20 operations whose document describes a bare array still come back
  with Cloudflare's wrapper, since the envelope hook can't tell them apart.

[The effect target's README](../../src/bin/forge/effect/README.md) covers the
generator in full: errors, auth, retries, testing and pagination.
