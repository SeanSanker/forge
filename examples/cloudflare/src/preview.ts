import { Effect } from 'effect';

import { Api } from '../sdk/effect.js';
import { timeline } from './timeline.js';
import { Account } from './tour.js';

/**
 * Makes a preview stack, a KV namespace, a D1 database and a queue named
 * `name`, all at once, and deletes them when the scope closes: when the
 * program ends, fails, or is interrupted.
 *
 * If one create fails, the others are interrupted, and the scope deletes
 * what was made, in reverse order. That includes a create that was still
 * in flight when another failed: it finishes, since a create can't be
 * taken back once sent, and is deleted too.
 *
 * With `failing`, one more create is sent that Cloudflare rejects, to show
 * that.
 */
export const previewStack = (name: string, options: { readonly failing?: boolean } = {}) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const { id: accountId } = yield* Account;
    const log = yield* timeline;

    const resource = <A, E, E2>(
      label: string,
      create: Effect.Effect<A, E>,
      remove: (a: A) => Effect.Effect<unknown, E2>,
    ) =>
      Effect.acquireRelease(
        create.pipe(
          Effect.tap(() => log(`✓ created ${label}`)),
          Effect.tapError(() => log(`✗ couldn't create ${label}`)),
        ),
        (a) => remove(a).pipe(Effect.retry({ times: 3 }), Effect.andThen(log(`✓ deleted ${label}`)), Effect.orDie),
      );

    yield* log(`creating ${name}: KV namespace, D1 database, queue`);
    if (options.failing) {
      yield* log('+ queue "Not Valid!", which fails on purpose');
    }
    const stack = yield* Effect.all(
      {
        namespace: resource(`KV namespace ${name}`, api.kv.namespaces.create({ accountId, title: name }), (ns) =>
          api.kv.namespaces.delete({ accountId, namespaceId: ns.id }),
        ),
        database: resource(`D1 database ${name}`, api.d1.create({ accountId, name }), (db) =>
          api.d1.delete({ accountId, databaseId: db.uuid! }),
        ),
        queue: resource(`queue ${name}`, api.queues.create({ accountId, queueName: name }), (queue) =>
          api.queues.delete({ accountId, queueId: queue.queueId! }),
        ),
        // A name Cloudflare rejects, so this create fails while the others
        // are still in flight.
        rejected: options.failing
          ? resource('queue "Not Valid!"', api.queues.create({ accountId, queueName: 'Not Valid!' }), (queue) =>
              api.queues.delete({ accountId, queueId: queue.queueId! }),
            )
          : Effect.void,
      },
      { concurrency: 'unbounded' },
    );
    yield* log('stack ready');
    return { ...stack, log };
  });

/**
 * Uses each resource of the stack once, as a preview's tests would.
 */
export const useStack = (stack: Effect.Success<ReturnType<typeof previewStack>>) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const { id: accountId } = yield* Account;
    const databaseId = stack.database.uuid!;
    yield* Effect.all(
      [
        api.kv.bulk.put({ accountId, namespaceId: stack.namespace.id, body: [{ key: 'hello', value: 'world' }] }),
        api.d1.query({ accountId, databaseId, sql: 'SELECT 1 AS ok' }),
        api.queues.messages.push({
          accountId,
          queueId: stack.queue.queueId!,
          body: { hello: 'world' },
          contentType: 'json',
        }),
      ],
      { concurrency: 'unbounded' },
    );
    yield* stack.log('✓ wrote a key, ran a query and sent a message');
  });

/**
 * Makes a preview stack, uses it, and deletes it.
 */
export const preview = (name: string, options: { readonly failing?: boolean } = {}) =>
  Effect.scoped(Effect.flatMap(previewStack(name, options), useStack));
