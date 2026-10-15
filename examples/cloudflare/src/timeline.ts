import { Clock, Console, Effect } from 'effect';

/**
 * Returns a log that prints each line with the seconds since it was made.
 */
export const timeline = Effect.map(
  Clock.currentTimeMillis,
  (start) => (text: string) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Console.log(`${((now - start) / 1000).toFixed(2).padStart(5)}s  ${text}`),
    ),
);
