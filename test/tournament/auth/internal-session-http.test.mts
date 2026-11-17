import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import pg from 'pg';
import { PinnedRs256JwtVerifier } from '../../../src/tournament/auth/pinned-jwt-verifier.mts';
import { PostgresVerifiedIdentitySessionStore } from '../../../src/tournament/auth/postgres-verified-sessions.mts';
import { createInternalSessionHttpHandler } from '../../../src/tournament/auth/internal-session-http.mts';
import { explicitTestRankedHttpGateConfig } from '../../../src/tournament/auth/ranked-feature-gate.mts';

const url=process.env.PZD_INGRESS_DATABASE_URL;
assert.ok(url,'PostgreSQL required for HTTP auth integration');
const pair=generateKeyPairSync('rsa',{modulusLength:2048});
const issuer='https://issuer.example.test',audience='puzzle-duel-api';
const verifier=new PinnedRs256JwtVerifier({
 issuer,audience,
 keys:[{keyId:'server-pinned',rsaPublicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}).toString()}],
 maxTokenAgeSeconds:900,
});
function token(sub:string,overrides:Record<string,unknown>={}) {
 const now=Math.floor(Date.now()/1000);
 const head=Buffer.from(JSON.stringify({alg:'RS256',kid:'server-pinned'})).toString('base64url');
 const body=Buffer.from(JSON.stringify({iss:issuer,aud:audience,sub,iat:now-10,exp:now+250,...overrides})).toString('base64url');
 const message=head+'.'+body;
 return 'Bearer '+message+'.'+sign('RSA-SHA256',Buffer.from(message),pair.privateKey).toString('base64url');
}
async function fixture() {
 const pool=new pg.Pool({connectionString:url,max:10});
 await pool.query('DROP TABLE IF EXISTS tournament_auth_session');
 await pool.query('DROP TABLE IF EXISTS tournament_verified_identity');
 const sessions=new PostgresVerifiedIdentitySessionStore(pool);
 await sessions.migrate();
 const handler=createInternalSessionHttpHandler({
  sessions,
  verifier,
  rankedHttpGate: explicitTestRankedHttpGateConfig(),
  actualRuntimeEnv: { NODE_ENV: 'test' } as NodeJS.ProcessEnv,
 });
 const server=createServer((req,res)=>{void handler(req,res);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();
 assert.ok(address && typeof address!=='string');
 const endpoint='http://127.0.0.1:'+address.port+'/internal/tournament/session';
 return {pool,sessions,server,endpoint,close:async()=>{
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  await pool.end();
 }};
}
describe('PZD-40 real HTTP session boundary on signed bearer + PostgreSQL',()=>{
 it('signed bearer opens server-minted session; read and revocation require same bearer + secret',async()=>{
  const env=await fixture();
  try{
   const authorization=token('account-a');
   const opened=await fetch(env.endpoint,{method:'POST',headers:{authorization}});
   assert.equal(opened.status,201);
   assert.equal(opened.headers.get('cache-control'),'no-store');
   const session=await opened.json() as {sessionSecret:string,deviceId:string,sessionId:string};
   assert.equal(typeof session.sessionSecret,'string');
   assert.equal(session.sessionSecret.length,43);
   const read=await fetch(env.endpoint,{headers:{authorization,'x-pzd-session-secret':session.sessionSecret}});
   assert.equal(read.status,200);
   const body=await read.json() as Record<string,unknown>;
   assert.equal(body.sessionId,session.sessionId);
   assert.equal(body.deviceId,session.deviceId);
   assert.equal(body.playerId,undefined);
   const revoked=await fetch(env.endpoint,{method:'DELETE',headers:{authorization,'x-pzd-session-secret':session.sessionSecret}});
   assert.equal(revoked.status,204);
   assert.equal((await fetch(env.endpoint,{headers:{authorization,'x-pzd-session-secret':session.sessionSecret}})).status,401);
  }finally{await env.close();}
 });
 it('rejects missing/forged/wrong-audience tokens and cross-player session reuse',async()=>{
  const env=await fixture();
  try{
   const signed=token('user-a');
   assert.equal((await fetch(env.endpoint,{method:'POST'})).status,401);
   assert.equal((await fetch(env.endpoint,{method:'POST',headers:{authorization:token('user-a',{aud:'wrong'})}})).status,401);
   assert.equal((await fetch(env.endpoint,{method:'POST',headers:{authorization:token('user-a',{exp:1})}})).status,401);
   const opened=await fetch(env.endpoint,{method:'POST',headers:{authorization:signed}});
   const session=await opened.json() as {sessionSecret:string};
   assert.equal((await fetch(env.endpoint,{headers:{authorization:token('user-b'),'x-pzd-session-secret':session.sessionSecret}})).status,401);
   assert.equal((await fetch(env.endpoint,{headers:{authorization:signed,'x-pzd-session-secret':session.sessionSecret}})).status,200);
  }finally{await env.close();}
 });
 it('rejects untrusted playerId/deviceId request bodies and unknown paths',async()=>{
  const env=await fixture();
  try {
   const authorization=token('user-body');
   const refused=await fetch(env.endpoint,{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify({playerId:'victim',deviceId:'spoof'})});
   assert.equal(refused.status,400);
   const unknown=await fetch(env.endpoint+'/claim',{method:'POST',headers:{authorization}});
   assert.equal(unknown.status,404);
   const count=await env.pool.query('SELECT count(*)::int AS n FROM tournament_auth_session');
   assert.equal(count.rows[0].n,0);
  }finally{await env.close();}
 });
});
