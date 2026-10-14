# An Effect SDK for Cloudflare's API

An unofficial experiment, not affiliated with or endorsed by Cloudflare: an
[Effect](https://effect.website) SDK for the whole Cloudflare API, generated
by this fork's `effect` target from the OpenAPI document that forge
publishes, and an app that uses it.

forge generates it in about a second: 3,600 operations in 1,300 groups, with
typed errors for each method, an `All` Stream for each of 214 paginated list
methods, and credentials from `CLOUDFLARE_API_TOKEN`.

```ts
const CloudflareLive = Api.layerConfig({ retry: true }).pipe(Layer.provide(FetchHttpClient.layer));

const report = Effect.gen(function* () {
  const api = yield* Api;
  // Every active zone, then every DNS record of each, a page at a time.
  return yield* api.zones.listAll({ status: 'active' }).pipe(
    Stream.mapEffect((zone) => api.dns.records.listAll({ zoneId: zone.id }).pipe(Stream.runCount), {
      concurrency: 4,
    }),
    Stream.runCollect,
  );
}).pipe(
  // Cloudflare declares its 4XX responses, so their details are typed.
  Effect.catchReason('ApiError', 'Status4XX', (reason) => Console.error(reason.details.errors)),
  Effect.provide(CloudflareLive),
);
```

## Running it

It needs Node 24, pnpm and Rust (cargo), to build forge from this repository.

```sh
pnpm install
pnpm generate                      # writes sdk/ from Cloudflare's document
pnpm test                          # the report, against a fake Cloudflare
CLOUDFLARE_API_TOKEN=... pnpm start   # the report, against your account
```

`pnpm start` counts the DNS records of each of your active zones by type. It
only reads: a token with Zone Read and DNS Read is enough. Keep the token in
your environment, never in a file here.

### The tour

```sh
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... pnpm tour
```

`pnpm tour` writes to the account, and deletes what it writes. It makes a KV
namespace, writes 100 keys to it, streams them back ten to a page, takes three
from a prefix, and gets a namespace that doesn't exist, for a typed 404. Then
it makes a D1 database, inserts 100 rows, counts them, and pages through the
account's databases. It prints each request as it goes, with ids left out.

The namespace and the database are scoped resources (`Effect.acquireRelease`),
so they are deleted when the tour ends, fails, or is interrupted with Ctrl-C.
It needs a token with Workers KV Storage Edit and D1 Edit. `src/tour.ts` is
the tour, and `test/tour.test.ts` runs it against a fake Cloudflare.

Wrangler's `--temporary` flag can make a throwaway account to run it in, which
expires after an hour unless claimed.

## How it is made

- `scripts/generate.sh` downloads Cloudflare's document from a pinned forge
  release, checks its SHA-256, and runs forge with
  `--target effect --name @example/cloudflare-effect`. `sdk/` isn't committed.
- `scripts/paginate.ts` adds `x-fern-pagination` to the list operations, which
  the document pages but doesn't describe: a GET with a `result` array and
  either a `cursor` parameter, with the next cursor at `result_info.cursor`
  (such as KV keys), or a `page` parameter.
- `scripts/envelope.ts` is put in place of forge's envelope hook. Cloudflare
  wraps each payload in `{ success, errors, messages, result }`, and the
  document describes a single result without it, so the hook unwraps a
  result that isn't an array. A list keeps its envelope, as the document
  describes it, which leaves about 20 operations whose document gives a bare
  array with their envelope.
- `src/report.ts` is the app, which depends on the `Api` service rather than on
  HTTP, and `test/report.test.ts` tests it with `Api.layerTest`, which fakes
  the methods it stubs.

The document's security scheme, `api_token`, gives `Security.apiToken` and
`Api.layerConfig()`, and its server gives the default base URL. See
[the effect target](../../src/bin/forge/effect/README.md) for the rest.
