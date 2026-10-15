import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Effect, Exit, Layer, Stream } from 'effect';

import { Api, ApiError } from '../sdk/effect.js';
import { migrateFleet } from '../src/migrate.js';
import { Account } from '../src/tour.js';

// A fake Cloudflare with a fleet of databases, each with a version that a
// migration bumps and a restore puts back. Database "bad" fails to migrate,
// and "slow" takes a while.
function fleet(names: string[]) {
  const version = new Map(names.map((name) => [name, 0]));
  const restored: string[] = [];
  const layer = Api.layerTest({
    d1: {
      timeTravel: {
        getBookmark: ({ databaseId }) => Effect.succeed({ bookmark: `${databaseId}@${version.get(databaseId)}` }),
        restore: ({ databaseId, bookmark }) =>
          Effect.sync(() => {
            version.set(databaseId, Number(bookmark!.split('@')[1]));
            restored.push(databaseId);
            return {};
          }),
      },
      query: ({ databaseId }) =>
        databaseId === 'bad'
          ? Effect.fail(
              ApiError.fake({
                _tag: 'Status4XX',
                status: 400,
                details: {
                  errors: [{ code: 7500, message: 'duplicate column name: email' }],
                  messages: [],
                  result: null,
                  success: false,
                },
              }),
            )
          : Effect.sync(() => (version.set(databaseId, version.get(databaseId)! + 1), { result: [] })).pipe(
              Effect.delay(databaseId === 'slow' ? '30 millis' : '0 millis'),
            ),
    },
  });
  const quiet = { log: () => Effect.void };
  return {
    version,
    restored,
    run: (concurrency: number) =>
      migrateFleet(
        Stream.fromIterable(names.map((name) => ({ uuid: name, name }))),
        'ALTER TABLE users ADD COLUMN email TEXT',
        { concurrency, ...quiet },
      ).pipe(Effect.provide(Layer.merge(layer, Layer.succeed(Account, Account.of({ id: 'acc' }))))),
  };
}

test('every database is migrated when all succeed', async () => {
  const f = fleet(['a', 'b', 'c']);
  assert.equal(await Effect.runPromise(f.run(2)), 3);
  assert.deepEqual([...f.version.values()], [1, 1, 1]);
  assert.deepEqual(f.restored, []);
});

test('one failure restores every database migrated, including one still in flight', async () => {
  const f = fleet(['a', 'slow', 'bad', 'b']);
  const exit = await Effect.runPromiseExit(f.run(4));
  assert.ok(Exit.isFailure(exit));
  // "slow" was still migrating when "bad" failed: it finished, then was restored.
  assert.ok(f.restored.includes('slow'));
  assert.deepEqual([...f.version.values()], [0, 0, 0, 0]);
});
