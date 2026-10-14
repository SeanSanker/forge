# An Effect SDK for Cloudflare's API

An unofficial experiment, not affiliated with or endorsed by Cloudflare: an
[Effect](https://effect.website) SDK for the whole Cloudflare API, generated
by this fork's `effect` target from the OpenAPI document that forge
publishes, and an app that uses it.

forge generates it in about a second: 3,600 operations in 1,300 groups, with
typed errors for each method, an `All` Stream for each of 180 paginated list
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

## How it is made

- `scripts/generate.sh` downloads Cloudflare's document from a pinned forge
  release, checks its SHA-256, and runs forge with
  `--target effect --name @example/cloudflare-effect`. `sdk/` isn't committed.
- `scripts/paginate.ts` adds `x-fern-pagination` to the list operations, which
  the document pages with `page` but doesn't describe: a GET with a `page`
  parameter and a `result` array.
- `src/report.ts` is the app, which depends on the `Api` service rather than on
  HTTP, and `test/report.test.ts` tests it with `Api.layerTest`, which fakes
  the methods it stubs.

The document's security scheme, `api_token`, gives `Security.apiToken` and
`Api.layerConfig()`, and its server gives the default base URL. See
[the effect target](../../src/bin/forge/effect/README.md) for the rest.
