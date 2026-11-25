import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  accountClassForPlayer,
  isFamilyId,
  linkChallengeBinding,
  mintStagingAccessJwt,
} from '../../src/staging/staging-access-token.mts';

test('family id validation and link binding include player and family', () => {
  const family = '11111111-1111-4111-8111-111111111111';
  const player = '22222222-2222-4222-8222-222222222222';
  assert.equal(isFamilyId(family), true);
  assert.equal(isFamilyId('not-a-uuid'), false);
  assert.equal(linkChallengeBinding(player, family), `link:${player}:${family}`);
});

test('minted access JWT embeds fid and account_type', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const family = '11111111-1111-4111-8111-111111111111';
  const player = '22222222-2222-4222-8222-222222222222';
  const token = mintStagingAccessJwt({
    privateKey,
    keyId: 'k',
    playerId: player,
    familyId: family,
    accountType: 'guest',
    now: new Date('2026-11-25T00:00:00.000Z'),
  });
  const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
  assert.equal(claims.fid, family);
  assert.equal(claims.sub, player);
  assert.equal(claims.account_type, 'guest');
});

test('accountClassForPlayer uses schema readiness flag instead of catching undefined-column', async () => {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [{ account_class: 'verified' }], rowCount: 1 };
    },
  };
  assert.equal(await accountClassForPlayer(client as never, 'p', false), 'guest');
  assert.deepEqual(queries, []);
  assert.equal(await accountClassForPlayer(client as never, 'p', true), 'verified');
  assert.equal(queries.length, 1);
});
