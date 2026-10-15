import { Console, Context, Effect, Stream } from 'effect';

import { Api } from '../sdk/effect.js';
import { catchCode } from './cloudflare.js';

/**
 * The account the tour makes its resources in.
 */
export class Account extends Context.Service<Account, { readonly id: string }>()(
  '@example/cloudflare-effect/Account',
) {}

const name = `forge-effect-tour-${Date.now().toString(36)}`;

/**
 * A KV namespace for the tour, deleted when its scope closes: when the tour
 * ends, fails or is interrupted.
 */
const kvNamespace = Effect.gen(function* () {
  const api = yield* Api;
  const { id: accountId } = yield* Account;
  return yield* Effect.acquireRelease(api.kv.namespaces.create({ accountId, title: name }), (namespace) =>
    api.kv.namespaces
      .delete({ accountId, namespaceId: namespace.id })
      .pipe(Effect.andThen(Console.log(`✓ deleted KV namespace ${namespace.title}`)), Effect.orDie),
  );
});

/**
 * A D1 database for the tour, deleted when its scope closes.
 */
const d1Database = Effect.gen(function* () {
  const api = yield* Api;
  const { id: accountId } = yield* Account;
  return yield* Effect.acquireRelease(api.d1.create({ accountId, name }), (database) =>
    api.d1
      .delete({ accountId, databaseId: database.uuid! })
      .pipe(Effect.andThen(Console.log(`✓ deleted D1 database ${database.name}`)), Effect.orDie),
  );
});

/**
 * Writes 100 keys to a new KV namespace, streams them back ten to a page,
 * and does the same with rows of a new D1 database. Everything it makes is
 * deleted at the end.
 */
export const tour = Effect.scoped(
  Effect.gen(function* () {
    const api = yield* Api;
    const { id: accountId } = yield* Account;

    // KV: 100 keys in four writes of 25, two at a time.
    const namespace = yield* kvNamespace;
    yield* Console.log(`✓ created KV namespace ${namespace.title}`);
    const keys = Array.from({ length: 100 }, (_, i) => ({
      key: `${i % 2 === 0 ? 'cat' : 'dog'}:${String(i).padStart(3, '0')}`,
      value: JSON.stringify({ n: i }),
    }));
    yield* Effect.forEach(
      [0, 25, 50, 75],
      (from) => api.kv.bulk.put({ accountId, namespaceId: namespace.id, body: keys.slice(from, from + 25) }),
      { concurrency: 2 },
    );
    yield* Console.log('✓ wrote 100 keys');

    // Every key, streamed ten to a page as the cursor moves.
    const all = yield* api.kv.keys.listAll({ accountId, namespaceId: namespace.id, limit: 10 }).pipe(Stream.runCollect);
    yield* Console.log(`✓ streamed ${all.length} keys, ten to a page: ${all[0]?.name} … ${all.at(-1)?.name}`);

    // Only the dogs, and only the first three: one page is fetched.
    const dogs = yield* api.kv.keys
      .listAll({ accountId, namespaceId: namespace.id, prefix: 'dog:', limit: 10 })
      .pipe(Stream.take(3), Stream.runCollect);
    yield* Console.log(`✓ took the first three dogs from one page: ${dogs.map((key) => key.name).join(', ')}`);

    // A namespace that doesn't exist: Cloudflare's error code 10013.
    yield* api.kv.namespaces.get({ accountId, namespaceId: '0'.repeat(32) }).pipe(
      Effect.andThen(Console.log('? found a namespace that should not exist')),
      catchCode(10013, (error) =>
        Console.log(`✓ typed ${error.status}: ${error.details.errors.map((e) => `${e.code} ${e.message}`).join('; ')}`),
      ),
    );

    // D1: a table of 100 rows, then a query over them.
    const database = yield* d1Database;
    yield* Console.log(`✓ created D1 database ${database.name}`);
    const databaseId = database.uuid!;
    const rows = Array.from({ length: 100 }, (_, i) => i);
    yield* api.d1.query({
      accountId,
      databaseId,
      batch: [
        { sql: 'CREATE TABLE pets (id INTEGER PRIMARY KEY, kind TEXT NOT NULL)' },
        ...[0, 50].map((from) => ({
          sql: `INSERT INTO pets (id, kind) VALUES ${rows
            .slice(from, from + 50)
            .map(() => '(?, ?)')
            .join(', ')}`,
          params: rows.slice(from, from + 50).flatMap((i) => [String(i), i % 2 === 0 ? 'cat' : 'dog']),
        })),
      ],
    });
    yield* Console.log('✓ inserted 100 rows');
    const {
      result: [counted],
    } = yield* api.d1.query({
      accountId,
      databaseId,
      sql: 'SELECT kind, count(*) AS n FROM pets GROUP BY kind ORDER BY kind',
    });
    yield* Console.log(`✓ counted ${JSON.stringify(counted?.results)}`);

    // Every database of the account, streamed by page number.
    const databases = yield* api.d1.listAll({ accountId, perPage: 10 }).pipe(Stream.runCount);
    yield* Console.log(`✓ the account has ${databases} D1 database${databases === 1 ? '' : 's'}`);
  }),
);
