import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Effect, Stream } from 'effect';

import type { DnsRecordsDnsRecordResponse } from '../sdk/dns/records/index.js';
import { Api } from '../sdk/effect.js';
import type { ZonesZone } from '../sdk/zones/index.js';
import { dnsReport } from '../src/report.js';

// Only the fields the report reads.
const zone = (id: string, name: string) => ({ id, name }) as ZonesZone;
const record = (type: string) => ({ type }) as DnsRecordsDnsRecordResponse;

// A fake Cloudflare: no network, and any method the report doesn't stub
// dies, naming its operation.
const FakeCloudflare = Api.layerTest({
  zones: {
    listAll: (request) => {
      assert.deepEqual(request, { status: 'active' });
      return Stream.make(zone('z1', 'example.com'), zone('z2', 'example.org'));
    },
  },
  dns: {
    records: {
      listAll: ({ zoneId }) =>
        Stream.fromIterable(zoneId === 'z1' ? [record('A'), record('AAAA'), record('A')] : [record('MX')]),
    },
  },
});

test('the report counts the DNS records of each active zone by type', async () => {
  const report = await Effect.runPromise(dnsReport.pipe(Effect.provide(FakeCloudflare)));
  assert.deepEqual(report, [
    { zone: 'example.com', records: { A: 2, AAAA: 1 } },
    { zone: 'example.org', records: { MX: 1 } },
  ]);
});
