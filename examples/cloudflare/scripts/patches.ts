/**
 * Fills in what Cloudflare's OpenAPI document leaves out, so the SDK can
 * send it:
 *
 * - The metadata of a Worker version upload (`POST .../versions`) has no
 *   `assets`, although the API takes it there, as Wrangler's
 *   `versions upload` sends it; the script upload's metadata has it, so it
 *   is copied from there.
 * - Operations the document has but marks `x-fern-ignore`, so no SDK has
 *   them, that a deploy needs: registering a workflow (`PUT
 *   .../workflows/{workflow_name}`), which Wrangler does on deploy,
 *   making a Secrets Store (`POST .../secrets_store/stores`), and a
 *   Worker's event triggers (`GET`, `PUT` and `DELETE .../triggers/{script_name}`),
 *   which start its workflows on Artifacts events, as Wrangler's deploy
 *   replaces them. The mark is taken off.
 *
 *   node scripts/patches.ts IN OUT
 *
 * A patch whose target already has what it adds, as a later document might,
 * changes nothing.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined) {
  throw new Error('usage: patches.ts IN OUT');
}

type Schema = { [key: string]: unknown };

const doc = JSON.parse(readFileSync(input, 'utf8')) as Schema;
const schemas = (doc['components'] as Schema)['schemas'] as Record<string, Schema>;
const paths = doc['paths'] as Record<string, Record<string, Schema>>;

// Follows `$ref`s within the document.
function resolve(value: unknown): Schema | undefined {
  let schema = value as Schema | undefined;
  for (let depth = 0; depth < 32 && typeof schema?.['$ref'] === 'string'; depth++) {
    schema = (schema['$ref'] as string)
      .replace(/^#\//, '')
      .split('/')
      .reduce<unknown>(
        (node, key) => (node as Schema | undefined)?.[key.replace(/~1/g, '/').replace(/~0/g, '~')],
        doc,
      ) as Schema | undefined;
  }
  return schema;
}

// Returns the multipart schema of an operation's request body.
function multipart(path: string, method: string): Schema {
  const body = resolve(paths[path]?.[method]?.['requestBody']);
  const content = body?.['content'] as Record<string, Schema> | undefined;
  const schema = resolve(content?.['multipart/form-data']?.['schema']);
  if (schema === undefined) {
    throw new Error(`${method.toUpperCase()} ${path} has no multipart body`);
  }
  return schema;
}

// Returns the properties of an object schema's `metadata` property.
function metadataProperties(schema: Schema): Record<string, unknown> {
  const metadata = resolve((schema['properties'] as Record<string, Schema> | undefined)?.['metadata']);
  const properties = metadata?.['properties'] as Record<string, unknown> | undefined;
  if (properties === undefined) {
    throw new Error('the schema has no metadata properties');
  }
  return properties;
}

const applied: string[] = [];

const script = schemas['workers_multipart-script'];
if (script === undefined) {
  throw new Error('workers_multipart-script is missing');
}
const versions = metadataProperties(multipart('/accounts/{account_id}/workers/scripts/{script_name}/versions', 'post'));
if (versions['assets'] === undefined) {
  versions['assets'] = metadataProperties(script)['assets'];
  applied.push('assets on version uploads');
}

const unignored: ReadonlyArray<readonly [string, string, string]> = [
  ['/accounts/{account_id}/workflows/{workflow_name}', 'put', 'registering a workflow'],
  ['/accounts/{account_id}/secrets_store/stores', 'post', 'making a Secrets Store'],
  ['/accounts/{account_id}/triggers/{script_name}', 'get', "reading a Worker's event triggers"],
  ['/accounts/{account_id}/triggers/{script_name}', 'put', "replacing a Worker's event triggers"],
  ['/accounts/{account_id}/triggers/{script_name}', 'delete', "deleting a Worker's event triggers"],
];
for (const [path, method, what] of unignored) {
  const operation = paths[path]?.[method];
  if (operation === undefined) {
    throw new Error(`${method.toUpperCase()} ${path} is missing`);
  }
  if (operation['x-fern-ignore'] === true) {
    delete operation['x-fern-ignore'];
    applied.push(what);
  }
}

writeFileSync(output, JSON.stringify(doc));
console.log(`patched: ${applied.join(', ') || 'nothing'}`);
