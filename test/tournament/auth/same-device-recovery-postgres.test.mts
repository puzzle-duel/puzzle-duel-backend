import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

import { PostgresVerifiedIdentitySessionStore } from '../../../src/tournament/auth/postgres-verified-sessions.mts';
import { AtomicDailyClaimBootstrap } from '../../../src/tournament/claims/atomic-claim-bootstrap.mts';
import { PostgresSameDeviceRecovery } from '../../../src/tournament/auth/postgres-same-device-recovery.mts';
import { canonicalDeviceRecoveryProof } from '../../../src/tournament/auth/device-recovery-proof.mts';
import {
  PinnedManifestRegistry, digestManifestPayload,
} from '../../../src/tournament/claims/pinned-manifest-registry.mts';

const url = process.env.PZD_INGRESS_DATABASE_URL;
assert.ok(url, 'PostgreSQL 18 required; never skip recovery tests');

function manifest() {
  const fixture = JSON.parse(readFileSync(
    'docs/contracts/gameplay/v3/fixtures/V3-01-legal-placement.json', 'utf8',
  )) as {initialState: unknown};
  const subgames = [1,2,3,4,5,6].map(ordinal => ({
    ordinal, challengeId: `recovery-${ordinal}`,
    generatorVersion: 'gen-001.v1-adapter-test',
    contentVersion: 'recovery-test',
    initialState: fixture.initialState,
  }));
  const contentVersion = 'recovery-test-manifest';
  const digest = digestManifestPayload(contentVersion, subgames);
  return new PinnedManifestRegistry([{digest, contentVersion, subgames}], digest);
}

async function setup() {
  const pool = new pg.Pool({connectionString:url, max:12});
  for(const sql of [
    'DROP TABLE IF EXISTS tournament_writer_recovery_challenge',
    'ALTER TABLE IF EXISTS tournament_series_writer DROP COLUMN IF EXISTS original_device_credential_id',
    'ALTER TABLE IF EXISTS tournament_auth_session DROP COLUMN IF EXISTS device_credential_id',
    'DROP TABLE IF EXISTS tournament_device_credential',
    'DROP TABLE IF EXISTS tournament_series_writer',
    'DROP TABLE IF EXISTS authoritative_game_snapshot',
    'DROP TABLE IF EXISTS accepted_move_ledger',
    'DROP TABLE IF EXISTS trusted_challenge_binding',
    'DROP TABLE IF EXISTS series_fence_state',
    'DROP TABLE IF EXISTS tournament_daily_claim CASCADE',
    'DROP TABLE IF EXISTS command_admission_journal',
    'DROP TABLE IF EXISTS tournament_auth_session',
    'DROP TABLE IF EXISTS tournament_verified_identity',
  ]) await pool.query(sql);
  const sessions = new PostgresVerifiedIdentitySessionStore(pool);
  await sessions.migrate();
  const claims = new AtomicDailyClaimBootstrap(pool, manifest(), {
    anchorOriginalDevice: true,
  });
  await claims.migrate();
  const recovery = new PostgresSameDeviceRecovery(pool);
  await recovery.migrate();
  async function open(sub: string) {
    return sessions.openAfterVerifiedJwt({
      issuer:'https://test.example.org', subject:sub,
      issuedAt:Math.floor(Date.now()/1000)-5,
      expiresAt:Math.floor(Date.now()/1000)+300,
      keyId:'server-verified',
    });
  }
  async function cleanup() {
    for(const sql of [
      'DROP TABLE IF EXISTS tournament_writer_recovery_challenge',
      'ALTER TABLE IF EXISTS tournament_series_writer DROP COLUMN IF EXISTS original_device_credential_id',
      'ALTER TABLE IF EXISTS tournament_auth_session DROP COLUMN IF EXISTS device_credential_id',
      'DROP TABLE IF EXISTS tournament_device_credential',
    ]) await pool.query(sql);
    await pool.end();
  }
  return {pool, sessions, claims, recovery, open, cleanup};
}

function keypair() {
  const pair = generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const der = pair.publicKey.export({type:'spki',format:'der'});
  return { privateKey:pair.privateKey, der };
}

async function register(
  env: Awaited<ReturnType<typeof setup>>,
  session: Awaited<ReturnType<typeof env.open>>,
  key: ReturnType<typeof keypair>,
) {
  const keyHash = createHash('sha256').update(key.der).digest('hex');
  const message = [
    'PZD-REGISTER-DEVICE-V1',session.playerId,session.sessionId,keyHash,
  ].join('\n');
  const result = await env.recovery.registerKey({
    session,
    spkiBase64Url:key.der.toString('base64url'),
    signatureBase64Url:sign('sha256',Buffer.from(message),key.privateKey)
      .toString('base64url'),
  });
  assert.equal(result.ok,true,JSON.stringify(result));
  if(!result.ok) throw new Error('registration failed');
  return result.data.deviceCredentialId;
}

async function firstClaim(env: Awaited<ReturnType<typeof setup>>,
  session: Awaited<ReturnType<typeof env.open>>) {
  const claim = await env.claims.claimAndBootstrap({
    session,
    originalUtcDate:new Date().toISOString().slice(0,10),
  });
  assert.equal(claim.ok,true,JSON.stringify(claim));
  if(!claim.ok) throw new Error('claim failed');
  assert.equal(claim.original,true);
  return claim.claim.seriesId;
}

async function recoveryProof(
  env: Awaited<ReturnType<typeof setup>>,
  session: Awaited<ReturnType<typeof env.open>>,
  seriesId: string,
  key: ReturnType<typeof keypair>,
) {
  const result = await env.recovery.issueChallenge({session,seriesId});
  assert.equal(result.ok,true,JSON.stringify(result));
  if(!result.ok) throw new Error('challenge failed');
  const c = result.data;
  const proof = {
    playerId:session.playerId,
    seriesId,
    newSessionId:session.sessionId,
    deviceCredentialId:c.deviceCredentialId,
    challengeId:c.challengeId,
    nonce:c.nonce,
    expectedWriterGeneration:c.expectedWriterGeneration,
    expiresAtMs:c.expiresAtMs,
  };
  const signatureBase64Url = sign(
    'sha256', Buffer.from(canonicalDeviceRecoveryProof(proof)), key.privateKey,
  ).toString('base64url');
  return {session,seriesId,proof,signatureBase64Url};
}

test('same registered device can recover once; exact retries are idempotent', async()=>{
  const env=await setup();
  try {
    const key=keypair(),original=await env.open('player-a');
    const credentialId=await register(env,original,key);
    const seriesId=await firstClaim(env,original);
    const writer=await env.pool.query(
      'SELECT original_device_credential_id FROM tournament_series_writer WHERE series_key=$1',
      [seriesId],
    );
    assert.equal(writer.rows[0].original_device_credential_id,credentialId);
    const newSession=await env.open('player-a');
    assert.equal(newSession.playerId,original.playerId);
    await register(env,newSession,key);
    const before=await env.pool.query(
      'SELECT idle_deadline_at_ms,score,board_revision FROM series_fence_state WHERE series_key=$1',
      [seriesId],
    );
    // Simulate natural session expiry without changing immutable series/fence.
    await env.pool.query(
      'UPDATE tournament_auth_session SET expires_at_ms=1 WHERE session_id=$1',
      [original.sessionId],
    );
    const request=await recoveryProof(env,newSession,seriesId,key);
    const [a,b]=await Promise.all([
      env.recovery.recover(request),env.recovery.recover(request),
    ]);
    assert.equal(a.ok,true,JSON.stringify(a));
    assert.equal(b.ok,true,JSON.stringify(b));
    if(!a.ok||!b.ok)return;
    assert.deepEqual(a.data,b.data);
    assert.equal(a.data.writerGeneration,2);
    const updated=await env.pool.query(
      'SELECT session_id,writer_generation FROM tournament_series_writer WHERE series_key=$1',
      [seriesId],
    );
    assert.equal(updated.rows[0].session_id,newSession.sessionId);
    assert.equal(Number(updated.rows[0].writer_generation),2);
    const fence=await env.pool.query(
      'SELECT writer_generation,idle_deadline_at_ms,score,board_revision FROM series_fence_state WHERE series_key=$1',
      [seriesId],
    );
    assert.equal(Number(fence.rows[0].writer_generation),2);
    assert.equal(String(fence.rows[0].idle_deadline_at_ms),
      String(before.rows[0].idle_deadline_at_ms));
    assert.equal(String(fence.rows[0].score),String(before.rows[0].score));
    assert.equal(String(fence.rows[0].board_revision),
      String(before.rows[0].board_revision));
    const snapshot=await env.pool.query(
      'SELECT writer_generation FROM authoritative_game_snapshot WHERE series_key=$1',
      [seriesId],
    );
    assert.equal(Number(snapshot.rows[0].writer_generation),2);
  } finally {await env.cleanup();}
});

test('different key and cross-player cannot recover original writer', async()=>{
  const env=await setup();
  try {
    const original=await env.open('player-a');
    await register(env,original,keypair());
    const seriesId=await firstClaim(env,original);
    await env.pool.query('UPDATE tournament_auth_session SET expires_at_ms=1 WHERE session_id=$1',
      [original.sessionId]);
    const wrong=await env.open('player-a');
    await register(env,wrong,keypair());
    const denied=await env.recovery.issueChallenge({session:wrong,seriesId});
    assert.deepEqual(denied,{ok:false,reason:'RECOVERY_NOT_ELIGIBLE'});
    const playerB=await env.open('player-b');
    await register(env,playerB,keypair());
    const cross=await env.recovery.issueChallenge({session:playerB,seriesId});
    assert.deepEqual(cross,{ok:false,reason:'SERIES_NOT_OWNED'});
    const writer=await env.pool.query(
      'SELECT writer_generation FROM tournament_series_writer WHERE series_key=$1',
      [seriesId],
    );
    assert.equal(Number(writer.rows[0].writer_generation),1);
  } finally {await env.cleanup();}
});

test('active writer or expired idle deadline prevents recovery',async()=>{
  const env=await setup();
  try {
    const key=keypair(),original=await env.open('player-a');
    await register(env,original,key);
    const seriesId=await firstClaim(env,original);
    const second=await env.open('player-a');
    await register(env,second,key);
    const active=await env.recovery.issueChallenge({session:second,seriesId});
    assert.deepEqual(active,{ok:false,reason:'WRITER_STILL_ACTIVE'});
    await env.pool.query(
      'UPDATE tournament_auth_session SET expires_at_ms=1 WHERE session_id=$1',
      [original.sessionId],
    );
    await env.pool.query(
      'UPDATE series_fence_state SET idle_deadline_at_ms=1 WHERE series_key=$1',
      [seriesId],
    );
    const expired=await env.recovery.issueChallenge({session:second,seriesId});
    assert.deepEqual(expired,{ok:false,reason:'IDLE_EXPIRED'});
    const writer=await env.pool.query(
      'SELECT writer_generation FROM tournament_series_writer WHERE series_key=$1',
      [seriesId],
    );
    assert.equal(Number(writer.rows[0].writer_generation),1);
  } finally {await env.cleanup();}
});

test('pre-existing claims cannot acquire a retroactive device anchor',async()=>{
  const env=await setup();
  try {
    const original=await env.open('player-a');
    const seriesId=await firstClaim(env,original);
    const key=keypair(),fresh=await env.open('player-a');
    await register(env,fresh,key);
    const retry=await env.claims.claimAndBootstrap({
      session:fresh,originalUtcDate:new Date().toISOString().slice(0,10),
    });
    assert.equal(retry.ok,true);
    const writer=await env.pool.query(
      'SELECT original_device_credential_id FROM tournament_series_writer WHERE series_key=$1',
      [seriesId],
    );
    assert.equal(writer.rows[0].original_device_credential_id,null);
    await env.pool.query(
      'UPDATE tournament_auth_session SET expires_at_ms=1 WHERE session_id=$1',
      [original.sessionId],
    );
    const denied=await env.recovery.issueChallenge({session:fresh,seriesId});
    assert.deepEqual(denied,{ok:false,reason:'RECOVERY_NOT_ELIGIBLE'});
  } finally {await env.cleanup();}
});

test('forged device proof and missing active snapshot leave writer/fence unchanged',async()=>{
  const env=await setup();
  try {
    const key=keypair(), original=await env.open('player-a');
    await register(env,original,key);
    const seriesId=await firstClaim(env,original);
    const fresh=await env.open('player-a');
    await register(env,fresh,key);
    await env.pool.query(
      'UPDATE tournament_auth_session SET expires_at_ms=1 WHERE session_id=$1',
      [original.sessionId],
    );
    const request=await recoveryProof(env,fresh,seriesId,key);
    const forged=await env.recovery.recover({
      ...request,
      signatureBase64Url: sign(
        'sha256',
        Buffer.from(canonicalDeviceRecoveryProof(request.proof)),
        keypair().privateKey,
      ).toString('base64url'),
    });
    assert.deepEqual(forged,{ok:false,reason:'RECOVERY_PROOF_INVALID'});
    await env.pool.query(
      'DELETE FROM authoritative_game_snapshot WHERE series_key=$1',
      [seriesId],
    );
    const corrupted=await env.recovery.recover(request);
    assert.deepEqual(corrupted,{ok:false,reason:'SERIES_STATE_INCONSISTENT'});
    const writer=await env.pool.query(
      'SELECT session_id,writer_generation FROM tournament_series_writer WHERE series_key=$1',
      [seriesId],
    );
    assert.equal(writer.rows[0].session_id,original.sessionId);
    assert.equal(Number(writer.rows[0].writer_generation),1);
    const fence=await env.pool.query(
      'SELECT writer_generation FROM series_fence_state WHERE series_key=$1',
      [seriesId],
    );
    assert.equal(Number(fence.rows[0].writer_generation),1);
    const ledger=await env.pool.query(
      'SELECT consumed_at_ms FROM tournament_writer_recovery_challenge WHERE challenge_id=$1',
      [request.proof.challengeId],
    );
    assert.equal(ledger.rows[0].consumed_at_ms,null);
  } finally {await env.cleanup();}
});
