import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RANKED_AUTH_REQUIRED_ERROR,
  rankedRouteRequiresVerifiedAccount,
} from '../../src/tournament/auth/tournament-http.mts';

test('ranked mutations require verified account; diagnostics/leaderboards do not', () => {
  assert.equal(rankedRouteRequiresVerifiedAccount('/v1/tournament/claims/daily'), true);
  assert.equal(rankedRouteRequiresVerifiedAccount('/v1/tournament/series/x/commands'), true);
  assert.equal(rankedRouteRequiresVerifiedAccount('/v1/tournament/devices/register'), true);
  assert.equal(rankedRouteRequiresVerifiedAccount('/v1/diagnostics/reports'), false);
  assert.equal(rankedRouteRequiresVerifiedAccount('/v1/tournament/leaderboards/daily'), false);
  assert.equal(rankedRouteRequiresVerifiedAccount('/v1/tournament/me/badges'), false);
  assert.equal(RANKED_AUTH_REQUIRED_ERROR, 'RANKED_AUTH_REQUIRED');
});
