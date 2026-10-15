import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Effect } from 'effect';

import { ApiError } from '../sdk/effect.js';
import { catchCode } from '../src/cloudflare.js';

const failure = (code: number) =>
  ApiError.fake({ _tag: 'Status4XX', status: 400, details: { errors: [{ code, message: `code ${code}` }] } });

test('catchCode handles its code, and fails with any other error as it is', async () => {
  const handled = await Effect.runPromise(
    Effect.fail(failure(10013)).pipe(catchCode(10013, (error) => Effect.succeed(error.details.errors[0]!.message))),
  );
  assert.equal(handled, 'code 10013');

  const other = await Effect.runPromise(
    Effect.result(Effect.fail(failure(10014)).pipe(catchCode(10013, () => Effect.succeed('no')))),
  );
  assert.ok(other._tag === 'Failure' && other.failure instanceof ApiError);
  assert.equal(other.failure.message, 'code 10014');
});
