/**
 * The Effect transport of the generated clients.
 *
 * Each method of a generated client is an `Operation`, plain data, and the
 * `bind` of each Effect client sends it with `EffectTransport.send`. The
 * codecs, error messages and envelope hook are those of the Promise
 * client's `Transport`. Only the sending differs: it goes through Effect's
 * `HttpClient`, so retries, tracing, timeouts, interruption and test
 * clients come from Effect.
 */

import { Array as Arr, Cause, Data, Duration, Effect, Stream } from 'effect';
import {
  Headers as HttpHeaders,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  type HttpMethod,
} from 'effect/http';

import type { Auth, AuthError } from './auth.js';
import { type BinaryInput, formData, rawBytes, urlEncoded } from './body.js';
import { isRecord, parse, set, toBase64 } from './codec.js';
import { errorMessage } from './error.js';
import { unwrapEnvelope } from './hooks/envelope.js';
import type { Codec, Operation } from './index.js';

/**
 * An error response from the API, or a success response whose body is not
 * valid JSON. The fields are those of the Promise client's `ApiError`.
 */
export class ApiError<const R extends Reason = Reason> extends Data.TaggedError('ApiError')<{
  readonly message: string;
  readonly status: number;
  /**
   * The response, whose body has been read.
   */
  readonly response: HttpClientResponse.HttpClientResponse;
  /**
   * Which error response this is: one the operation declares, with its
   * body decoded, or `Unexpected`. Handle one with
   * `Effect.catchReason('ApiError', 'NotFound', ...)`.
   */
  readonly reason: R;
  /**
   * The details of the reason: the body decoded as declared, or as text.
   */
  readonly details: R['details'];
  readonly cause?: unknown;
}> {
  /**
   * Makes the error of a response, whose details are those of its reason.
   */
  constructor(props: {
    readonly message: string;
    readonly status: number;
    readonly response: HttpClientResponse.HttpClientResponse;
    readonly reason: R;
    readonly cause?: unknown;
  }) {
    super({ ...props, details: props.reason.details });
  }

  /**
   * Returns the ApiError of `reason`, for a test's fake client to fail
   * with. Its response is a stand-in, with the reason's details as its JSON
   * body; its message is the body's message, or else the status.
   *
   * ```ts
   * ApiError.fake({ _tag: 'NotFound', status: 404, details: { message: 'no such pet' } });
   * ```
   */
  static fake<const R extends Reason>(reason: R): ApiError<R> {
    const body = reason.details === undefined ? '' : JSON.stringify(reason.details);
    const response = HttpClientResponse.fromWeb(
      HttpClientRequest.get('https://fake.invalid/'),
      new Response(body, { status: reason.status, headers: { 'content-type': 'application/json' } }),
    );
    const message = errorMessage(reason.details) ?? String(reason.status);
    return new ApiError({ message, status: reason.status, response, reason });
  }
}

/**
 * Why a call failed with an ApiError. A declared error response is named
 * after its status, as `reasonTag` names it, and has its body, decoded as
 * the operation declares it, as details.
 */
export interface Reason<Tag extends string = string, Details = unknown> {
  readonly _tag: Tag;
  readonly status: number;
  readonly details: Details;
}

/**
 * An error response the operation doesn't declare, or whose body isn't the
 * JSON it declares, or a success response whose body isn't valid JSON. The
 * details are the body as text, or undefined when it is empty.
 */
export type Unexpected = Reason<'Unexpected', string | undefined>;

/**
 * What a call of an Effect client fails with: an ApiError, for one of the
 * reasons `R`, an AuthError, or an HttpClientError.
 */
export type ClientError<R extends Reason = Reason> = ApiError<R> | AuthError | HttpClientError.HttpClientError;

const statusNames: { readonly [status: string]: string } = {
  '400': 'BadRequest',
  '401': 'Unauthorized',
  '402': 'PaymentRequired',
  '403': 'Forbidden',
  '404': 'NotFound',
  '405': 'MethodNotAllowed',
  '406': 'NotAcceptable',
  '408': 'RequestTimeout',
  '409': 'Conflict',
  '410': 'Gone',
  '412': 'PreconditionFailed',
  '413': 'ContentTooLarge',
  '415': 'UnsupportedMediaType',
  '422': 'UnprocessableContent',
  '429': 'TooManyRequests',
  '500': 'InternalServerError',
  '501': 'NotImplemented',
  '502': 'BadGateway',
  '503': 'ServiceUnavailable',
  '504': 'GatewayTimeout',
};

/**
 * Returns the tag of the reason for a declared error response, by its
 * status in the document: the name of the status, such as `NotFound` for
 * 404, `Status418` for a status with no name here, `Status4XX` for a range,
 * and `Default` for `default`.
 */
export function reasonTag(status: string): string {
  if (status === 'default') {
    return 'Default';
  }
  return Object.hasOwn(statusNames, status) ? statusNames[status]! : `Status${status}`;
}

/**
 * The options every Effect client takes.
 */
export interface ClientOptions {
  /**
   * The URL the paths of the API are relative to; by default, the URL of
   * the API's server, when its document gives one.
   */
  readonly baseUrl?: string;
  /**
   * How requests authenticate, such as `Auth.bearer(token)`. Requests have
   * no credentials without it, and operations that need none never send
   * them.
   */
  readonly auth?: Auth;
  /**
   * Headers sent with every request.
   */
  readonly headers?: HeadersInit;
  /**
   * Query parameters sent with every request.
   */
  readonly query?: URLSearchParams;
  /**
   * Whether, and how, requests are retried after a transient failure. Not
   * by default.
   */
  readonly retry?: boolean | RetryOptions;
  /**
   * How long each attempt waits for a response before it fails, as a
   * transport error, which a retry may then repeat. 60 seconds by default;
   * false for no limit.
   */
  readonly timeout?: Duration.Input | false;
}

/**
 * How a client retries requests, authenticating each attempt again.
 *
 * A request that is safe to send again, one whose method is idempotent
 * (GET, HEAD, OPTIONS, PUT, DELETE, TRACE) or that has an `Idempotency-Key`
 * header, is retried after a transport error, a timeout, or a 408, 429,
 * 500, 502, 503 or 504 response. Any other request is retried only after a
 * 429, which says it wasn't processed.
 */
export interface RetryOptions {
  /**
   * How many times a request is sent again. 2 by default.
   */
  readonly times?: number;
  /**
   * The wait before the first retry, which doubles for each one after it,
   * when the response has no `Retry-After`. 250 milliseconds by default.
   */
  readonly delay?: Duration.Input;
  /**
   * The longest `Retry-After` the client waits for. A response that asks for
   * longer is not retried. 5 minutes by default.
   */
  readonly maxRetryAfter?: Duration.Input;
}

/**
 * The options of a call. A call is aborted by interrupting it, so there is
 * no `signal`.
 */
export interface RequestOptions {
  /**
   * Headers sent with the request, which replace those of the client.
   */
  readonly headers?: HeadersInit;
  /**
   * Query parameters appended after those of the client.
   */
  readonly query?: URLSearchParams;
}

/**
 * How the generated clients send an operation.
 */
export interface SendOptions {
  /**
   * Whether the request has the client's credentials: false for an
   * operation that needs none. True by default.
   */
  readonly auth?: boolean;
  /**
   * Where to send the request instead of the operation's route and query:
   * a next page link from a response, as a URL, which may be relative to
   * the base URL, or as a path that follows the base URL. The client's and
   * the call's query parameters are added where the link has none of the
   * same name. A link to another origin than the base URL's is a defect, so
   * a response can't send the client's credentials elsewhere.
   */
  readonly link?: { readonly uri: string } | { readonly path: string };
}

type Fields = { [key: string]: unknown };

/**
 * Sends the operations of the generated Effect clients with the
 * `HttpClient` it was made with.
 */
export class EffectTransport {
  readonly #client: HttpClient.HttpClient;
  readonly #options: ClientOptions;
  readonly #baseUrl: string;

  /**
   * Checks the options of a client. `baseUrl` is used when the options have
   * none.
   */
  constructor(client: HttpClient.HttpClient, options: ClientOptions, baseUrl?: string) {
    const url = options?.baseUrl ?? baseUrl;
    if (typeof url !== 'string' || url === '') {
      throw new TypeError('baseUrl is required');
    }
    this.#client = client;
    this.#options = options;
    this.#baseUrl = url.replace(/\/+$/, '');
  }

  /**
   * Sends a request for operation and returns its decoded response. A
   * missing path parameter is a defect, as the Promise client throws.
   */
  send<T, E extends ClientError = ClientError>(
    operation: Operation,
    request: object | undefined,
    options: RequestOptions | undefined,
    sending?: SendOptions,
  ): Effect.Effect<T, E> {
    const send = () =>
      Effect.flatMap(this.#respond(operation, (request ?? {}) as Fields, options, sending ?? {}), (response) =>
        decode(operation, response),
      );
    return Effect.suspend(send) as Effect.Effect<T, E>;
  }

  /**
   * Sends a request for operation, whose response is bytes, and returns its
   * body as a Stream, read as it arrives rather than held in memory. A
   * retry or a refresh after a 401 happens before the first byte; an error
   * while reading fails the stream.
   */
  stream<E extends ClientError = ClientError>(
    operation: Operation,
    request: object | undefined,
    options: RequestOptions | undefined,
    sending?: SendOptions,
  ): Stream.Stream<Uint8Array, E> {
    const respond = Effect.suspend(() => this.#respond(operation, (request ?? {}) as Fields, options, sending ?? {}));
    return Stream.unwrap(Effect.map(respond, (response) => response.stream)) as Stream.Stream<Uint8Array, E>;
  }

  // Sends the request, and returns its response when its status is a
  // success, with the body unread.
  #respond(
    operation: Operation,
    request: Fields,
    options: RequestOptions | undefined,
    sending: SendOptions,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, ClientError> {
    const headers = new Headers({ accept: operation.accept ?? 'application/json' });
    new Headers(this.#options.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    new Headers(options?.headers).forEach((value, key) => {
      headers.set(key, value);
    });

    // The whole URL, query and all, is the request's url, as an Auth that
    // signs requests reads it, rather than split into its urlParams.
    const target = (
      sending.link === undefined
        ? url(this.#baseUrl, operation, request, this.#options, options)
        : link(this.#baseUrl, sending.link, this.#options, options)
    ).href;
    const req = HttpClientRequest.make(operation.method as HttpMethod.HttpMethod)(target, { headers });

    return withBody(req, operation, bodyOf(operation, request), headers.get('content-type')).pipe(
      Effect.flatMap((req) => this.#execute(req, operation, sending.auth ?? true)),
      Effect.flatMap((response) =>
        response.status < 200 || response.status > 299
          ? Effect.flatMap(apiError(operation, response), Effect.fail)
          : Effect.succeed(response),
      ),
    );
  }

  // Sends the request with the client's credentials, after the headers of
  // the client and the call, so an Auth that signs requests signs what is
  // sent. After a 401, an Auth that can refresh them does, and the request
  // is sent once more. The HttpClient's span is named after the operation,
  // such as `GET /pets/{petId}`.
  #execute(
    request: HttpClientRequest.HttpClientRequest,
    operation: Operation,
    authenticate: boolean,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, ClientError> {
    const name = `${operation.method} ${operation.route}`;
    const timeout = this.#options.timeout ?? Duration.seconds(60);
    const execute = (req: HttpClientRequest.HttpClientRequest) => {
      const sent = this.#client.execute(req).pipe(Effect.provideService(HttpClient.SpanNameGenerator, () => name));
      return timeout === false
        ? sent
        : Effect.timeoutOrElse(sent, {
            duration: timeout,
            orElse: () =>
              Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({
                    request: req,
                    description: `no response within ${Duration.format(Duration.fromInputUnsafe(timeout))}`,
                  }),
                }),
              ),
          });
    };
    const auth = authenticate ? this.#options.auth : undefined;
    let sent: Effect.Effect<HttpClientResponse.HttpClientResponse, ClientError> = execute(request);
    if (auth !== undefined) {
      const attempt = Effect.flatMap(
        Effect.suspend(() => auth.authenticate(request)),
        (authenticated) => Effect.map(execute(authenticated), (response) => [authenticated, response] as const),
      );
      const refresh = auth.refresh;
      sent = Effect.flatMap(attempt, ([authenticated, response]) =>
        refresh !== undefined && response.status === 401
          ? Effect.andThen(
              refresh(authenticated),
              Effect.map(attempt, ([, again]) => again),
            )
          : Effect.succeed(response),
      );
    }
    const retry = this.#options.retry;
    if (retry !== undefined && retry !== false) {
      sent = retrying(sent, retry === true ? {} : retry, safeToRepeat(request));
    }
    const redacted = auth?.redactedHeaders;
    return redacted === undefined || redacted.length === 0
      ? sent
      : sent.pipe(Effect.updateService(HttpHeaders.CurrentRedactedNames, Arr.appendAll(redacted)));
  }
}

/**
 * Stubs of some of the methods of a client, for a fake one in tests: each
 * is a function of the method's type, and each group takes stubs of its own.
 */
export type Stubs<C> = {
  readonly [K in keyof C]?: C[K] extends (...args: never[]) => unknown ? C[K] : Stubs<C[K]>;
};

/**
 * Returns the client that `bind` makes with `stubs` in place of its
 * methods. A method that isn't stubbed dies, naming its operation, as does
 * the Stream of a paginated one, so a test fails where it calls something it
 * didn't expect.
 */
export function stub<C extends object>(bind: (transport: EffectTransport) => C, stubs: Stubs<C>): C {
  return merge(bind(new Unstubbed()), stubs);
}

// A transport that sends nothing: each operation dies.
class Unstubbed extends EffectTransport {
  constructor() {
    super(
      HttpClient.make(() => Effect.die(new Error('a fake client sends nothing'))),
      { baseUrl: 'https://unstubbed.invalid' },
    );
  }

  override send<T, E extends ClientError = ClientError>(operation: Operation): Effect.Effect<T, E> {
    return Effect.die(new Error(`${operation.method} ${operation.route} isn't stubbed`));
  }

  override stream<E extends ClientError = ClientError>(operation: Operation): Stream.Stream<Uint8Array, E> {
    return Stream.die(new Error(`${operation.method} ${operation.route} isn't stubbed`));
  }
}

// Returns `client` with `stubs` in place of its members. Groups are merged
// the first time they are read, as bind makes them.
function merge<C extends object>(client: C, stubs: Stubs<C>): C {
  const merged: object =
    typeof client === 'function' ? (...args: unknown[]) => (client as (...args: unknown[]) => unknown)(...args) : {};
  for (const key of Object.keys(client)) {
    Object.defineProperty(merged, key, {
      enumerable: true,
      get: () => (client as Record<string, unknown>)[key],
      configurable: true,
    });
  }
  for (const [key, value] of Object.entries(stubs as Record<string, unknown>)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === 'function') {
      Object.defineProperty(merged, key, { enumerable: true, value, configurable: true });
      continue;
    }
    let group: object | undefined;
    Object.defineProperty(merged, key, {
      enumerable: true,
      get: () => (group ??= merge((client as Record<string, object>)[key]!, value as Stubs<object>)),
      configurable: true,
    });
  }
  return merged as C;
}

const idempotentMethods = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'TRACE']);

// The statuses of responses that may pass on another try, as Effect's
// HttpClient.retryTransient has them.
const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);

function safeToRepeat(request: HttpClientRequest.HttpClientRequest): boolean {
  return idempotentMethods.has(request.method) || request.headers['idempotency-key'] !== undefined;
}

// Sends again what `send` sends while it fails in a way that may pass on
// another try, at most `times` more times, after its Retry-After or a wait
// that doubles each time. The last response is returned as it is. A request
// that isn't `safe` to send again is repeated only after a 429.
function retrying(
  send: Effect.Effect<HttpClientResponse.HttpClientResponse, ClientError>,
  options: RetryOptions,
  safe: boolean,
): Effect.Effect<HttpClientResponse.HttpClientResponse, ClientError> {
  const times = options.times ?? 2;
  const delay = Duration.toMillis(options.delay ?? 250);
  const maxRetryAfter = Duration.toMillis(options.maxRetryAfter ?? Duration.minutes(5));
  const wait = (attempt: number, after: number | undefined) =>
    Effect.sleep(Duration.millis(after ?? delay * 2 ** attempt));
  const loop = (attempt: number): Effect.Effect<HttpClientResponse.HttpClientResponse, ClientError> =>
    Effect.matchEffect(send, {
      onFailure: (error) =>
        safe && attempt < times && transient(error)
          ? Effect.andThen(wait(attempt, undefined), loop(attempt + 1))
          : Effect.fail(error),
      onSuccess: (response) => {
        const after = retryAfter(response);
        const retried = safe ? transientStatuses.has(response.status) : response.status === 429;
        if (attempt >= times || !retried || (after ?? 0) > maxRetryAfter) {
          return Effect.succeed(response);
        }
        return Effect.andThen(wait(attempt, after), loop(attempt + 1));
      },
    });
  return loop(0);
}

// Reports whether an error may pass on another try: the request didn't get
// a response, or timed out.
function transient(error: ClientError): boolean {
  return (error._tag === 'HttpClientError' && error.reason._tag === 'TransportError') || Cause.isTimeoutError(error);
}

// Returns the milliseconds a response's Retry-After asks the client to
// wait, in seconds or as an HTTP date.
function retryAfter(response: HttpClientResponse.HttpClientResponse): number | undefined {
  const value = response.headers['retry-after'];
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

// What follows is the Promise client's Transport, with Effect in place of
// fetch and await.

// Returns the request with its body, as the operation sends it. A content
// type in the headers wins, as in the Promise client, except for a
// multipart body, whose content type has the boundary of its form data.
function withBody(
  req: HttpClientRequest.HttpClientRequest,
  operation: Operation,
  body: unknown,
  contentType: string | null,
): Effect.Effect<HttpClientRequest.HttpClientRequest> {
  if (body === undefined) {
    return Effect.succeed(req);
  }
  switch (operation.encoding) {
    case 'multipart':
      return Effect.succeed(
        HttpClientRequest.bodyFormData(
          HttpClientRequest.removeHeader(req, 'content-type'),
          formData(body as Fields, operation.files),
        ),
      );
    case 'form':
      return Effect.succeed(
        HttpClientRequest.bodyText(
          req,
          urlEncoded(body as Fields).toString(),
          contentType ?? 'application/x-www-form-urlencoded',
        ),
      );
    case 'raw':
      return Effect.map(
        Effect.promise(() => rawBytes(body as BinaryInput, contentType ?? operation.contentType)),
        (raw) => HttpClientRequest.bodyUint8Array(req, raw.bytes, raw.contentType),
      );
    default:
      return Effect.succeed(
        HttpClientRequest.bodyText(
          req,
          JSON.stringify(body),
          contentType ?? operation.contentType ?? 'application/json',
        ),
      );
  }
}

function decode(
  operation: Operation,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<unknown, ClientError> {
  const codec = operation.response;
  if (codec === undefined) {
    return Effect.void;
  }
  if (operation.responseType === 'bytes') {
    return Effect.map(response.arrayBuffer, (buffer) => new Uint8Array(buffer));
  }
  if (operation.responseType === 'text') {
    return response.text;
  }
  return Effect.flatMap(response.text, (text): Effect.Effect<unknown, ApiError> => {
    if (text === '') {
      return Effect.void;
    }
    let value: unknown;
    try {
      value = parse(text);
    } catch (cause) {
      return Effect.fail(
        new ApiError({
          message: 'the response body is not valid JSON',
          status: response.status,
          response,
          reason: { _tag: 'Unexpected', status: response.status, details: text },
          cause,
        }),
      );
    }
    value = unwrapEnvelope(toWeb(response), value);
    return Effect.succeed(codec === null ? value : codec.decode(value));
  });
}

// The envelope hook reads a Web Response. It gets the status and headers;
// the body has been read.
function toWeb(response: HttpClientResponse.HttpClientResponse): Response {
  return new Response(null, { status: response.status, headers: response.headers as Record<string, string> });
}

function apiError(operation: Operation, response: HttpClientResponse.HttpClientResponse): Effect.Effect<ApiError> {
  return Effect.map(
    Effect.orElseSucceed(response.text, () => ''),
    (text) => {
      let body: unknown;
      let json = false;
      if (text !== '') {
        try {
          body = parse(text);
          json = true;
        } catch {
          // The body is kept as text.
        }
      }
      const status = response.status;
      const found = lookup(operation.errors, status);
      let reason: Reason = { _tag: 'Unexpected', status, details: text === '' ? undefined : text };
      if (json && found !== undefined && found.declared !== false) {
        const { key, declared } = found;
        reason = { _tag: reasonTag(key), status, details: declared === true ? body : declared.decode(body) };
      }
      const message = (json ? errorMessage(body) : undefined) ?? String(status);
      return new ApiError({ message, status, response, reason });
    },
  );
}

// Returns the declared error response that `status` matches, and its key.
function lookup(
  errors: Operation['errors'],
  status: number,
): { readonly key: string; readonly declared: Codec | boolean } | undefined {
  if (errors === undefined) {
    return undefined;
  }
  for (const key of [String(status), `${Math.floor(status / 100)}XX`, 'default']) {
    if (Object.hasOwn(errors, key)) {
      return { key, declared: errors[key]! };
    }
  }
  return undefined;
}

function toParam(value: unknown): string {
  if (value instanceof Uint8Array) {
    return toBase64(value);
  }
  if (isRecord(value)) {
    return JSON.stringify(value);
  }
  return String(value);
}

function url(
  baseUrl: string,
  operation: Operation,
  request: Fields,
  client: ClientOptions,
  options: RequestOptions | undefined,
): URL {
  const path = operation.route.replace(/\{([^}]+)\}/g, (_, field: string) => {
    let value = request[field];
    if (value === undefined && operation.variables?.includes(field)) {
      value = (client as unknown as Fields)[field];
    }
    if (value === undefined || value === null || value === '') {
      throw new TypeError(`${field} is required: set it in the request or the client options`);
    }
    return encodeURIComponent(toParam(value));
  });
  const target = new URL(baseUrl + path);
  const query = target.searchParams;
  for (const [field, wire] of Object.entries(operation.query ?? {})) {
    const value = request[field];
    if (value === undefined || value === null) {
      continue;
    }
    if (!Array.isArray(value)) {
      query.append(wire, toParam(value));
    } else if (operation.joined?.includes(field)) {
      query.append(wire, value.map(toParam).join(','));
    } else {
      for (const item of value) {
        query.append(wire, toParam(item));
      }
    }
  }
  client.query?.forEach((value, key) => {
    query.append(key, value);
  });
  options?.query?.forEach((value, key) => {
    query.append(key, value);
  });
  return target;
}

// Returns the URL of a next page link, with the query parameters of the
// client and the call that it lacks, and checks it is on the base URL's
// origin.
function link(
  baseUrl: string,
  next: { readonly uri: string } | { readonly path: string },
  client: ClientOptions,
  options: RequestOptions | undefined,
): URL {
  const base = new URL(baseUrl);
  const target =
    'uri' in next
      ? new URL(next.uri, `${baseUrl}/`)
      : new URL(baseUrl + (next.path.startsWith('/') ? '' : '/') + next.path);
  if (target.origin !== base.origin) {
    throw new TypeError(`the next page is at ${target.origin}, not ${base.origin}, so it isn't fetched`);
  }
  const query = target.searchParams;
  for (const params of [client.query, options?.query]) {
    params?.forEach((value, key) => {
      if (!query.has(key)) {
        query.append(key, value);
      }
    });
  }
  return target;
}

// The fields of each operation that are parameters rather than body.
const paramFields = new WeakMap<Operation, Set<string>>();

function paramsOf(operation: Operation): Set<string> {
  let fields = paramFields.get(operation);
  if (fields === undefined) {
    fields = new Set(Object.keys(operation.query ?? {}));
    for (const [, field] of operation.route.matchAll(/\{([^}]+)\}/g)) {
      fields.add(field!);
    }
    paramFields.set(operation, fields);
  }
  return fields;
}

function bodyOf(operation: Operation, request: Fields): unknown {
  let body: unknown;
  if (operation.body === 'nested') {
    body = request['body'];
  } else if (operation.body === 'flat') {
    const params = paramsOf(operation);
    const fields: Fields = {};
    for (const key of Object.keys(request)) {
      if (!params.has(key)) {
        set(fields, key, request[key]);
      }
    }
    // A DELETE with no fields to send sends no body: an API can refuse an
    // empty object, as Cloudflare's R2 notification delete does.
    body = operation.method === 'DELETE' && Object.keys(fields).length === 0 ? undefined : fields;
  }
  if (body === undefined || operation.request === undefined) {
    return body;
  }
  return operation.request.encode(body);
}
