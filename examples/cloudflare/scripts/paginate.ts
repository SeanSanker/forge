/**
 * Adds Fern's `x-fern-pagination` to the list operations of Cloudflare's
 * OpenAPI document, which pages them but doesn't say so, so the effect
 * target gives each an `All` twin that streams every item.
 *
 *   node scripts/paginate.ts IN OUT
 *
 * A list operation here is a GET with a `page` query parameter whose 200
 * response is an object with a `result` array: it pages by page number, from
 * 1, until a page is empty. Only a `result` that is plainly an array counts,
 * as the generator checks the paths it is given.
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

let added = 0;
for (const item of Object.values(doc['paths'] as Schema)) {
  const operation = resolve((item as Schema)['get']);
  if (operation === undefined || operation['x-fern-pagination'] !== undefined) {
    continue;
  }
  const parameters = [
    ...(((item as Schema)['parameters'] as unknown[] | undefined) ?? []),
    ...((operation['parameters'] as unknown[] | undefined) ?? []),
  ];
  const pages = parameters.map(resolve).some((p) => p?.['in'] === 'query' && p['name'] === 'page');
  const body = resolve(at(operation, 'responses', '200', 'content', 'application/json', 'schema'));
  if (pages && isArray(property(body, 'result'))) {
    operation['x-fern-pagination'] = { offset: '$request.page', results: '$response.result' };
    added++;
  }
}

writeFileSync(output, JSON.stringify(doc));
console.log(`x-fern-pagination added to ${added} operations`);
