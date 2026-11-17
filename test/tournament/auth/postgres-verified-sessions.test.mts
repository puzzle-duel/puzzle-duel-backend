import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import pg from 'pg';
import { PinnedRs256JwtVerifier } from '../../../src/tournament/auth/pinned-jwt-verifier.mts';
import { PostgresVerifiedIdentitySessionStore } from '../../../src/tournament/auth/postgres-verified-sessions.mts';

const databaseUrl = process.env.PZD_INGRESS_DATABASE_URL;
assert.ok(databaseUrl, 'PZD_INGRESS_DATABASE_URL required — do not skip PostgreSQL auth tests');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = 'https://auth.example.test';
const audience = 'puzzle-duel-api';
const verifier = new PinnedRs256JwtVerifier({
  issuer, audience,
  keys:[{keyId:'test-pin', rsaPublicKeyPem: pair.publicKey.export({format:'pem',type:'spki'}).toString()}],
  maxTokenAgeSeconds:1800,
});
function authorizedIdentity(sub: string, override: Record<string,unknown> = {}) {
  const now=Math.floor(Date.now()/1000);
  const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'test-pin',typ:'JWT'})).toString('base64url');
  const body=Buffer.from(JSON.stringify({iss:issuer,aud:audience,sub,iat:now-5,exp:now+300,...override})).toString('base64url');
  const signed=header+'.'+body;
  const bearer='Bearer '+signed+'.'+sign('RSA-SHA256',Buffer.from(signed),pair.privateKey).toString('base64url');
  return verifier.verifyAuthorizationHeader(bearer);
}
async function setup() {
  const pool = new pg.Pool({connectionString:databaseUrl,max:10});
  await pool.query('DROP TABLE IF EXISTS tournament_auth_session');
  await pool.query('DROP TABLE IF EXISTS tournament_verified_identity');
  const store = new PostgresVerifiedIdentitySessionStore(pool);
  await store.migrate();
  return {pool,store};
}
describe('PZD-40 verified issuer/subject mapped internal player and opaque session',()=>{
  it('same signed provider subject preserves player_id across 8 simultaneous authenticated sessions',async()=>{
    const {pool,store}=await setup();
    try {
      const signed=authorizedIdentity('sub-1');
      const sessions=await Promise.all(Array.from({length:8},()=>store.openAfterVerifiedJwt(signed)));
      assert.equal(new Set(sessions.map(s=>s.playerId)).size,1);
      assert.equal(new Set(sessions.map(s=>s.sessionId)).size,8);
      assert.equal(new Set(sessions.map(s=>s.deviceId)).size,8);
      assert.equal(new Set(sessions.map(s=>s.sessionSecret)).size,8);
      const count=await pool.query('SELECT COUNT(*)::int AS n FROM tournament_verified_identity');
      assert.equal(count.rows[0].n,1);
      for(const s of sessions) {
        assert.deepEqual(await store.authenticateVerifiedSession(signed,s.sessionSecret),{
          playerId:s.playerId,sessionId:s.sessionId,deviceId:s.deviceId,expiresAtMs:s.expiresAtMs,
        });
      }
      const raw=await pool.query('SELECT secret_digest FROM tournament_auth_session');
      assert.ok(raw.rows.every(r=>!sessions.some(s=>s.sessionSecret===r.secret_digest)));
    } finally {await pool.end();}
  });
  it('different providers or subjects cannot reuse a session, and have different internal player_id',async()=>{
    const {pool,store}=await setup();
    try {
      const a=authorizedIdentity('subject-a'),b=authorizedIdentity('subject-b');
      const one=await store.openAfterVerifiedJwt(a);
      const two=await store.openAfterVerifiedJwt(b);
      assert.notEqual(one.playerId,two.playerId);
      assert.equal(await store.authenticateVerifiedSession(b,one.sessionSecret),null);
      assert.equal(await store.authenticateVerifiedSession(a,two.sessionSecret),null);
      assert.equal(await store.authenticateVerifiedSession(a,'invalid'),null);
    } finally {await pool.end();}
  });
  it('revoke makes an otherwise valid signed bearer+secret unusable immediately',async()=>{
    const {pool,store}=await setup();
    try {
      const signed=authorizedIdentity('sub-revoke');
      const session=await store.openAfterVerifiedJwt(signed);
      assert.ok(await store.authenticateVerifiedSession(signed,session.sessionSecret));
      assert.equal(await store.revokeSession(signed,session.sessionSecret),true);
      assert.equal(await store.revokeSession(signed,session.sessionSecret),false);
      assert.equal(await store.authenticateVerifiedSession(signed,session.sessionSecret),null);
    } finally {await pool.end();}
  });
  it('expired database session is rejected even with unexpired signed bearer',async()=>{
    const {pool,store}=await setup();
    try {
      const signed=authorizedIdentity('sub-expire');
      const session=await store.openAfterVerifiedJwt(signed);
      await pool.query('UPDATE tournament_auth_session SET expires_at_ms=1 WHERE session_id=$1',[session.sessionId]);
      assert.equal(await store.authenticateVerifiedSession(signed,session.sessionSecret),null);
    } finally {await pool.end();}
  });
  it('invalid issuer/audience/bearer cannot yield a verified identity',async()=>{
    for(const bad of [{aud:'untrusted-api'},{iss:'https://attacker.test'},{exp:1}]) {
      assert.throws(()=>authorizedIdentity('subject-x',bad),/UNAUTHENTICATED/);
    }
  });
});
