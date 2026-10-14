import { Effect, Stream } from 'effect';

import { Api } from '../sdk/effect.js';

/**
 * A zone, and how many DNS records of each type it has.
 */
export interface ZoneReport {
  readonly zone: string;
  readonly records: { readonly [type: string]: number };
}

/**
 * Every active zone of the account, with its DNS records counted by type.
 * Zones and records are streamed a page at a time, four zones at once.
 */
export const dnsReport = Effect.gen(function* () {
  const api = yield* Api;
  const zones = api.zones.listAll({ status: 'active' });
  const report = Stream.mapEffect(
    zones,
    (zone) =>
      api.dns.records.listAll({ zoneId: zone.id }).pipe(
        Stream.runFold(
          (): Record<string, number> => ({}),
          (counts, record) => {
            const type = record.type ?? 'unknown';
            return { ...counts, [type]: (counts[type] ?? 0) + 1 };
          },
        ),
        Effect.map((records): ZoneReport => ({ zone: zone.name, records })),
      ),
    { concurrency: 4 },
  );
  return yield* Stream.runCollect(report);
});
