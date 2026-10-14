/**
 * How an Effect client authenticates its requests.
 *
 * An `Auth` turns each request into an authenticated one, after the
 * transport has built it and before it goes to the `HttpClient`. It can
 * set headers, add query parameters, or sign the request, and it can run
 * Effects to do so, such as fetching a token. One that caches credentials
 * can also `refresh`: after a 401, the transport calls it and sends the
 * request once more.
 */

import { Context, Data, Duration, Effect, Exit, Redacted } from 'effect';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';

/** Credentials could not be got, such as a failed token request. */
export class AuthError extends Data.TaggedError('AuthError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface Auth {
  /** Returns the request with credentials. */
  readonly authenticate: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientRequest.HttpClientRequest, AuthError>;
  /**
   * Forgets cached credentials after a 401. The transport then sends the
   * request once more. An Auth without it gets no second try.
   */
  readonly refresh?: Effect.Effect<void>;
  /**
   * Headers that hold credentials, which the transport adds to the names
   * Effect redacts while it sends a request, as in logged requests and
   * errors. `authorization` and `x-api-key` are redacted already.
   */
  readonly redactedHeaders?: readonly string[];
}

/** A secret, which can be Redacted. */
export type Secret = string | Redacted.Redacted<string>;

const reveal = (secret: Secret): string => (Redacted.isRedacted(secret) ? Redacted.value(secret) : secret);

/** Returns an Auth from its parts, for schemes this module has no function for. */
export const make = (auth: Auth): Auth => auth;

/** Sends `Authorization: Bearer <token>`. */
export const bearer = (token: Secret): Auth => ({
  authenticate: (request) => Effect.succeed(HttpClientRequest.bearerToken(request, token)),
});

/** Sends `Authorization: Basic`, with a username and password. */
export const basic = (username: string, password: Secret): Auth => ({
  authenticate: (request) => Effect.succeed(HttpClientRequest.basicAuth(request, username, password)),
});

/**
 * Sends an API key, in a header, which is redacted, or in a query
 * parameter. A key in the query is part of the URL, which tracing records,
 * so prefer a header when the API takes one.
 */
export const apiKey = (key: Secret, where: { readonly header: string } | { readonly query: string }): Auth =>
  'header' in where
    ? {
        authenticate: (request) => Effect.succeed(HttpClientRequest.setHeader(request, where.header, reveal(key))),
        redactedHeaders: [where.header],
      }
    : {
        authenticate: (request) => Effect.succeed(HttpClientRequest.appendUrlParam(request, where.query, reveal(key))),
      };

/** A token, and how many seconds it lasts. */
export interface Token {
  readonly token: Secret;
  readonly expiresIn?: number;
}

/**
 * Returns an Auth that gets a token with `fetch`, keeps it until it expires
 * or a request gets a 401, and sends it with `apply`: as a bearer token by
 * default. Concurrent requests share one fetch.
 *
 * Use it for any login that trades credentials for a token: OAuth2, or a
 * username and password for a session.
 */
export const cachedToken = <R>(options: {
  readonly fetch: Effect.Effect<Token, AuthError, R>;
  readonly apply?: (request: HttpClientRequest.HttpClientRequest, token: string) => HttpClientRequest.HttpClientRequest;
  /** How many seconds before it expires a token is replaced. 30 by default. */
  readonly skew?: number;
}): Effect.Effect<Auth, never, R> =>
  Effect.gen(function* () {
    // The services of R, for fetching later. The request's own context, such
    // as its span, wins over the one the Auth was made in.
    const captured = yield* Effect.context<R>();
    const fetch = Effect.updateContext(options.fetch, (current: Context.Context<never>) =>
      Context.merge(captured, current),
    );
    const apply = options.apply ?? ((request, token) => HttpClientRequest.bearerToken(request, token));
    const skew = (options.skew ?? 30) * 1000;
    // A token is kept until it expires, and a failed fetch isn't kept.
    const [current, forget] = yield* Effect.cachedInvalidateWithTTL(fetch, (exit) =>
      Exit.isFailure(exit)
        ? Duration.zero
        : exit.value.expiresIn === undefined
          ? Duration.infinity
          : Duration.millis(Math.max(0, exit.value.expiresIn * 1000 - skew)),
    );

    return make({
      authenticate: (request) => Effect.map(current, ({ token }) => apply(request, reveal(token))),
      refresh: forget,
    });
  });

/**
 * Returns an Auth for the OAuth2 client credentials grant: it gets an
 * access token from `tokenUrl` with the client's id and secret, and sends
 * it as a bearer token until it expires. It fetches tokens with the
 * HttpClient in context.
 */
export const oauth2ClientCredentials = (options: {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: Secret;
  readonly scope?: string;
}): Effect.Effect<Auth, never, HttpClient.HttpClient> =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    cachedToken({
      fetch: HttpClientRequest.post(options.tokenUrl).pipe(
        HttpClientRequest.basicAuth(options.clientId, options.clientSecret),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyUrlParams({
          grant_type: 'client_credentials',
          ...(options.scope === undefined ? {} : { scope: options.scope }),
        }),
        client.execute,
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.flatMap((body) => {
          const { access_token, expires_in } = (body ?? {}) as { access_token?: unknown; expires_in?: unknown };
          return typeof access_token === 'string'
            ? Effect.succeed({
                token: access_token,
                ...(typeof expires_in === 'number' ? { expiresIn: expires_in } : {}),
              })
            : Effect.fail(new AuthError({ message: 'the token response has no access_token' }));
        }),
        Effect.mapError((cause) =>
          cause instanceof AuthError ? cause : new AuthError({ message: 'the token request failed', cause }),
        ),
      ),
    }),
  );
