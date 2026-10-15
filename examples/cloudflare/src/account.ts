import { Config, Effect, Layer, Option, Stream } from 'effect';

import { Api } from '../sdk/effect.js';
import { Account } from './tour.js';

/**
 * The account from CLOUDFLARE_ACCOUNT_ID, or else the token's first
 * account. `found` is told its id.
 */
export const accountLayer = (found?: (id: string) => void) =>
  Layer.effect(
    Account,
    Effect.gen(function* () {
      const configured = yield* Config.option(Config.String('CLOUDFLARE_ACCOUNT_ID'));
      const id = Option.isSome(configured)
        ? configured.value
        : yield* (yield* Api).accounts.listAll().pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.flatMap(([account]) =>
              account === undefined ? Effect.die(new Error('the token has no account')) : Effect.succeed(account.id),
            ),
          );
      found?.(id);
      return Account.of({ id });
    }),
  );
