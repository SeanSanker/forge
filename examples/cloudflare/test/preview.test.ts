import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Console, Effect, Exit, Layer } from 'effect';

import type { CreateResponse as D1Database } from '../sdk/d1/index.js';
import { Api, ApiError } from '../sdk/effect.js';
import type { WorkersKvNamespace } from '../sdk/kv/namespaces/index.js';
import type { CreateResponse as Queue } from '../sdk/queues/index.js';
import { preview } from '../src/preview.js';
import { Account } from '../src/tour.js';

// A fake Cloudflare that keeps what exists, where a D1 database takes a
// while to create, and a queue name with "!" is rejected at once.
function fake() {
  const live = new Set<string>();
  const created: string[] = [];
  const used: string[] = [];
  const layer = Api.layerTest({
    kv: {
      namespaces: {
        create: ({ title }) =>
          Effect.sync(() => (live.add('kv'), created.push('kv'), { id: 'kv', title } as WorkersKvNamespace)),
        delete: () => Effect.sync(() => (live.delete('kv'), null)),
      },
      bulk: { put: () => Effect.sync(() => (used.push('kv'), {})) },
    },
    d1: {
      create: ({ name }) =>
        Effect.sync(() => (live.add('d1'), created.push('d1'), { uuid: 'd1', name } as D1Database)).pipe(
          Effect.delay('30 millis'),
        ),
      delete: () => Effect.sync(() => (live.delete('d1'), null)),
      query: () => Effect.sync(() => (used.push('d1'), { result: [] })),
    },
    queues: {
      create: ({ queueName }) =>
        queueName.includes('!')
          ? Effect.fail(
              ApiError.fake({
                _tag: 'Status4XX',
                status: 400,
                details: {
                  errors: [{ code: 11001, message: 'invalid queue name' }],
                  messages: [],
                  result: null,
                  success: false,
                },
              }),
            )
          : Effect.sync(() => (live.add('queue'), created.push('queue'), { queueId: 'queue', queueName } as Queue)),
      delete: () => Effect.sync(() => (live.delete('queue'), { success: true, errors: [], messages: [] })),
      messages: { push: () => Effect.sync(() => (used.push('queue'), {})) },
    },
  });
  return { live, created, used, layer: Layer.mergeAll(layer, Layer.succeed(Account, Account.of({ id: 'acc' }))) };
}

test('the stack is made at once, used, and deleted', async () => {
  const cf = fake();
  await Effect.runPromise(
    preview('pr-1').pipe(Effect.provide(cf.layer), Effect.provideService(Console.Console, quietConsole())),
  );
  assert.deepEqual(cf.used.sort(), ['d1', 'kv', 'queue']);
  assert.equal(cf.live.size, 0);
});

test('when one create fails, a create still in flight finishes, and is deleted too', async () => {
  const cf = fake();
  const exit = await Effect.runPromiseExit(
    preview('pr-2', { failing: true }).pipe(
      Effect.provide(cf.layer),
      Effect.provideService(Console.Console, quietConsole()),
    ),
  );
  assert.ok(Exit.isFailure(exit));
  assert.deepEqual(cf.used, []);
  // The D1 database was still being created when the queue was rejected:
  // it was made all the same, then deleted.
  assert.deepEqual(cf.created.sort(), ['d1', 'kv', 'queue']);
  assert.equal(cf.live.size, 0);
});

// A Console that doesn't print the stack's log.
function quietConsole(): Console.Console {
  return { ...globalThis.console, log: () => {} } as unknown as Console.Console;
}
