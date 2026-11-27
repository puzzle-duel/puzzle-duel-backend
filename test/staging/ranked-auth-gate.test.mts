import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RANKED_AUTH_REQUIRED_ERROR,
  rankedRouteRequiresVerifiedAccount,
} from '../../src/tournament/auth/tournament-http.mts';

test('ranked mutations require verified account; diagnostics/leaderboards do not', () => {
  assert.equal(rankedRouteRequiresVerifiedAccount('/v1/tournament/claims/daily'), true);
  assert.equal(rankedRouteRequiresVerifiedAccount('/v1/tournament/series/x/commands'), true);
  assert.equal(rankedRouteRequiresVerifiedAccount('/v1/tournament/devices/register'), true);
  assert.equal(rankedRouteRequiresVerifiedAccount('/v1/tournament/series/x/writer'), true);
  assert.equal(rankedRouteRequiresVerifiedAccount('/v1/diagnostics/reports'), false);
  assert.equal(rankedRouteRequiresVerifiedAccount('/v1/tournament/leaderboards/daily'), false);
  assert.equal(rankedRouteRequiresVerifiedAccount('/v1/tournament/me/badges'), false);
  assert.equal(rankedRouteRequiresVerifiedAccount('/v1/profile/me/badges'), false);
  assert.equal(RANKED_AUTH_REQUIRED_ERROR, 'RANKED_AUTH_REQUIRED');
});

test('ranked auth gate precedes claim, writer, and gameplay mutation in tournament-http', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../src/tournament/auth/tournament-http.mts'),
    'utf8',
  );
  const guestGate = source.indexOf("identity.accountType === 'guest' && rankedRouteRequiresVerifiedAccount(path)");
  const claimMutate = source.indexOf('claimAndBootstrap');
  const commandAdmit = source.indexOf('writerGenerationHint');
  const recoverWriter = source.indexOf('recover-writer');
  assert.ok(guestGate > 0, 'guest ranked gate present');
  assert.ok(claimMutate > guestGate, 'claim mutation after ranked auth gate');
  assert.ok(commandAdmit > guestGate, 'command admission after ranked auth gate');
  assert.ok(recoverWriter > guestGate, 'writer recovery after ranked auth gate');
  assert.match(source, /RANKED_AUTH_REQUIRED/);
});
