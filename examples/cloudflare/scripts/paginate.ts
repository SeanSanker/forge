/**
 * Adds Fern's `x-fern-pagination` to the list operations of Cloudflare's
 * OpenAPI document, which pages them but doesn't say so, so the effect
 * target gives each an `All` twin that streams every item.
 *
 *   node scripts/paginate.ts IN OUT
 *
 * A list operation here is a GET whose 200 response is an object with a
 * `result` array, and that pages one of two ways:
 *
 * - by cursor, when it has a `cursor` query parameter and its response has
 *   the next page's cursor at `result_info.cursor`, until there is none;
 * - otherwise by page number, from 1, when it has a `page` query parameter,
 *   until a page is empty.
 *
 * Only a `result` that is plainly an array counts, as the generator checks
 * the paths it is given.
 *
 * The document describes a single result without Cloudflare's envelope, so
 * a listing whose result is an object with one array pages by cursor too,
 * when it has a `cursor` query parameter and either the object has the next
 * cursor (as `cursor`, `next_cursor` or `nextCursor`), or Cloudflare's docs
 * say the envelope's `result_info.cursor` has it, as for R2 buckets.
 * scripts/envelope.ts keeps `result_info` beside such a result, and this
 * adds it to the response's schema.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined) {
  throw new Error('usage: paginate.ts IN OUT');
}

type Schema = { [key: string]: unknown };

const doc = JSON.parse(readFileSync(input, 'utf8')) as Schema;

// Follows `$ref`s within the document.
function resolve(value: unknown): Schema | undefined {
  let schema = value;
  for (let depth = 0; depth < 32; depth++) {
    if (typeof schema !== 'object' || schema === null) {
      return undefined;
    }
    const ref = (schema as Schema)['$ref'];
    if (typeof ref !== 'string') {
      return schema as Schema;
    }
    schema = ref
      .replace(/^#\//, '')
      .split('/')
      .reduce<unknown>((node, key) => (node as Schema | undefined)?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
  }
  return undefined;
}

// Returns the property `name` of an object schema, or of a member of its
// `allOf`.
function property(schema: Schema | undefined, name: string): Schema | undefined {
  if (schema === undefined) {
    return undefined;
  }
  const own = resolve((schema['properties'] as Schema | undefined)?.[name]);
  if (own !== undefined) {
    return own;
  }
  for (const member of (schema['allOf'] as unknown[] | undefined) ?? []) {
    const found = property(resolve(member), name);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

// Returns the value at `keys` in `value`, or undefined.
const at = (value: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((node, key) => (node as Schema | undefined)?.[key], value);

const isArray = (schema: Schema | undefined) =>
  schema !== undefined &&
  (schema['type'] === 'array' || ('items' in schema && !('anyOf' in schema || 'oneOf' in schema)));

const isString = (schema: Schema | undefined) => schema !== undefined && schema['type'] === 'string';

// The fields an object result can hold its next cursor in.
const cursorFields = ['cursor', 'next_cursor', 'nextCursor'];

// Listings whose next cursor is in the envelope's result_info, beside an
// object result, as Cloudflare's API docs show.
const cursorInResultInfo = new Set(['/accounts/{account_id}/r2/buckets']);

const added = { cursor: 0, offset: 0 };
for (const [path, item] of Object.entries(doc['paths'] as Schema)) {
  const operation = resolve((item as Schema)['get']);
  if (operation === undefined || operation['x-fern-pagination'] !== undefined) {
    continue;
  }
  const parameters = [
    ...(((item as Schema)['parameters'] as unknown[] | undefined) ?? []),
    ...((operation['parameters'] as unknown[] | undefined) ?? []),
  ];
  const query = (name: string) => parameters.map(resolve).some((p) => p?.['in'] === 'query' && p['name'] === name);
  const body = resolve(at(operation, 'responses', '200', 'content', 'application/json', 'schema'));
  if (!isArray(property(body, 'result'))) {
    if (body === undefined || !query('cursor')) {
      continue;
    }
    const arrays = Object.keys((body['properties'] as Schema | undefined) ?? {}).filter((k) =>
      isArray(property(body, k)),
    );
    const next = cursorFields.find((k) => isString(property(body, k)));
    if (arrays.length !== 1) {
      continue;
    }
    if (next !== undefined) {
      operation['x-fern-pagination'] = {
        cursor: '$request.cursor',
        next_cursor: `$response.${next}`,
        results: `$response.${arrays[0]}`,
      };
      added.cursor++;
    } else if (cursorInResultInfo.has(path)) {
      const content = at(operation, 'responses', '200', 'content', 'application/json') as Schema;
      content['schema'] = {
        allOf: [
          content['schema'],
          {
            type: 'object',
            properties: { result_info: { type: 'object', properties: { cursor: { type: 'string' } } } },
          },
        ],
      };
      operation['x-fern-pagination'] = {
        cursor: '$request.cursor',
        next_cursor: '$response.result_info.cursor',
        results: `$response.${arrays[0]}`,
      };
      added.cursor++;
    }
    continue;
  }
  if (query('cursor') && isString(property(property(body, 'result_info'), 'cursor'))) {
    operation['x-fern-pagination'] = {
      cursor: '$request.cursor',
      next_cursor: '$response.result_info.cursor',
      results: '$response.result',
    };
    added.cursor++;
  } else if (query('page')) {
    operation['x-fern-pagination'] = { offset: '$request.page', results: '$response.result' };
    added.offset++;
  }
}

writeFileSync(output, JSON.stringify(doc));
console.log(`x-fern-pagination added to ${added.cursor} operations by cursor, ${added.offset} by page number`);
