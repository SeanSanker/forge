# The `effect` target

An experimental target, in a fork of forge: the TypeScript SDK, with an
[Effect](https://effect.website) client next to the Promise client of each
group.

```sh
forge openapi.json --target effect --out sdk
```

## What it writes

Everything the `ts` target writes, unchanged except that each operation in
`client.ts` is exported, plus:

```
_/effect.ts      the Effect transport: sends operations through Effect's HttpClient
_/auth.ts        Auth: bearer, basic, API keys, cached tokens, OAuth2 client credentials
_/paginate.ts    the Streams of paginated methods
effect.ts        the entry point: Api (the client as an Effect service), Auth, ApiError
transport.ts     Transport (what each group's bind sends with, as a service) and Security
<group>/effect.ts  the group's Effect Client and its bind
```

Each method returns `Effect<Response, GetError>`, where its error is a
`ClientError`: `ApiError | AuthError | HttpClientError`. The request and
response types, codecs and operations are the `ts` target's own, so both
clients encode and decode alike.

```ts
import { Effect, Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Api, Auth } from './sdk/effect.js';

const ApiLive = Api.layer({ baseUrl: 'https://api.example.com', auth: Auth.bearer(token) }).pipe(
  Layer.provide(FetchHttpClient.layer),
);

const program = Effect.gen(function* () {
  const api = yield* Api;
  return yield* api.pets.get({ petId: '1' });
}).pipe(Effect.provide(ApiLive));
```

`Api` is an Effect service keyed by `--name`, the name of the SDK's
package, followed by `/Api`, as Effect keys services by their module:

```sh
forge openapi.json --target effect --out sdk --name @acme/pets-sdk   # "@acme/pets-sdk/Api"
```

Without `--name`, the API's title (`info.title`) keys it. Keys must differ
between the SDKs an app uses together; each SDK exports its client as `Api`,
so import each under its own name.

### Only some groups

`effect.ts` imports every group, so a bundle that uses `Api` holds the whole
SDK. A program that uses a few groups, such as a Worker, can bind just those
to `Transport`, from `transport.ts`, and a bundler leaves the others out:

```ts
import { bind as bindKv } from './sdk/kv/effect.js';
import { Transport } from './sdk/transport.js';

const program = Effect.gen(function* () {
  const kv = yield* Effect.map(Transport, bindKv);
  return yield* kv.namespaces.list({ accountId });
}).pipe(Effect.provide(Transport.layer({ auth }).pipe(Layer.provide(FetchHttpClient.layer))));
```

`Transport` has the same `make`, `layer` and `layerConfig` as `Api`, and
`Api` is made from it. For Cloudflare's API, a Worker bundle with the whole
SDK is about 280 KB gzipped; with only KV and D1, about 100 KB.

## Extending a client

Generated files are rewritten each time the SDK is generated, so extend a
client by building on it rather than editing it:

- **A service of your own** on top of `Api`, with your domain's methods and
  errors.
- **An endpoint the document doesn't describe**: send an `Operation` of your
  own with an `EffectTransport`, which the entry point exports.
- **What applies to every request**: `HttpClient` middleware, such as
  retries, headers or logging, or an `Auth` of your own.

```ts
import { EffectTransport, type Operation } from './sdk/effect.js';

const archive: Operation = { method: 'POST', route: '/pets/{petId}/archive', response: undefined };
const archivePet = (petId: string) =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    new EffectTransport(client, options).send<void>(archive, { petId }, undefined),
  );
```

Requests go through the `HttpClient` in context, so its middleware (retries,
timeouts, test clients) applies to every method. Its span for each request
is named after the operation, such as `GET /pets/{petId}`.

## Errors

An error response is an `ApiError`, whose `reason` says which one it is.
Each error response the method declares with a JSON body is a reason named
after its status, with the body, decoded as declared, as its `details`:

```ts
// GET /pets declares a 404 with an Error body.
export type ListError = ClientError<Reason<'NotFound', Error> | Unexpected>;
```

Statuses are named as `NotFound` for 404, `Status418` for one without a
name, `Status4XX` for a range and `Default` for `default`. Anything else,
such as an undeclared status or a body that isn't the declared JSON, is
`Unexpected`, with the body as text.

```ts
api.pets.list().pipe(
  // Handle one reason, with its details typed.
  Effect.catchReason('ApiError', 'NotFound', (reason) => Effect.succeed(reason.details.message)),
);

api.pets.list().pipe(
  // Or put the reasons in the error channel, and handle them by tag.
  Effect.unwrapReason('ApiError'),
  Effect.catchTag('NotFound', (reason) => Effect.succeed([])),
); // fails with Unexpected | AuthError | HttpClientError
```

`Effect.catchTag('ApiError', ...)` still handles every error response.

## Auth

`ClientOptions.auth` takes an `Auth`, which turns each request into an
authenticated one after the client and call headers are set, so a signing
`Auth` signs what is sent. Its headers therefore win over a client or call
header of the same name, where the Promise client lets those headers win.

|                                                                              |                                                                             |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `Auth.bearer(token)`                                                         | `Authorization: Bearer`                                                     |
| `Auth.basic(username, password)`                                             | `Authorization: Basic`                                                      |
| `Auth.apiKey(key, { header } \| { query })`                                  | an API key in a header, which is redacted, or a query parameter             |
| `Auth.oauth2ClientCredentials({ tokenUrl, clientId, clientSecret, scope? })` | gets an access token, keeps it until it expires, gets a new one after a 401 |
| `Auth.cachedToken({ fetch, apply? })`                                        | the same, for any login that trades credentials for a token                 |
| `Auth.make({ authenticate, refresh?, redactedHeaders? })`                    | anything else, such as request signing                                      |

An `Auth` that caches credentials can `refresh` after a 401: the transport
passes it the request that got the 401, then sends the request once more.
`cachedToken` forgets its token only if it is still the one that request
was sent with, so requests that get a 401 at once share one new token.

Secrets can be `Redacted`. An `Auth` can name the headers that hold its
credentials, which Effect then redacts while the request is sent, in
addition to `authorization` and `x-api-key`. A key in the query string is
part of the URL, which tracing records.

### From the document

forge's model doesn't keep a document's security, so the effect target reads
it from the document itself:

- **`Security`**, in the entry point, has a function for each security scheme
  the SDK can authenticate with (HTTP bearer and basic, API keys in a header
  or the query, OAuth2 client credentials), with the scheme's header name or
  token URL filled in. It is named as Fern's `x-fern-bearer` or
  `x-fern-header` names it, or after the scheme.
- **`Api.layerConfig()`** reads the credentials of the scheme the document asks
  for first from the config (environment variables by default) that Fern's
  `env` names, when it names them.
- **An operation whose requirements are all empty**, such as `security: []`,
  sends no credentials.
- **The `baseUrl`** defaults to the document's first server.

```ts
// Cloudflare's document asks for api_token, a bearer token in CLOUDFLARE_API_TOKEN.
const CloudflareLive = Api.layerConfig().pipe(Layer.provide(FetchHttpClient.layer));
// or
const CloudflareLive = Api.layer({ auth: Security.apiToken(token) }).pipe(Layer.provide(FetchHttpClient.layer));
```

## Retries

`ClientOptions.retry` retries requests that are safe to send again: those
whose method is idempotent (`GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`), or
that have an `Idempotency-Key` header. They are retried after a transport
error or timeout, or a 408, 429, 500, 502, 503 or 504 response. Any other
request, such as a `POST` that creates something, is retried only after a
429, which says the request wasn't processed. Retries wait for the
response's `Retry-After`, up to 5 minutes by default, or else for a wait
that doubles each time, and are authenticated again each time, so a signing
`Auth` signs each one afresh.

```ts
Api.layer({ auth, retry: { times: 3, delay: '200 millis', maxRetryAfter: '30 seconds' } });
Api.layer({ auth, retry: true }); // 2 retries, from 250 milliseconds
```

Each attempt waits 60 seconds for a response by default, then fails as a
transport error, which a retry repeats like any other. `timeout` changes it,
and `timeout: false` removes it.

```ts
Api.layer({ auth, retry: true, timeout: '10 seconds' });
```

`HttpClient.retryTransient` retries every method, `POST` too. For rate
limits shared across requests, Effect's `HttpClient.withRateLimiter` reads
the response headers.

## Testing

`Api.layerTest` is a fake client: the stubs answer for the methods they stub,
typed as the client is, and any other method dies, naming its operation, so
a test fails where it calls something it didn't expect.

```ts
const FakeApi = Api.layerTest({
  pets: { get: ({ petId }) => Effect.succeed({ id: BigInt(petId), name: 'Rex' }) },
});
// api.pets.list() dies with "GET /pets isn't stubbed".
```

A stub fails as the real client would with `ApiError.fake`, which makes the
ApiError of a reason, with a stand-in response:

```ts
const FakeApi = Api.layerTest({
  pets: {
    get: () => Effect.fail(ApiError.fake({ _tag: 'NotFound', status: 404, details: { message: 'no such pet' } })),
  },
});
```

## Pagination

A method with Fern's
[`x-fern-pagination`](https://buildwithfern.com/learn/api-definitions/openapi/extensions/pagination)
gets a twin named with `All`, which returns a `Stream` of every item of every
page and takes the request without the field that picks the page, if any. Pages are
fetched as the stream is read.

- **cursor**: `cursor` names the request parameter, `next_cursor` where the
  response has the next cursor. The stream stops when there is none, or when
  it doesn't change.
- **offset**: `offset` names the request parameter. Without `step` it's a page
  number from 1; with `step`, the parameter of the page size, it's the index
  of the first item, from 0. The stream stops when `has-next-page` is false,
  or else on an empty page or one shorter than the page size, or a page the
  same as the one before. Deleting items while streaming pages by number
  makes the stream skip some, so collect them first.
- **next_uri** and **next_path**: where the response has a link to the next
  page: a URL, which may be relative to the base URL, or a path that follows
  the base URL. The stream stops when there is none, or when it doesn't
  change. A link is followed only on the base URL's origin, so a response
  can't send the client's credentials to another host: one elsewhere is a
  defect.

`results` names the array of items, whose type is the item type of the
Stream. Paths are checked against the method's parameters and its response
type when the SDK is generated, and an extension forge can't follow is an
error.

## The runtime

`lib/` holds the runtime's sources, which forge embeds. In an SDK they sit in
`_/` next to the TypeScript runtime, which they import, so `lib/tsconfig.json`
and `lib/test/register.ts` resolve those imports to `../ts/lib/src`.

```sh
cd src/bin/forge/effect/lib
pnpm typecheck
pnpm test
```
