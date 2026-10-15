/**
 * The TypeScript form of `date-time` and `date` strings, and their codecs:
 * Temporal's Instant and PlainDate. Another target can put its own dates.ts
 * here, with the same exports, to use another form.
 */

import { attempt, type Codec } from './codec.js';

/**
 * The TypeScript form of a `date-time` string.
 */
export type Timestamp = Temporal.Instant;

/**
 * The TypeScript form of a `date` string.
 */
export type CalendarDate = Temporal.PlainDate;

function toText(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? String(value) : value;
}

/**
 * Converts a `date-time` string and a Temporal.Instant.
 */
export const instant: Codec = {
  decode: (value) => (typeof value === 'string' ? attempt(() => Temporal.Instant.from(value), value) : value),
  encode: toText,
};

/**
 * Converts a `date` string and a Temporal.PlainDate.
 */
export const date: Codec = {
  decode: (value) => (typeof value === 'string' ? attempt(() => Temporal.PlainDate.from(value), value) : value),
  encode: toText,
};
