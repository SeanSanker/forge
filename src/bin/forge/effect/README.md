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

Secrets can be `Redacted`. An `Auth` can name the headers that hold its
credentials, which Effect then redacts while the request is sent, in
addition to `authorization` and `x-api-key`. A key in the query string is
part of the URL, which tracing records.

## Pagination

A method with Fern's
[`x-fern-pagination`](https://buildwithfern.com/learn/api-definitions/openapi/extensions/pagination)
gets a twin named with `All`, which returns a `Stream` of every item of every
page and takes the request without the field that picks the page. Pages are
fetched as the stream is read.

- **cursor**: `cursor` names the request parameter, `next_cursor` where the
  response has the next cursor. The stream stops when there is none, or when
  it doesn't change.
- **offset**: `offset` names the request parameter. Without `step` it's a page
  number from 1; with `step`, the parameter of the page size, it's the index
  of the first item, from 0. The stream stops when `has-next-page` is false,
  or else on an empty page or one shorter than the page size.

`results` names the array of items, whose type is the item type of the
Stream. Paths are checked against the method's parameters and its response
type when the SDK is generated, and an extension forge can't follow is an
error. `next_uri`, `next_path` and other kinds of pagination aren't covered.

## The runtime

`lib/` holds the runtime's sources, which forge embeds. In an SDK they sit in
`_/` next to the TypeScript runtime, which they import, so `lib/tsconfig.json`
and `lib/test/register.ts` resolve those imports to `../ts/lib/src`.

```sh
cd src/bin/forge/effect/lib
pnpm typecheck
pnpm test
```
