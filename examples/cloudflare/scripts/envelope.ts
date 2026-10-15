/**
 * The envelope hook of the SDK, which scripts/generate.sh puts in place of
 * forge's default in sdk/_/hooks/.
 *
 * Cloudflare wraps each payload in an envelope:
 * `{ success, errors, messages, result, result_info? }`. The document that
 * forge publishes describes a single result without it, and a list with its
 * `result` and `result_info`. So this hook returns a result that isn't an
 * array, with the envelope's `result_info` beside it when it is an object,
 * and keeps the envelope of a result that is an array.
 *
 * The hook only sees the response, not how the document describes it, so
 * the few operations whose document gives a bare array (about 20 of 3,600)
 * get their envelope too.
 */
export function unwrapEnvelope(_response: Response, body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return body;
  }
  const envelope = body as { [key: string]: unknown };
  if (typeof envelope['success'] !== 'boolean' || !('result' in envelope) || Array.isArray(envelope['result'])) {
    return body;
  }
  const result = envelope['result'];
  // An object result keeps the envelope's result_info beside it, where some
  // listings, such as R2 buckets, have their next cursor.
  const info = envelope['result_info'];
  if (
    typeof result === 'object' &&
    result !== null &&
    !Array.isArray(result) &&
    typeof info === 'object' &&
    info !== null
  ) {
    return { ...result, result_info: info };
  }
  return result;
}
