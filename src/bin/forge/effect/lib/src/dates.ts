/**
 * The TypeScript form of `date-time` and `date` strings, and their codecs,
 * in place of the TypeScript runtime's dates.ts: a `date-time` is Effect's
 * DateTime.Utc, which needs no Temporal, and a `date` stays the string it
 * is on the wire, as a calendar date has no time zone to put it in.
 */

import { DateTime, Option } from 'effect';

import type { Codec } from './codec.js';

/**
 * The TypeScript form of a `date-time` string.
 */
export type Timestamp = DateTime.Utc;

/**
 * The TypeScript form of a `date` string, such as `2024-02-29`.
 */
export type CalendarDate = string;

// A date-time as RFC 3339 writes it, with its offset: a string without one
// would be read in the local time zone.
const rfc3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

// Reports whether the fields of a date-time are a real date and time, as
// Date would otherwise roll February 30 over to March 1.
function valid([, year, month, day, hour, minute, second = '0']: RegExpExecArray): boolean {
  const date = new Date(Date.UTC(+year!, +month! - 1, +day!, +hour!, +minute!, +second));
  return (
    date.getUTCFullYear() === +year! &&
    date.getUTCMonth() === +month! - 1 &&
    date.getUTCDate() === +day! &&
    date.getUTCHours() === +hour! &&
    date.getUTCMinutes() === +minute! &&
    date.getUTCSeconds() === +second
  );
}

/**
 * Converts a `date-time` string and a DateTime.Utc, to the millisecond. A
 * string that isn't a date-time with an offset is kept as it is.
 */
export const instant: Codec = {
  decode(value) {
    const fields = typeof value === 'string' ? rfc3339.exec(value) : null;
    if (fields === null || !valid(fields)) {
      return value;
    }
    return Option.getOrElse(DateTime.make((value as string).replace(/ /, 'T')), () => value);
  },
  encode: (value) => (DateTime.isDateTime(value) ? DateTime.formatIso(value) : value),
};

/**
 * Keeps a `date` string as it is.
 */
export const date: Codec = {
  decode: (value) => value,
  encode: (value) => value,
};
