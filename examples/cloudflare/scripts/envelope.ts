/**
 * The envelope hook of the SDK, which scripts/generate.sh puts in place of
 * forge's default in sdk/_/hooks/.
 *
 * Cloudflare wraps each payload in an envelope:
 * `{ success, errors, messages, result, result_info? }`. The document that
 * forge publishes describes a single result without it, and a list with its
 * `result` and `result_info`. So this hook returns a result that isn't an
 * array, and keeps the envelope of one that is.
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
  return envelope['result'];
}
