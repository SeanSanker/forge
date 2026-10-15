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

From Cloudflare's document, that takes about a second and writes 3,117 typed
methods in 1,303 groups, one for every operation, uploads and downloads
included. The whole SDK typechecks in about two seconds.

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

Cloudflare declares most errors as one 4XX response and tells them apart by
code, so `src/cloudflare.ts` has a small helper for that. Asking the live API
for a namespace that doesn't exist gives code `10013`, "namespace not found":

```ts
api.kv.namespaces.get({ accountId, namespaceId }).pipe(
  catchCode(10013, () => Effect.succeed(undefined)), // other errors fail as they were
);
```

In tests, a fake fails the same way with `ApiError.fake({ _tag: 'Status4XX', status: 404, details })`.

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

This matters most when making several resources at once, as for a preview
environment in CI. `src/preview.ts` creates a KV namespace, a D1 database and
a queue in parallel. If one create fails, or the job is cancelled, the others
are interrupted and everything that was made is deleted. That includes a
create that was still in flight: it finishes, since it can't be taken back
once sent, and is deleted too. With `Promise.all`, such a create would finish
after the failure, and nothing would delete it. `resource` there is
`Effect.acquireRelease` of a create and a delete:

```ts
const stack =
  yield *
  Effect.all(
    {
      namespace: resource('KV namespace', api.kv.namespaces.create({ accountId, title: name }), (ns) =>
        api.kv.namespaces.delete({ accountId, namespaceId: ns.id }),
      ),
      database: resource('D1 database', api.d1.create({ accountId, name }), (db) =>
        api.d1.delete({ accountId, databaseId: db.uuid! }),
      ),
      queue: resource('queue', api.queues.create({ accountId, queueName: name }), (queue) =>
        api.queues.delete({ accountId, queueId: queue.queueId! }),
      ),
    },
    { concurrency: 'unbounded' },
  );
```

Against the live API, with one more create that Cloudflare rejects
(`pnpm preview --fail --name pr-42`):

```
 0.00s  creating pr-42: KV namespace, D1 database, queue
 0.00s  + queue "Not Valid!", which fails on purpose
 0.41s  ✗ couldn't create queue "Not Valid!"
 0.46s  ✓ created KV namespace pr-42
 0.77s  ✓ created D1 database pr-42
 1.35s  ✓ created queue pr-42
 1.67s  ✓ deleted queue pr-42
 2.26s  ✓ deleted D1 database pr-42
 2.44s  ✓ deleted KV namespace pr-42

failed: Queue name 'Not Valid!' is invalid
nothing left behind
```

### All or none, across a fleet

The same idea makes a migration of many D1 databases, such as one per
tenant, all or none. `src/migrate.ts` takes each database's time-travel
bookmark before it migrates it, as a scoped resource whose release restores
the bookmark unless the whole run succeeds:

```ts
Effect.acquireRelease(
  Effect.gen(function* () {
    const { bookmark } = yield* api.d1.timeTravel.getBookmark({ accountId, databaseId });
    yield* api.d1.query({ accountId, databaseId, sql });
    return bookmark!;
  }),
  (bookmark, exit) =>
    Exit.isSuccess(exit) ? Effect.void : api.d1.timeTravel.restore({ accountId, databaseId, bookmark }),
);
```

It streams the fleet from `api.d1.listAll`, a page at a time, migrates four
databases at once, and restores them all at once, in a parallel scope. Against the live API, with one tenant that already
has the new column (`pnpm migrate --fail --name tenant`):

```
 0.00s  making 8 tenants; tenant-06 already has the column
 1.45s  ✓ made 8 tenants
 1.45s  migrating 4 at a time: ALTER TABLE users ADD COLUMN email TEXT
 1.91s  ✓ tenant-05 migrated
 1.97s  ✓ tenant-07 migrated
 1.97s  ✓ tenant-03 migrated
 2.04s  ✗ tenant-06: duplicate column name: email
 3.17s  ↩ tenant-03 restored
 3.19s  ↩ tenant-05 restored
 3.30s  ↩ tenant-07 restored
 3.67s  1 of 8 have the column: tenant-06, which already had it
```

A restore also undoes any other write made since the bookmark, so this is
for when the tenants aren't being written to, such as a maintenance window.

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
- **Requests leave out read-only fields**, such as a Worker's `id` and
  `created_on`: 233 models have an input type for requests, such as
  `WorkersWorkerInput`, and responses keep the full model.
- **Uploads and downloads** are typed too. A multipart body's fields sit
  next to the parameters, with files as `Blob`, `File`, `Uint8Array` or a
  string, and objects sent as JSON parts; bytes come back as a `Uint8Array`,
  and text as a string.

  ```ts
  Effect.gen(function* () {
    yield* api.kv.keys.put({ accountId, namespaceId, keyName: 'greeting', value: 'héllo', metadata: { by: 'forge' } });
    const bytes = yield* api.kv.keys.get({ accountId, namespaceId, keyName: 'greeting' }); // Uint8Array

    yield* api.workers.legacy.scripts.update({
      accountId,
      scriptName,
      metadata: { mainModule: 'worker.js', compatibilityDate: '2026-10-01' },
      files: [new File([source], 'worker.js', { type: 'application/javascript+module' })],
    });
  });
  ```

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

# Makes a KV namespace, a D1 database and a queue at once, uses them, and
# deletes them. With --fail, one more create is rejected while the others
# are in flight. Needs Workers KV Storage Edit, D1 Edit and Queues Edit.
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... pnpm preview [--fail]

# Makes eight tenant D1 databases, migrates them all or none, and deletes
# them. With --fail, one tenant has drifted, so every migrated tenant is
# restored. Needs D1 Edit.
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... pnpm migrate [--fail]
```

For a throwaway account to run these in, Wrangler's `--temporary` flag makes
one that lasts an hour, with no sign-up.

## How it's made

- `scripts/generate.sh` downloads Cloudflare's document from a pinned forge
  release, checks its SHA-256, and runs forge with
  `--target effect --name @example/cloudflare-effect`. `sdk/` isn't committed.
- `scripts/paginate.ts` marks which list operations page, since the document
  pages them without saying so: a GET with a `result` array and either a
  `cursor` parameter, with the next cursor at `result_info.cursor` (KV keys,
  for one), or a `page` parameter; or a GET with a `cursor` parameter whose
  result is an object with one array and the next cursor beside it, or, for
  R2 buckets, in the envelope's `result_info`. That gives 222 `All` Streams.
  Queues and Worker scripts take no page or cursor, so their lists come in
  one response.
- `scripts/names.ts` names the 76 query parameters with `.` or `~` in their
  names, such as `account.id`, with Fern's `x-fern-parameter-name`, so the
  SDK has them as `accountId`; forge leaves out such a parameter that
  nothing names.
- `scripts/envelope.ts` replaces forge's envelope hook. Cloudflare wraps each
  payload in `{ success, errors, messages, result }`, and the document
  describes a single result without that wrapper, so the hook unwraps a result
  that isn't an array, keeping the envelope's `result_info` beside an object
  result. Lists keep their envelope, as the document describes them.
- `src/report.ts`, `src/tour.ts`, `src/preview.ts` and `src/migrate.ts` are
  the programs, and `test/` runs them against fakes made with `Api.layerTest`.

## Limits

- It's a prototype on a fork, not a published package.
- About 20 operations whose document describes a bare array still come back
  with Cloudflare's wrapper, since the envelope hook can't tell them apart.
- Most listings page by page number. Deleting items while streaming such a
  listing moves the later items onto earlier pages, so the stream skips some:
  collect the items first (`Stream.runCollect`), then delete them.
- Date-times are Effect `DateTime.Utc`s, to the millisecond, so no
  `Temporal` polyfill is needed. `JSON.stringify` writes one as its ISO
  string, but `structuredClone` copies it as a plain object, so in a Worker,
  store dates in Durable Object storage as strings (`DateTime.formatIso`).
- Query parameters with `.` or `~` in their names, such as `account.id` on
  `GET /zones`, are typed (`accountId`), as `scripts/names.ts` names them.
  The one templated name, `meta.<field>[<operator>]`, isn't; pass it in the
  call's `query` option.

[The effect target's README](../../src/bin/forge/effect/README.md) covers the
generator in full: errors, auth, retries, testing and pagination.
