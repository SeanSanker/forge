import { Effect, Exit, Scope, Stream } from 'effect';

import { Api } from '../sdk/effect.js';
import { timeline } from './timeline.js';
import { Account } from './tour.js';

/**
 * A database of the fleet.
 */
export interface Tenant {
  readonly uuid?: string;
  readonly name?: string;
}

/**
 * Runs `sql` on every database `tenants` streams, `concurrency` at a time,
 * all or none: before it migrates a database it takes the database's D1
 * time-travel bookmark, and if any migration fails, or the run is
 * interrupted, every database already migrated is restored to its
 * bookmark, all at once. Migrations still in flight finish first, and are
 * restored too.
 *
 * A restore also undoes any other write made since the bookmark, so run it
 * when the tenants aren't being written to.
 */
export const migrateFleet = <E, R>(
  tenants: Stream.Stream<Tenant, E, R>,
  sql: string,
  options: {
    readonly concurrency?: number;
    /** Prints each step. A timeline of the run by default. */
    readonly log?: (text: string) => Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const { id: accountId } = yield* Account;
    const log = options.log ?? (yield* timeline);

    // The restores, which run at once when the run ends, unless it
    // succeeded.
    const restores = yield* Scope.make('parallel');

    // A migrated database, restored when the run's scope closes, unless
    // the whole run succeeded.
    const migrate = (tenant: Tenant) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const databaseId = tenant.uuid!;
          const { bookmark } = yield* api.d1.timeTravel.getBookmark({ accountId, databaseId });
          yield* api.d1
            .query({ accountId, databaseId, sql })
            .pipe(
              Effect.tapError((error) =>
                log(
                  `✗ ${tenant.name}: ${error._tag === 'ApiError' ? error.message.replace(/: SQLITE_\w+$/, '') : error._tag}`,
                ),
              ),
            );
          yield* log(`✓ ${tenant.name} migrated`);
          return { databaseId, bookmark: bookmark! };
        }),
        ({ databaseId, bookmark }, exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : api.d1.timeTravel
                .restore({ accountId, databaseId, bookmark })
                .pipe(Effect.retry({ times: 3 }), Effect.andThen(log(`↩ ${tenant.name} restored`)), Effect.orDie),
      );

    yield* log(`migrating ${options.concurrency ?? 4} at a time: ${sql}`);
    const migrated = yield* tenants.pipe(
      Stream.mapEffect((tenant) => Scope.provide(migrate(tenant), restores), {
        concurrency: options.concurrency ?? 4,
      }),
      Stream.runCount,
      Effect.onExit((exit) => Scope.close(restores, exit)),
    );
    yield* log(`✓ all ${migrated} migrated`);
    return migrated;
  });
