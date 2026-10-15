// Node 24 has no Temporal yet; the SDK decodes date-times to it.
import 'temporal-polyfill/global';

import { Cause, Console, Effect, Exit, Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { Api } from '../sdk/effect.js';
import { accountLayer } from './account.js';
import { migrateFleet } from './migrate.js';
import { timeline } from './timeline.js';
import { Account } from './tour.js';

// Makes a fleet of eight tenant D1 databases, migrates them all or none,
// checks their schemas, and deletes the fleet. With --fail, one tenant
// has drifted, so its migration fails and every migrated tenant is
// restored. The token comes from CLOUDFLARE_API_TOKEN and needs D1 Edit.
// The account is CLOUDFLARE_ACCOUNT_ID, or else the token's first account.

const drifted = process.argv.includes('--fail');
const prefix = `tenant-${Date.now().toString(36)}`;
const migration = 'ALTER TABLE users ADD COLUMN email TEXT';

const demo = Effect.scoped(
  Effect.gen(function* () {
    const api = yield* Api;
    const { id: accountId } = yield* Account;
    const log = yield* timeline;

    // The fleet, deleted when the demo ends, however it ends.
    const names = Array.from({ length: 8 }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`);
    yield* log(`making 8 tenant databases${drifted ? `; ${names[5]} already has an email column` : ''}`);
    const fleet = yield* Effect.forEach(
      names,
      (name, i) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            const db = yield* api.d1.create({ accountId, name });
            const columns =
              drifted && i === 5
                ? 'id INTEGER PRIMARY KEY, name TEXT, email TEXT'
                : 'id INTEGER PRIMARY KEY, name TEXT';
            yield* api.d1.query({
              accountId,
              databaseId: db.uuid!,
              batch: [{ sql: `CREATE TABLE users (${columns})` }, { sql: "INSERT INTO users (name) VALUES ('ada')" }],
            });
            return db;
          }),
          (db) => api.d1.delete({ accountId, databaseId: db.uuid! }).pipe(Effect.retry({ times: 3 }), Effect.orDie),
        ),
      { concurrency: 'unbounded' },
    );
    yield* log('✓ made 8 tenant databases');

    // Every tenant, found a page at a time, migrated all or none.
    const result = yield* Effect.result(
      migrateFleet(api.d1.listAll({ accountId, name: prefix, perPage: 5 }), migration, { concurrency: 4, log }),
    );

    // Which tenants have the new column now.
    const withEmail = yield* Effect.forEach(
      fleet,
      (db) =>
        Effect.map(
          api.d1.query({
            accountId,
            databaseId: db.uuid!,
            sql: "SELECT count(*) AS n FROM pragma_table_info('users') WHERE name = 'email'",
          }),
          ({ result: [first] }) => (first?.results?.[0] as { n?: number } | undefined)?.n === 1,
        ),
      { concurrency: 4 },
    );
    const count = withEmail.filter(Boolean).length;
    yield* log(
      result._tag === 'Success'
        ? `${count} of 8 tenants have users.email`
        : `${count} of 8 tenants have users.email: only the one that already had it`,
    );
  }),
);

const ApiLive = Api.layerConfig({ retry: true }).pipe(Layer.provide(FetchHttpClient.layer));

const program = demo.pipe(
  Effect.andThen(Console.log('\nthe fleet was deleted')),
  Effect.provide(accountLayer()),
  Effect.provide(ApiLive),
  Effect.catchTag('ConfigError', () => Console.error('Set CLOUDFLARE_API_TOKEN to an API token.')),
);

// Ctrl-C interrupts the program, which restores what it migrated and
// deletes the fleet.
const interrupt = new AbortController();
process.once('SIGINT', () => interrupt.abort());
Effect.runPromiseExit(program, { signal: interrupt.signal }).then((exit) => {
  if (Exit.isSuccess(exit)) {
    return;
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    console.log('\ninterrupted, after restoring what it migrated and deleting the fleet');
  } else {
    console.error(Cause.pretty(exit.cause));
  }
  process.exitCode = 1;
});
