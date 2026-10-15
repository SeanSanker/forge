import { Data, Effect, Schedule, Schema } from 'effect';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';

import { Api } from '../sdk/effect.js';
import { hasCode } from './cloudflare.js';
import { timeline } from './timeline.js';
import { Account } from './tour.js';

/**
 * The Worker a preview deploys: it reads a greeting from KV, counts its
 * visits in D1, and answers with both as JSON. `/health` answers without
 * either, to see that it's up.
 */
export const source = `export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/health') {
      return new Response('ok');
    }
    const greeting = await env.KV.get('greeting');
    await env.DB.prepare('INSERT INTO visits DEFAULT VALUES').run();
    const { n } = await env.DB.prepare('SELECT count(*) AS n FROM visits').first();
    return Response.json({ greeting, visits: n });
  },
};
`;

/**
 * What the Worker answers, decoded from its JSON.
 */
export const Answer = Schema.Struct({ greeting: Schema.String, visits: Schema.Number });
export type Answer = typeof Answer.Type;

/**
 * The preview didn't answer, or answered with something else, within a
 * minute of being deployed.
 */
export class Unreachable extends Data.TaggedError('Unreachable')<{ readonly url: string; readonly cause: unknown }> {}

/**
 * Deploys a Worker preview named `name`: a KV namespace and a D1 database,
 * made at once and seeded, and a Worker bound to both, live on its
 * workers.dev URL. Each is deleted when the scope closes, the Worker first:
 * when the program ends, fails, or is interrupted.
 *
 * With `broken`, the Worker's source has a syntax error, so Cloudflare
 * rejects the upload, and the namespace and database are deleted.
 */
export const deployPreview = (name: string, options: { readonly broken?: boolean } = {}) =>
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

    yield* log(`deploying ${name}: KV namespace, D1 database, Worker`);
    const { namespace, database } = yield* Effect.all(
      {
        namespace: resource(`KV namespace ${name}`, api.kv.namespaces.create({ accountId, title: name }), (ns) =>
          api.kv.namespaces.delete({ accountId, namespaceId: ns.id }),
        ),
        database: resource(`D1 database ${name}`, api.d1.create({ accountId, name }), (db) =>
          api.d1.delete({ accountId, databaseId: db.uuid! }),
        ),
      },
      { concurrency: 'unbounded' },
    );
    const databaseId = database.uuid!;

    // KV takes the value as multipart, with its metadata as a JSON part. A
    // namespace made a moment ago can still be unknown to KV (10013) for a
    // moment, so that is retried.
    yield* Effect.all(
      [
        api.kv.keys
          .put({
            accountId,
            namespaceId: namespace.id,
            keyName: 'greeting',
            value: `hello from ${name}`,
            metadata: { seededBy: 'forge-effect' },
          })
          .pipe(
            Effect.retry({
              while: (error) => hasCode(error, 10013),
              schedule: Schedule.spaced('500 millis'),
              times: 6,
            }),
          ),
        api.d1.query({ accountId, databaseId, sql: 'CREATE TABLE visits (id INTEGER PRIMARY KEY)' }),
      ],
      { concurrency: 'unbounded' },
    );
    yield* log('✓ seeded KV and D1');

    // The Worker, a module uploaded as multipart, with both bound to it.
    if (options.broken) {
      yield* log('+ the Worker has a syntax error, on purpose');
    }
    const code = options.broken ? source.replace('async fetch', 'async fetch(') : source;
    yield* resource(
      `Worker ${name}`,
      api.workers.legacy.scripts.update({
        accountId,
        scriptName: name,
        metadata: {
          mainModule: 'worker.js',
          compatibilityDate: '2026-10-01',
          bindings: [
            { type: 'kv_namespace', name: 'KV', namespaceId: namespace.id },
            { type: 'd1', name: 'DB', id: databaseId, databaseId },
          ],
        },
        files: [new File([code], 'worker.js', { type: 'application/javascript+module' })],
      }),
      () => api.workers.legacy.scripts.delete({ accountId, scriptName: name }),
    );

    // Its workers.dev URL, which answers once Cloudflare has it everywhere.
    yield* api.workers.legacy.scripts.subdomain.create({ accountId, scriptName: name, enabled: true });
    const { subdomain } = yield* api.workers.subdomains.get({ accountId });
    const url = `https://${name}.${subdomain}.workers.dev`;
    yield* log(`✓ enabled ${name}.<account>.workers.dev`);
    return { url, log };
  });

/**
 * Calls the preview `times` times, once it answers, and returns what it
 * answered last. A new workers.dev URL answers with a challenge page or an
 * error for a few seconds, so its `/health` is tried every second, for up
 * to a minute, before the calls that count visits.
 */
export const callPreview = (url: string, log: (text: string) => Effect.Effect<void>, times = 3) =>
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const unreachable = (cause: unknown) => new Unreachable({ url, cause });
    yield* log('waiting for it to answer');
    yield* client
      .get(`${url}/health`)
      .pipe(Effect.retry({ schedule: Schedule.spaced('1 second'), times: 60 }), Effect.mapError(unreachable));
    // A challenge page, a 403, means the request didn't reach the Worker,
    // so no visit was counted and it's safe to send again.
    const challenged = (error: unknown) =>
      error instanceof HttpClientError.HttpClientError && error.response?.status === 403;
    const call = client
      .get(url)
      .pipe(
        Effect.retry({ while: challenged, schedule: Schedule.spaced('1 second'), times: 30 }),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Answer)),
        Effect.mapError(unreachable),
      );
    let answer: Answer | undefined;
    for (let i = 0; i < times; i++) {
      answer = yield* call;
      yield* log(`✓ live: ${JSON.stringify(answer)}`);
    }
    return answer;
  });

/**
 * Deploys a Worker preview, calls it, and deletes it all.
 */
export const workerPreview = (name: string, options: { readonly broken?: boolean } = {}) =>
  Effect.scoped(Effect.flatMap(deployPreview(name, options), ({ url, log }) => callPreview(url, log)));
