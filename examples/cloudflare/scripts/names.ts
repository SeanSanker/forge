/**
 * Names the query parameters of Cloudflare's OpenAPI document whose names
 * have characters other than letters, digits, `-` and `_`, such as
 * `account.id` and `name~neq`, with Fern's `x-fern-parameter-name`, so the
 * SDK has them as `accountId` and `nameNeq`. Without a name, forge leaves
 * them out, to be sent through a call's `query` option.
 *
 *   node scripts/names.ts IN OUT
 *
 * A name is the parameter's words in camel case. A parameter whose name is
 * a template, such as `meta.<field>[<operator>]`, is left as it is, and so
 * is one whose name would be the same as another query parameter's of the
 * same operation.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined) {
  throw new Error('usage: names.ts IN OUT');
}

type Schema = { [key: string]: unknown };

const doc = JSON.parse(readFileSync(input, 'utf8')) as Schema;
const methods = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

// Follows a `$ref` to a parameter under `components.parameters`.
function resolve(param: Schema): Schema | undefined {
  const ref = param['$ref'];
  if (typeof ref !== 'string') {
    return param;
  }
  const name = ref.match(/^#\/components\/parameters\/(.+)$/)?.[1];
  const params = (doc['components'] as Schema | undefined)?.['parameters'] as Schema | undefined;
  return name === undefined ? undefined : (params?.[name.replace(/~1/g, '/').replace(/~0/g, '~')] as Schema);
}

// `account.id` is `accountId`.
const camel = (name: string) =>
  name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word, i) => (i === 0 ? word[0]!.toLowerCase() : word[0]!.toUpperCase()) + word.slice(1))
    .join('');

const named = new Set<string>();
const skipped = new Set<string>();
for (const item of Object.values(doc['paths'] as Record<string, Schema>)) {
  const shared = (item['parameters'] as Schema[] | undefined) ?? [];
  for (const method of methods) {
    const operation = item[method] as Schema | undefined;
    if (operation === undefined) {
      continue;
    }
    const query = [...((operation['parameters'] as Schema[] | undefined) ?? []), ...shared]
      .map(resolve)
      .filter((p): p is Schema => p?.['in'] === 'query' && typeof p['name'] === 'string');
    const taken = new Map<string, number>();
    for (const param of query) {
      const name = camel(param['name'] as string);
      taken.set(name, (taken.get(name) ?? 0) + 1);
    }
    for (const param of query) {
      const name = param['name'] as string;
      if (/^[A-Za-z0-9_-]+$/.test(name) || param['x-fern-parameter-name'] !== undefined) {
        continue;
      }
      if (/[<>[\]{}]/.test(name) || taken.get(camel(name))! > 1) {
        skipped.add(name);
        continue;
      }
      param['x-fern-parameter-name'] = camel(name);
      named.add(name);
    }
  }
}

writeFileSync(output, JSON.stringify(doc));
console.log(`named ${named.size} query parameters; left out ${[...skipped].join(', ') || 'none'}`);
