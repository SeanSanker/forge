/**
 * Pagination for the generated Effect clients: each paginated method has a
 * twin, named with `All`, that returns a Stream of every item of every
 * page. Pages are fetched as the stream is read, so taking 5 items fetches
 * one page.
 *
 * A method pages as its `x-fern-pagination` describes:
 *
 * - `cursor`: the request field `cursor` picks the page, and the response
 *   has the next page's cursor at `nextCursor`. The last page has none.
 * - `offset`: the request field `offset` picks the page. Without `step`
 *   it's a page number, from 1. With `step`, the request field holding the
 *   page size, it's the index of the page's first item, from 0. The last
 *   page has `hasNextPage` false when the response has it, and is otherwise
 *   empty, or shorter than the page size. A page with the same items as the
 *   one before also ends the stream, without them, as an API that ignores
 *   the request field would return it forever.
 * - `uri` and `path`: the response has a link to the next page at `next`: a
 *   URL, which may be relative to the base URL, or a path that follows the
 *   base URL. The last page has none. Links are followed only on the base
 *   URL's origin.
 *
 * Fields and paths are the TypeScript names of the fields, as the codecs
 * rename them.
 */

import { Effect, Option, Stream } from 'effect';

import type { ClientError, EffectTransport, RequestOptions, SendOptions } from './effect.js';
import type { Operation } from './index.js';

/**
 * How a method pages.
 */
export type Pagination =
  | {
      readonly kind: 'cursor';
      readonly cursor: string;
      readonly nextCursor: readonly string[];
      readonly results: readonly string[];
    }
  | {
      readonly kind: 'offset';
      readonly offset: string;
      readonly results: readonly string[];
      readonly step?: string;
      readonly hasNextPage?: readonly string[];
    }
  | Link<'uri'>
  | Link<'path'>;

interface Link<K extends 'uri' | 'path'> {
  readonly kind: K;
  readonly next: readonly string[];
  readonly results: readonly string[];
}

type Fields = { readonly [key: string]: unknown };

function get(value: unknown, path: readonly string[]): unknown {
  for (const key of path) {
    if (typeof value !== 'object' || value === null) {
      return undefined;
    }
    value = (value as Fields)[key];
  }
  return value;
}

function items(response: unknown, pagination: Pagination): readonly unknown[] {
  const value = get(response, pagination.results);
  return Array.isArray(value) ? value : [];
}

/**
 * Returns a Stream of every item of every page of `operation`, from the
 * page that `request` picks, or the first.
 */
export function paginate<I, E extends ClientError = ClientError>(
  transport: EffectTransport,
  operation: Operation,
  pagination: Pagination,
  request: object | undefined,
  options: RequestOptions | undefined,
  sending?: SendOptions,
): Stream.Stream<I, E> {
  const fields = (request ?? {}) as Fields;
  const fetch = (param: string, value: unknown) =>
    transport.send<unknown, E>(
      operation,
      value === undefined ? fields : { ...fields, [param]: value },
      options,
      sending,
    );

  if (pagination.kind === 'uri' || pagination.kind === 'path') {
    const { kind } = pagination;
    return Stream.paginate(undefined as string | undefined, (at) =>
      Effect.map(
        transport.send<unknown, E>(
          operation,
          fields,
          options,
          at === undefined ? sending : { ...sending, link: kind === 'uri' ? { uri: at } : { path: at } },
        ),
        (response) => {
          const next = get(response, pagination.next);
          const page = items(response, pagination) as readonly I[];
          // A link that doesn't move would fetch the same page forever.
          const more = typeof next === 'string' && next !== '' && next !== at;
          return [page, more ? Option.some(next) : Option.none()] as const;
        },
      ),
    );
  }

  if (pagination.kind === 'cursor') {
    return Stream.paginate(fields[pagination.cursor], (cursor: unknown) =>
      Effect.map(fetch(pagination.cursor, cursor), (response) => {
        const next = get(response, pagination.nextCursor);
        // A cursor that doesn't move would fetch the same page forever.
        const more = (typeof next === 'string' && next !== '') || typeof next === 'number';
        const page = items(response, pagination) as readonly I[];
        return [page, more && next !== cursor ? Option.some(next) : Option.none()] as const;
      }),
    );
  }

  const { offset, step, hasNextPage } = pagination;
  const size = step === undefined ? undefined : fields[step];
  const first = (fields[offset] ?? (step === undefined ? 1 : 0)) as number;
  return Stream.paginate({ at: first, last: undefined as string | undefined }, ({ at, last }) =>
    Effect.map(fetch(offset, at), (response) => {
      const page = items(response, pagination) as readonly I[];
      // A page the same as the one before means the API ignores the
      // request field, and would return it forever.
      const seen = page.length > 0 ? fingerprint(page) : undefined;
      if (seen !== undefined && seen === last) {
        return [[] as readonly I[], Option.none()] as const;
      }
      const more =
        page.length > 0 &&
        (hasNextPage !== undefined
          ? get(response, hasNextPage) === true
          : typeof size !== 'number' || page.length >= size);
      const next = step === undefined ? at + 1 : at + (typeof size === 'number' ? size : page.length);
      return [page, more ? Option.some({ at: next, last: seen }) : Option.none()] as const;
    }),
  );
}

// Returns a string that is the same for pages with the same items.
function fingerprint(page: readonly unknown[]): string {
  return JSON.stringify(page, (_, value: unknown) => (typeof value === 'bigint' ? `${value}n` : value));
}
