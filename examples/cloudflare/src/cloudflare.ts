import { Effect } from 'effect';

import { ApiError, type Reason } from '../sdk/effect.js';

/**
 * The body of Cloudflare's error responses, which its document declares for
 * most operations as one 4XX response.
 */
export interface Failure {
  readonly errors: readonly { readonly code: number; readonly message: string }[];
}

/**
 * An ApiError whose body is Cloudflare's, listing its error codes.
 */
export type CloudflareError = ApiError<Reason<string, Failure>>;

/**
 * Reports whether `error` is an ApiError whose body lists Cloudflare's
 * error `code`.
 */
export function hasCode(error: unknown, code: number): error is CloudflareError {
  if (!(error instanceof ApiError)) {
    return false;
  }
  const errors: unknown = (error.details as { errors?: unknown } | undefined)?.errors;
  return Array.isArray(errors) && errors.some((e: { code?: unknown } | null) => e?.code === code);
}

/**
 * Handles the error of one Cloudflare error code, such as 10013 for a KV
 * namespace that doesn't exist, and fails with any other error as it is.
 *
 * ```ts
 * api.kv.namespaces.get({ accountId, namespaceId }).pipe(
 *   catchCode(10013, () => Effect.succeed(undefined)),
 * );
 * ```
 */
export const catchCode =
  <A2, E2, R2>(code: number, f: (error: CloudflareError) => Effect.Effect<A2, E2, R2>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | A2, E | E2, R | R2> =>
    Effect.catch(self, (error): Effect.Effect<A2, E | E2, R2> =>
      hasCode(error, code) ? f(error) : Effect.fail(error),
    );
