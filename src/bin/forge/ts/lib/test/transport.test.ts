import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { int64, object } from '../src/codec.js';
import { instant } from '../src/dates.js';
import { ApiError } from '../src/error.js';
import { type BaseClientOptions, type Operation, type Pagination, Transport } from '../src/transport.js';

interface Call {
  url: URL;
  method: string | undefined;
  headers: Headers;
  body: unknown;
  signal: AbortSignal | null | undefined;
}

interface ClientOptions extends BaseClientOptions {
  account_id?: string;
}

// Returns a fetch that answers with responses in turn, and the calls it got.
function fake(...responses: (Response | (() => Response))[]): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(input instanceof URL, 'fetch is called with a URL');
    calls.push({
      url: input,
      method: init?.method,
      headers: new Headers(init?.headers),
      body: init?.body,
      signal: init?.signal,
    });
    const next = responses.shift();
    assert.ok(next !== undefined, `unexpected request to ${input.href}`);
    return typeof next === 'function' ? next() : next;
  };
  return { fetch: fetcher as typeof fetch, calls };
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function client(fetcher: typeof fetch, options: Partial<ClientOptions> = {}): Transport {
  const all: ClientOptions = {
    token: 'secret',
    baseUrl: 'https://api.test/v1',
    fetch: fetcher,
    ...options,
  };
  return new Transport(all);
}

const get: Operation = { method: 'GET', route: '/things', response: null };

// Sends a request that fails, and returns the error it rejects with.
async function failure(response: Response, errors?: Operation['errors']): Promise<ApiError> {
  const { fetch } = fake(response);
  const operation: Operation = { ...get };
  if (errors !== undefined) {
    operation.errors = errors;
  }
  const error: unknown = await client(fetch)
    .send(operation, undefined, undefined)
    .catch((e: unknown) => e);
  assert.ok(error instanceof ApiError, 'the call rejects with an ApiError');
  return error;
}

// Returns every item of an async iterable.
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

describe('Transport constructor', () => {
  test('requires a token', () => {
    for (const options of [{}, { token: '' }, { token: 1 }, undefined, null] as unknown as BaseClientOptions[]) {
      assert.throws(() => new Transport(options, 'https://api.test'), {
        name: 'TypeError',
        message: 'createClient: token is required',
      });
    }
  });

  test('requires a base URL', () => {
    for (const [options, fallback] of [
      [{ token: 't' }, undefined],
      [{ token: 't', baseUrl: '' }, undefined],
      [{ token: 't' }, ''],
    ] as const) {
      assert.throws(() => new Transport(options, fallback), {
        name: 'TypeError',
        message: 'createClient: baseUrl is required',
      });
    }
  });

  test('prefers the base URL of the options', async () => {
    const { fetch, calls } = fake(json({}), json({}));
    await new Transport({ token: 't', fetch }, 'https://default.test').send(get, undefined, undefined);
    await new Transport({ token: 't', fetch, baseUrl: 'https://custom.test' }, 'https://default.test').send(
      get,
      undefined,
      undefined,
    );
    assert.equal(calls[0]?.url.href, 'https://default.test/things');
    assert.equal(calls[1]?.url.href, 'https://custom.test/things');
  });

  test('drops trailing slashes of the base URL', async () => {
    const { fetch, calls } = fake(json({}));
    await client(fetch, { baseUrl: 'https://api.test/v1//' }).send(get, undefined, undefined);
    assert.equal(calls[0]?.url.href, 'https://api.test/v1/things');
  });

  test('uses the global fetch by default', async (t) => {
    const { fetch, calls } = fake(json({ ok: true }));
    t.mock.method(globalThis, 'fetch', fetch);
    const transport = new Transport({ token: 't', baseUrl: 'https://a.test' });
    assert.deepEqual(await transport.send(get, undefined, undefined), {
      ok: true,
    });
    assert.equal(calls.length, 1);
  });
});

describe('Transport URL', () => {
  test('fills in path parameters', async () => {
    const { fetch, calls } = fake(json({}));
    await client(fetch).send(
      { method: 'GET', route: '/accounts/{account_id}/items/{id}' },
      { account_id: 'a/b c', id: 7 },
      undefined,
    );
    assert.equal(calls[0]?.url.href, 'https://api.test/v1/accounts/a%2Fb%20c/items/7');
  });

  test('falls back to client options for variables', async () => {
    const operation: Operation = {
      method: 'GET',
      route: '/accounts/{account_id}',
      variables: ['account_id'],
    };
    const { fetch, calls } = fake(json({}), json({}));
    const transport = client(fetch, { account_id: 'client' });
    await transport.send(operation, {}, undefined);
    await transport.send(operation, { account_id: 'request' }, undefined);
    assert.equal(calls[0]?.url.pathname, '/v1/accounts/client');
    assert.equal(calls[1]?.url.pathname, '/v1/accounts/request');
  });

  test('does not fall back for parameters that are not variables', async () => {
    const { fetch, calls } = fake();
    await assert.rejects(
      client(fetch, { account_id: 'client' }).send({ method: 'GET', route: '/accounts/{account_id}' }, {}, undefined),
      {
        name: 'TypeError',
        message: 'account_id is required: set it in the request or the client options',
      },
    );
    assert.equal(calls.length, 0);
  });

  test('rejects missing path parameters', async () => {
    const { fetch } = fake();
    const transport = client(fetch);
    const operation: Operation = {
      method: 'GET',
      route: '/items/{id}',
      variables: ['id'],
    };
    for (const request of [undefined, {}, { id: null }, { id: '' }]) {
      await assert.rejects(transport.send(operation, request, undefined), {
        name: 'TypeError',
        message: 'id is required: set it in the request or the client options',
      });
    }
  });

  test('encodes bytes and objects in parameters', async () => {
    const { fetch, calls } = fake(json({}));
    await client(fetch).send(
      {
        method: 'GET',
        route: '/blobs/{key}',
        query: { filter: 'filter', raw: 'raw' },
      },
      { key: new Uint8Array([0xfb, 0xff]), filter: { a: 1 }, raw: false },
      undefined,
    );
    const url = calls[0]!.url;
    assert.equal(url.pathname, '/v1/blobs/%2B%2F8%3D');
    assert.equal(url.searchParams.get('filter'), '{"a":1}');
    assert.equal(url.searchParams.get('raw'), 'false');
  });

  test('adds query parameters by their wire names', async () => {
    const { fetch, calls } = fake(json({}));
    await client(fetch).send(
      {
        method: 'GET',
        route: '/things',
        query: {
          perPage: 'per_page',
          ids: 'id',
          tags: 'tags',
          missing: 'missing',
          none: 'none',
          empty: 'empty',
        },
        joined: ['tags'],
      },
      {
        perPage: 10,
        ids: [1, 2],
        tags: ['a', 'b'],
        none: null,
        empty: '',
        other: 'x',
      },
      undefined,
    );
    assert.deepEqual(
      [...calls[0]!.url.searchParams],
      [
        ['per_page', '10'],
        ['id', '1'],
        ['id', '2'],
        ['tags', 'a,b'],
        ['empty', ''],
      ],
    );
  });

  test('appends the query of the client, then of the call', async () => {
    const { fetch, calls } = fake(json({}));
    await client(fetch, {
      query: new URLSearchParams('a=client&b=client'),
    }).send(
      { method: 'GET', route: '/things', query: { a: 'a' } },
      { a: 'request' },
      { query: new URLSearchParams('a=call') },
    );
    assert.deepEqual(
      [...calls[0]!.url.searchParams],
      [
        ['a', 'request'],
        ['a', 'client'],
        ['b', 'client'],
        ['a', 'call'],
      ],
    );
  });

  test('keeps the query of the route', async () => {
    const { fetch, calls } = fake(json({}));
    await client(fetch).send(
      { method: 'GET', route: '/things?view=full', query: { page: 'page' } },
      { page: 2 },
      undefined,
    );
    assert.equal(calls[0]?.url.search, '?view=full&page=2');
  });
});

describe('Transport headers', () => {
  test('sends accept and authorization', async () => {
    const { fetch, calls } = fake(json({}));
    await client(fetch).send(get, undefined, undefined);
    const headers = calls[0]!.headers;
    assert.equal(headers.get('accept'), 'application/json');
    assert.equal(headers.get('authorization'), 'Bearer secret');
    assert.equal(headers.has('content-type'), false);
  });

  test('lets the client, then the call, replace headers', async () => {
    const { fetch, calls } = fake(json({}));
    await client(fetch, {
      headers: { accept: 'text/plain', 'x-a': 'client', 'x-b': 'client' },
    }).send(get, undefined, {
      headers: [
        ['x-b', 'call'],
        ['authorization', 'Basic abc'],
      ],
    });
    const headers = calls[0]!.headers;
    assert.equal(headers.get('accept'), 'text/plain');
    assert.equal(headers.get('authorization'), 'Basic abc');
    assert.equal(headers.get('x-a'), 'client');
    assert.equal(headers.get('x-b'), 'call');
  });

  test('passes the method and signal', async () => {
    const { fetch, calls } = fake(json({}), json({}));
    const controller = new AbortController();
    await client(fetch).send({ method: 'DELETE', route: '/things' }, undefined, {
      signal: controller.signal,
    });
    await client(fetch).send(get, undefined, undefined);
    assert.equal(calls[0]?.method, 'DELETE');
    assert.equal(calls[0]?.signal, controller.signal);
    assert.equal(calls[1]?.signal, undefined);
  });
});

describe('Transport body', () => {
  test('sends the fields that are not parameters', async () => {
    const { fetch, calls } = fake(json({}));
    await client(fetch).send(
      {
        method: 'POST',
        route: '/items/{id}',
        query: { dryRun: 'dry_run' },
        body: 'flat',
      },
      { id: 1, dryRun: true, name: 'n', tags: ['a'], note: null },
      undefined,
    );
    assert.equal(calls[0]?.headers.get('content-type'), 'application/json');
    assert.equal(calls[0]?.body, '{"name":"n","tags":["a"],"note":null}');
    assert.equal(calls[0]?.url.search, '?dry_run=true');
  });

  test('sends an empty object for a flat body with no fields', async () => {
    const { fetch, calls } = fake(json({}), json({}));
    const operation: Operation = { method: 'POST', route: '/a', body: 'flat' };
    await client(fetch).send(operation, undefined, undefined);
    await client(fetch).send(operation, {}, undefined);
    assert.equal(calls[0]?.body, '{}');
    assert.equal(calls[1]?.body, '{}');
  });

  test('keeps a __proto__ field in a flat body', async () => {
    const { fetch, calls } = fake(json({}));
    await client(fetch).send(
      { method: 'POST', route: '/a', body: 'flat' },
      JSON.parse('{"__proto__":{"a":1}}') as object,
      undefined,
    );
    assert.equal(calls[0]?.body, '{"__proto__":{"a":1}}');
  });

  test('sends the body field of a nested body', async () => {
    const { fetch, calls } = fake(json({}), json({}));
    const operation: Operation = {
      method: 'PUT',
      route: '/items/{id}',
      body: 'nested',
    };
    await client(fetch).send(operation, { id: 1, body: [1, 2], other: 3 }, undefined);
    await client(fetch).send(operation, { id: 1 }, undefined);
    assert.equal(calls[0]?.body, '[1,2]');
    assert.equal(calls[1]?.body, undefined);
    assert.equal(calls[1]?.headers.has('content-type'), false);
  });

  test('sends no body when the operation has none', async () => {
    const { fetch, calls } = fake(json({}));
    await client(fetch).send(get, { name: 'n', body: {} }, undefined);
    assert.equal(calls[0]?.body, undefined);
    assert.equal(calls[0]?.headers.has('content-type'), false);
  });

  test('encodes the body with the request codec', async () => {
    const { fetch, calls } = fake(json({}));
    await client(fetch).send(
      {
        method: 'POST',
        route: '/events',
        body: 'flat',
        request: object([
          ['createdAt', null, instant],
          ['big_id', 'bigId', int64],
        ]),
      },
      {
        createdAt: Temporal.Instant.from('2024-01-02T03:04:05Z'),
        bigId: 9223372036854775807n,
      },
      undefined,
    );
    assert.equal(calls[0]?.body, '{"createdAt":"2024-01-02T03:04:05Z","big_id":9223372036854775807}');
  });

  test('sends the declared content type', async () => {
    const { fetch, calls } = fake(json({}));
    await client(fetch, { headers: { 'x-a': 'b' } }).send(
      {
        method: 'PATCH',
        route: '/a',
        body: 'nested',
        contentType: 'application/merge-patch+json',
      },
      { body: { a: null } },
      undefined,
    );
    assert.equal(calls[0]?.headers.get('content-type'), 'application/merge-patch+json');
    assert.equal(calls[0]?.body, '{"a":null}');
  });

  test('lets headers replace the content type', async () => {
    const { fetch, calls } = fake(json({}));
    await client(fetch).send(
      { method: 'POST', route: '/a', body: 'nested' },
      { body: {} },
      { headers: { 'content-type': 'application/vnd.test+json' } },
    );
    assert.equal(calls[0]?.headers.get('content-type'), 'application/vnd.test+json');
  });
});

describe('Transport response', () => {
  test('returns the parsed body when there is no codec', async () => {
    const { fetch } = fake(json({ a: [1, 'b'] }));
    assert.deepEqual(await client(fetch).send(get, undefined, undefined), {
      a: [1, 'b'],
    });
  });

  test('decodes the body with the response codec', async () => {
    const { fetch } = fake(new Response('{"big_id":12345678901234567890,"at":"2024-01-02T03:04:05Z"}'));
    const result = await client(fetch).send<{ bigId: bigint; at: unknown }>(
      {
        method: 'GET',
        route: '/a',
        response: object([
          ['big_id', 'bigId', int64],
          ['at', null, instant],
        ]),
      },
      undefined,
      undefined,
    );
    assert.equal(result.bigId, 12345678901234567890n);
    assert.ok(result.at instanceof Temporal.Instant);
  });

  test('returns undefined without reading the body when the operation has no response', async () => {
    const { fetch } = fake(json({ a: 1 }));
    let response: Response | undefined;
    const result = await client(fetch).send({ method: 'POST', route: '/a' }, undefined, {
      onResponse: (r) => (response = r),
    });
    assert.equal(result, undefined);
    assert.equal(response?.bodyUsed, false);
  });

  test('returns undefined for an empty body', async () => {
    const { fetch } = fake(new Response(null, { status: 204 }), new Response(''));
    const transport = client(fetch);
    assert.equal(await transport.send(get, undefined, undefined), undefined);
    assert.equal(await transport.send(get, undefined, undefined), undefined);
  });

  test('calls onResponse before reading the body', async () => {
    const { fetch } = fake(json({ a: 1 }, { status: 201 }));
    const seen: [number, boolean][] = [];
    await client(fetch).send(get, undefined, {
      onResponse: (r) => seen.push([r.status, r.bodyUsed]),
    });
    assert.deepEqual(seen, [[201, false]]);
  });

  test('rejects a body that is not JSON', async () => {
    const { fetch } = fake(new Response('<html>', { status: 200 }));
    const error: unknown = await client(fetch)
      .send(get, undefined, undefined)
      .catch((e: unknown) => e);
    assert.ok(error instanceof ApiError);
    assert.equal(error.message, 'the response body is not valid JSON');
    assert.equal(error.status, 200);
    assert.equal(error.details, '<html>');
    assert.ok(error.cause instanceof SyntaxError);
    assert.equal(error.response.bodyUsed, true);
  });

  test('propagates fetch errors', async () => {
    const cause = new TypeError('network down');
    const transport = client(async () => {
      throw cause;
    });
    await assert.rejects(transport.send(get, undefined, undefined), cause);
  });
});

describe('Transport errors', () => {
  test('rejects statuses outside 2XX', async () => {
    for (const status of [300, 304, 400, 404, 500, 599]) {
      const response = new Response(status === 304 ? null : '', { status });
      const error = await failure(response);
      assert.equal(error.status, status);
      assert.equal(error.response, response);
    }
  });

  test('takes the message from a JSON body', async () => {
    const error = await failure(json({ errors: [{ message: 'a' }, { message: 'b' }] }, { status: 400 }));
    assert.equal(error.message, 'a; b');
    assert.equal(error.details, '{"errors":[{"message":"a"},{"message":"b"}]}');
  });

  test('falls back to the status for the message', async () => {
    const cases: [Response, string][] = [
      [json({ code: 1 }, { status: 409, statusText: 'Conflict' }), '409 Conflict'],
      [new Response('oops', { status: 500, statusText: 'Boom' }), '500 Boom'],
      [new Response('{"message":"m"', { status: 500 }), '500'],
      [new Response('', { status: 502 }), '502'],
    ];
    for (const [response, message] of cases) {
      assert.equal((await failure(response)).message, message);
    }
  });

  test('gives the text of an undeclared error as details', async () => {
    assert.equal((await failure(json({ a: 1 }, { status: 400 }))).details, '{"a":1}');
    assert.equal((await failure(new Response('oops', { status: 400 }))).details, 'oops');
    assert.equal((await failure(new Response('', { status: 400 }))).details, undefined);
  });

  test('decodes a declared error by status, range, then default', async () => {
    const errors: Operation['errors'] = {
      '404': object([['code', 'exact']]),
      '4XX': object([['code', 'range']]),
      default: object([['code', 'fallback']]),
    };
    const body = { code: 1 };
    assert.deepEqual((await failure(json(body, { status: 404 }), errors)).details, { exact: 1 });
    assert.deepEqual((await failure(json(body, { status: 400 }), errors)).details, { range: 1 });
    assert.deepEqual((await failure(json(body, { status: 503 }), errors)).details, { fallback: 1 });
  });

  test('keeps the text of an error that matches no declaration', async () => {
    const error = await failure(json({ a: 1 }, { status: 500 }), {
      '4XX': true,
    });
    assert.equal(error.details, '{"a":1}');
  });

  test('gives the parsed body of an error declared as JSON', async () => {
    const error = await failure(
      new Response('{"id":12345678901234567890,"message":"m"}', {
        status: 400,
      }),
      { '400': true },
    );
    assert.deepEqual(error.details, {
      id: Number('12345678901234567890'),
      message: 'm',
    });
    assert.equal(error.message, 'm');
  });

  test('keeps the text of an error declared as not JSON', async () => {
    const error = await failure(json({ message: 'm' }, { status: 400 }), {
      '4XX': false,
      default: true,
    });
    assert.equal(error.details, '{"message":"m"}');
    assert.equal(error.message, 'm');
  });

  test('keeps the text of a declared error whose body is not JSON', async () => {
    const error = await failure(new Response('oops', { status: 400, statusText: 'Bad Request' }), {
      '400': object([]),
    });
    assert.equal(error.details, 'oops');
    assert.equal(error.message, '400 Bad Request');
  });

  test('gives undefined details for an empty declared error', async () => {
    const error = await failure(new Response(null, { status: 404 }), {
      '404': true,
    });
    assert.equal(error.details, undefined);
  });

  test('ignores inherited keys of the declarations', async () => {
    const errors = Object.create({ '400': true }) as Operation['errors'];
    const error = await failure(json({ a: 1 }, { status: 400 }), errors);
    assert.equal(error.details, '{"a":1}');
  });
});

describe('Transport paginate', () => {
  interface Page {
    items?: number[];
    next?: string | null;
    more?: boolean;
  }

  const cursor: Pagination = {
    items: (r) => (r as Page).items,
    param: 'cursor',
    next: (r) => (r as Page).next,
    more: (r) => (r as Page).more,
  };

  const operation: Operation = {
    method: 'GET',
    route: '/items',
    query: { cursor: 'cursor', limit: 'limit' },
    response: null,
    pagination: cursor,
  };

  test('resolves to the first page', async () => {
    const { fetch, calls } = fake(json({ items: [1], next: 'b', more: true }));
    const page = await client(fetch).paginate<Page, number>(operation, { limit: 1 }, undefined);
    assert.deepEqual(page, { items: [1], next: 'b', more: true });
    assert.equal(calls.length, 1);
  });

  test('iterates the items of every page', async () => {
    const { fetch, calls } = fake(
      json({ items: [1, 2], next: 'b', more: true }),
      json({ items: [3], next: 'c', more: true }),
      json({ items: [4], next: 'd', more: false }),
    );
    const items = await collect(client(fetch).paginate<Page, number>(operation, { limit: 2 }, undefined));
    assert.deepEqual(items, [1, 2, 3, 4]);
    assert.deepEqual(
      calls.map((c) => c.url.search),
      ['?limit=2', '?cursor=b&limit=2', '?cursor=c&limit=2'],
    );
  });

  test('fetches the first page once when awaited and iterated', async () => {
    const { fetch, calls } = fake(json({ items: [1], next: 'b', more: true }), json({ items: [2], more: false }));
    const pages = client(fetch).paginate<Page, number>(operation, undefined, undefined);
    assert.deepEqual(await pages, { items: [1], next: 'b', more: true });
    assert.deepEqual(await collect(pages), [1, 2]);
    assert.equal(calls.length, 2);
  });

  test('stops when there is no next page', async () => {
    for (const last of [
      { items: [2], next: null, more: true },
      { items: [2], more: true },
      { items: [2], next: 'a', more: true },
    ]) {
      const { fetch, calls } = fake(json({ items: [1], next: 'a', more: true }), json(last));
      const items = await collect(client(fetch).paginate<Page, number>(operation, {}, undefined));
      assert.deepEqual(items, [1, 2]);
      assert.equal(calls.length, 2);
    }
  });

  test('continues past pages without items', async () => {
    const { fetch } = fake(
      json({ next: 'b', more: true }),
      json({ items: [], next: 'c', more: true }),
      json({ items: [1], more: false }),
    );
    const items = await collect(client(fetch).paginate<Page, number>(operation, {}, undefined));
    assert.deepEqual(items, [1]);
  });

  test('passes the current param to the pagination', async () => {
    const seen: unknown[] = [];
    const offset: Operation = {
      method: 'GET',
      route: '/items',
      query: { page: 'page' },
      response: null,
      pagination: {
        items: (r) => r as number[],
        param: 'page',
        next: (_, page) => ((page as number | undefined) ?? 1) + 1,
        more: (r, page) => {
          seen.push(page);
          return (r as number[]).length > 0;
        },
      },
    };
    const { fetch, calls } = fake(json([1, 2]), json([3]), json([]));
    const items = await collect(client(fetch).paginate<number[], number>(offset, {}, undefined));
    assert.deepEqual(items, [1, 2, 3]);
    assert.deepEqual(seen, [undefined, 2, 3]);
    assert.deepEqual(
      calls.map((c) => c.url.search),
      ['', '?page=2', '?page=3'],
    );
  });

  test('decodes each page and sends the call options', async () => {
    const { fetch, calls } = fake(json({ items: [1], next_page: 'b' }), json({ items: [2] }));
    const decoded: Operation = {
      ...operation,
      response: object([['next_page', 'nextPage']]),
      pagination: {
        ...cursor,
        next: (r) => (r as { nextPage?: string }).nextPage,
        more: (r) => (r as { nextPage?: string }).nextPage !== undefined,
      },
    };
    const items = await collect(
      client(fetch).paginate<unknown, number>(
        decoded,
        {},
        {
          headers: { 'x-a': 'b' },
        },
      ),
    );
    assert.deepEqual(items, [1, 2]);
    assert.deepEqual(
      calls.map((c) => c.headers.get('x-a')),
      ['b', 'b'],
    );
  });

  test('rejects the iteration when a page fails', async () => {
    const { fetch } = fake(json({ items: [1], next: 'b', more: true }), json({ message: 'gone' }, { status: 410 }));
    const seen: number[] = [];
    await assert.rejects(
      (async () => {
        for await (const item of client(fetch).paginate<Page, number>(operation, {}, undefined)) {
          seen.push(item);
        }
      })(),
      (error: unknown) => error instanceof ApiError && error.status === 410,
    );
    assert.deepEqual(seen, [1]);
  });
});

describe('bodies and responses that are not JSON', () => {
  test('sends a multipart body as form data, leaving its content type to fetch', async () => {
    const { fetch, calls } = fake(new Response(null, { status: 204 }));
    const upload: Operation = {
      method: 'PUT',
      route: '/scripts/{name}',
      body: 'flat',
      encoding: 'multipart',
      request: object([['metadata', null, object([['main_module', 'mainModule']])]]),
    };
    await client(fetch).send(
      upload,
      {
        name: 'demo',
        metadata: { mainModule: 'worker.js' },
        files: [new File(['export default {}'], 'worker.js')],
      },
      undefined,
    );
    const body = calls[0]!.body;
    assert.ok(body instanceof FormData);
    assert.equal(body.get('metadata'), '{"main_module":"worker.js"}');
    assert.equal((body.get('files') as File).name, 'worker.js');
    assert.equal(calls[0]!.headers.has('content-type'), false);
    assert.equal(calls[0]!.url.pathname, '/v1/scripts/demo');
  });

  test('sends a form as URL-encoded fields', async () => {
    const { fetch, calls } = fake(new Response(null, { status: 204 }));
    await client(fetch).send(
      {
        method: 'POST',
        route: '/logos',
        body: 'flat',
        encoding: 'form',
        contentType: 'application/x-www-form-urlencoded',
      },
      { tag: 'a', url: 'https://x.test' },
      undefined,
    );
    assert.ok(calls[0]!.body instanceof URLSearchParams);
    assert.equal(String(calls[0]!.body), 'tag=a&url=https%3A%2F%2Fx.test');
    assert.equal(calls[0]!.headers.get('content-type'), 'application/x-www-form-urlencoded');
  });

  test("sends a raw body as bytes, with a Blob's type or the operation's", async () => {
    const { fetch, calls } = fake(json({ etag: 'e' }), json({ etag: 'f' }));
    const put: Operation = {
      method: 'PUT',
      route: '/objects/{key}',
      body: 'nested',
      encoding: 'raw',
      contentType: 'application/octet-stream',
      response: null,
    };
    const transport = client(fetch);
    assert.deepEqual(await transport.send(put, { key: 'a', body: new Uint8Array([1, 2]) }, undefined), { etag: 'e' });
    await transport.send(put, { key: 'b', body: new Blob(['<p>'], { type: 'text/html' }) }, undefined);
    assert.deepEqual(calls[0]!.body, new Uint8Array([1, 2]));
    assert.equal(calls[0]!.headers.get('content-type'), 'application/octet-stream');
    assert.equal(calls[1]!.headers.get('content-type'), 'text/html');
  });

  test('reads bytes and text, asking for their media types', async () => {
    const { fetch, calls } = fake(new Response(new Uint8Array([0, 255])), new Response('hello'));
    const transport = client(fetch);
    const bytes = await transport.send(
      {
        ...get,
        responseType: 'bytes',
        accept: 'application/octet-stream',
      },
      undefined,
      undefined,
    );
    assert.deepEqual(bytes, new Uint8Array([0, 255]));
    assert.equal(calls[0]!.headers.get('accept'), 'application/octet-stream');
    assert.equal(
      await transport.send({ ...get, responseType: 'text', accept: 'text/plain' }, undefined, undefined),
      'hello',
    );
  });

  test('still reads a JSON error from an operation that returns bytes', async () => {
    const { fetch } = fake(json({ errors: [{ code: 10009, message: 'key not found' }] }, { status: 404 }));
    const error: unknown = await client(fetch)
      .send({ ...get, responseType: 'bytes', errors: { '4XX': true } }, undefined, undefined)
      .catch((e: unknown) => e);
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 404);
  });
});
