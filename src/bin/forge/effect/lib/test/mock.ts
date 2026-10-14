import assert from 'node:assert/strict';

import { Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';

/**
 * A request the mock HttpClient got.
 */
export interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * Returns an HttpClient that answers each request with `handler`, its
 * layer, and the requests it got.
 */
export function mockWith(handler: (request: Sent, index: number) => Response) {
  const sent: Sent[] = [];
  const client = HttpClient.make((request, url) => {
    const body = request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : undefined;
    const entry = { method: request.method, url: url.href, headers: { ...request.headers }, body };
    sent.push(entry);
    return Effect.succeed(HttpClientResponse.fromWeb(request, handler(entry, sent.length - 1)));
  });
  return { sent, client, layer: Layer.succeed(HttpClient.HttpClient, client) };
}

/**
 * Returns a mock that answers with `responses`, in order.
 */
export function mock(...responses: Response[]) {
  return mockWith(() => {
    const response = responses.shift();
    assert.ok(response, 'no response left');
    return response;
  });
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
