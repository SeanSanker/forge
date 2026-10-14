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

import { Array as Arr, Data, Effect } from 'effect';
import {
  Headers as HttpHeaders,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse,
  type HttpMethod,
} from 'effect/http';

import type { Auth, AuthError } from './auth.js';
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
  readonly cause?: unknown;
}> {
  /**
   * The details of the reason: the body decoded as declared, or as text.
   */
  get details(): R['details'] {
    return this.reason.details;
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
   * The URL the paths of the API are relative to.
   */
  readonly baseUrl: string;
  /**
   * How requests authenticate, such as `Auth.bearer(token)`. Requests have
   * no credentials without it.
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
   * Checks the options of a client.
   */
  constructor(client: HttpClient.HttpClient, options: ClientOptions) {
    if (typeof options?.baseUrl !== 'string' || options.baseUrl === '') {
      throw new TypeError('baseUrl is required');
    }
    this.#client = client;
    this.#options = options;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  /**
   * Sends a request for operation and returns its decoded response. A
   * missing path parameter is a defect, as the Promise client throws.
   */
  send<T, E extends ClientError = ClientError>(
    operation: Operation,
    request: object | undefined,
    options: RequestOptions | undefined,
  ): Effect.Effect<T, E> {
    return Effect.suspend(() => this.#send(operation, (request ?? {}) as Fields, options)) as Effect.Effect<T, E>;
  }

  #send(
    operation: Operation,
    request: Fields,
    options: RequestOptions | undefined,
  ): Effect.Effect<unknown, ClientError> {
    const headers = new Headers({ accept: 'application/json' });
    new Headers(this.#options.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    new Headers(options?.headers).forEach((value, key) => {
      headers.set(key, value);
    });

    // The whole URL, query and all, is the request's url, as an Auth that
    // signs requests reads it, rather than split into its urlParams.
    const target = url(this.#baseUrl, operation, request, this.#options, options).href;
    let req = HttpClientRequest.make(operation.method as HttpMethod.HttpMethod)(target, { headers });
    const body = bodyOf(operation, request);
    if (body !== undefined) {
      // A content type in the headers wins, as in the Promise client.
      const contentType = headers.get('content-type') ?? operation.contentType ?? 'application/json';
      req = HttpClientRequest.bodyText(req, JSON.stringify(body), contentType);
    }

    return Effect.flatMap(this.#execute(req, operation), (response) =>
      response.status < 200 || response.status > 299
        ? Effect.flatMap(apiError(operation, response), Effect.fail)
        : decode(operation, response),
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
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, ClientError> {
    const name = `${operation.method} ${operation.route}`;
    const execute = (req: HttpClientRequest.HttpClientRequest) =>
      this.#client.execute(req).pipe(Effect.provideService(HttpClient.SpanNameGenerator, () => name));
    const auth = this.#options.auth;
    if (auth === undefined) {
      return execute(request);
    }
    const attempt = Effect.flatMap(
      Effect.suspend(() => auth.authenticate(request)),
      execute,
    );
    const refresh = auth.refresh;
    const sent =
      refresh === undefined
        ? attempt
        : Effect.flatMap(attempt, (response) =>
            response.status === 401 ? Effect.andThen(refresh, attempt) : Effect.succeed(response),
          );
    const redacted = auth.redactedHeaders;
    return redacted === undefined || redacted.length === 0
      ? sent
      : sent.pipe(Effect.updateService(HttpHeaders.CurrentRedactedNames, Arr.appendAll(redacted)));
  }
}

// What follows is the Promise client's Transport, with Effect in place of
// fetch and await.

function decode(
  operation: Operation,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<unknown, ClientError> {
  const codec = operation.response;
  if (codec === undefined) {
    return Effect.void;
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
    body = fields;
  }
  if (body === undefined || operation.request === undefined) {
    return body;
  }
  return operation.request.encode(body);
}
