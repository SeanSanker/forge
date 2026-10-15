import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DateTime } from 'effect';

import { date, instant } from '../src/dates.js';
import * as lib from '../src/index.js';

describe('instant', () => {
  test('decodes a date-time string to a DateTime.Utc', () => {
    const value = instant.decode('2024-01-02T03:04:05.678Z');
    assert.ok(DateTime.isDateTime(value) && DateTime.isUtc(value));
    assert.equal(DateTime.toEpochMillis(value), Date.UTC(2024, 0, 2, 3, 4, 5, 678));
    const offset = instant.decode('2024-01-02T05:04:05+02:00');
    assert.ok(DateTime.isDateTime(offset));
    assert.equal(DateTime.formatIso(offset), '2024-01-02T03:04:05.000Z');
  });

  test('keeps strings that are not date-times with an offset, and other values', () => {
    for (const value of ['2024-01-02T03:04:05', '2024-01-02', '2024-02-30T00:00:00Z', 'soon', '', 1, null]) {
      assert.equal(instant.decode(value), value);
    }
  });

  test('encodes a DateTime as its ISO string, and keeps other values', () => {
    assert.equal(instant.encode(DateTime.makeUnsafe('2024-01-02T03:04:05Z')), '2024-01-02T03:04:05.000Z');
    for (const value of ['2024-01-02T03:04:05Z', null, 1]) {
      assert.equal(instant.encode(value), value);
    }
  });

  test('needs no Temporal', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Temporal');
    Reflect.deleteProperty(globalThis, 'Temporal');
    try {
      assert.ok(DateTime.isDateTime(instant.decode('2024-01-02T03:04:05Z')));
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(globalThis, 'Temporal', descriptor);
      }
    }
  });
});

describe('date', () => {
  test('keeps a date string as it is', () => {
    assert.equal(date.decode('2024-02-29'), '2024-02-29');
    assert.equal(date.encode('2024-02-29'), '2024-02-29');
  });
});

test("the SDK's runtime index exports these codecs", () => {
  assert.equal(lib.instant, instant);
  assert.equal(lib.date, date);
});
