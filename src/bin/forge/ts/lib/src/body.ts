/**
 * Request bodies that are not JSON: multipart, form and raw ones, which
 * the Promise and Effect transports both send.
 */

/**
 * A binary value a request sends: a part of a multipart body, or a raw
 * body. A File's name is the part's filename. A string is sent as UTF-8.
 */
export type BinaryInput = Blob | Uint8Array | ArrayBuffer | string;

/**
 * How a request body that is not JSON is sent: as multipart form data,
 * URL-encoded form fields, or the value itself.
 */
export type Encoding = 'multipart' | 'form' | 'raw';

function isBinary(value: unknown): value is Blob | Uint8Array | ArrayBuffer {
  return value instanceof Blob || value instanceof Uint8Array || value instanceof ArrayBuffer;
}

// The text of a field that is not binary: a string as it is, and anything
// else, such as an object, as JSON.
function text(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return JSON.stringify(value);
}

/**
 * Returns the fields of a body as multipart form data: each field a part,
 * an array a part for each element, a binary value a file, and anything
 * else text, with objects as JSON. A string in one of the `files` fields,
 * by wire name, is a file too. Undefined fields are left out.
 */
export function formData(fields: { readonly [field: string]: unknown }, files: readonly string[] = []): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === undefined) {
        continue;
      }
      if (item instanceof Blob) {
        form.append(name, item, item instanceof File ? item.name : name);
      } else if (isBinary(item) || (typeof item === 'string' && files.includes(name))) {
        form.append(name, new Blob([item as Uint8Array<ArrayBuffer> | ArrayBuffer | string]), name);
      } else {
        form.append(name, text(item));
      }
    }
  }
  return form;
}

/**
 * Returns the fields of a body as URL-encoded form fields, an array as the
 * field repeated, and objects as JSON. Undefined fields are left out.
 */
export function urlEncoded(fields: { readonly [field: string]: unknown }): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) {
        params.append(name, text(item));
      }
    }
  }
  return params;
}

/**
 * Returns a raw body as bytes, with its content type: a Blob's own type
 * when it has one, and otherwise `contentType`.
 */
export async function rawBytes(
  value: BinaryInput,
  contentType: string | undefined,
): Promise<{ readonly bytes: Uint8Array; readonly contentType: string | undefined }> {
  if (value instanceof Blob) {
    return { bytes: new Uint8Array(await value.arrayBuffer()), contentType: value.type || contentType };
  }
  if (value instanceof ArrayBuffer) {
    return { bytes: new Uint8Array(value), contentType };
  }
  if (typeof value === 'string') {
    return { bytes: new TextEncoder().encode(value), contentType };
  }
  return { bytes: value, contentType };
}
