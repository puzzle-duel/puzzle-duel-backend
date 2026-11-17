import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { PostgresDailyClaimStore } from '../../../src/tournament/claims/postgres-daily-claim.mts';

const url = process.env.PZD_INGRESS_DATABASE_URL;
assert.ok(url, 'PZD_INGRESS_DATABASE_URL is required for PZD-40 PostgreSQL proof');
const A = 'a'.repeat(64), B = 'b'.repeat(64);
async function fixture() {
  const pool = new pg.Pool({ connectionString: url, max: 12 });
  await pool.query('DROP TABLE IF EXISTS tournament_daily_claim');
  const store = new PostgresDailyClaimStore(pool);
  await store.migrate();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  return { pool, store, today };
}

describe('PZD-40 — immutable daily series claim, real PostgreSQL', () => {
  it('concurrent same player/day requests produce exactly one immutable entitlement', async () => {
    const { pool, store, today } = await fixture();
    try {
      const results = await Promise.all(Array.from({length: 12}, (_, i) =>
        store.claimForVerifiedPrincipal({ playerId: 'p1', originalUtcDate: today, manifestDigest: i % 2 ? B : A })));
      assert.ok(results.every(r => r.ok));
      const successful = results.filter(r => r.ok);
      assert.equal(successful.filter(r => r.original).length, 1);
      assert.equal(new Set(successful.map(r => r.claim.seriesId)).size, 1);
      assert.equal(new Set(successful.map(r => r.claim.startedAtMs)).size, 1);
      assert.equal(new Set(successful.map(r => r.claim.manifestDigest)).size, 1);
      const count = await pool.query('SELECT count(*)::int AS n FROM tournament_daily_claim');
      assert.equal(count.rows[0].n, 1);
    } finally { await pool.end(); }
  });

  it('retry after restart returns original start, digest and spent tombstone', async () => {
    const { pool, store, today } = await fixture();
    try {
      const first = await store.claimForVerifiedPrincipal({ playerId:'p1', originalUtcDate:today, manifestDigest:A });
      assert.equal(first.ok, true);
      if (!first.ok) return;
      await pool.query("UPDATE tournament_daily_claim SET status = 'FORFEITED' WHERE series_id = $1", [first.claim.seriesId]);
      const reloaded = new PostgresDailyClaimStore(pool);
      const retry = await reloaded.claimForVerifiedPrincipal({ playerId:'p1', originalUtcDate:today, manifestDigest:B });
      assert.equal(retry.ok, true);
      if (retry.ok) {
        assert.equal(retry.original, false);
        assert.equal(retry.claim.seriesId, first.claim.seriesId);
        assert.equal(retry.claim.startedAtMs, first.claim.startedAtMs);
        assert.equal(retry.claim.manifestDigest, A);
        assert.equal(retry.claim.status, 'FORFEITED');
      }
    } finally { await pool.end(); }
  });

  it('distinct verified players each receive exactly one independent claim', async () => {
    const { pool, store, today } = await fixture();
    try {
      const p1 = await store.claimForVerifiedPrincipal({ playerId:'p1',originalUtcDate:today,manifestDigest:A });
      const p2 = await store.claimForVerifiedPrincipal({ playerId:'p2',originalUtcDate:today,manifestDigest:A });
      assert.equal(p1.ok,true); assert.equal(p2.ok,true);
      if(p1.ok&&p2.ok) assert.notEqual(p1.claim.seriesId,p2.claim.seriesId);
    } finally { await pool.end(); }
  });

  it('rejects invalid date, future claim, previous-week new claim, fake manifest', async () => {
    const { pool, store, today } = await fixture();
    try {
      const now = Date.parse(today+'T00:00:00Z');
      const weekday = new Date(now).getUTCDay();
      const monday = now - ((weekday+6)%7)*86400000;
      const old = new Date(monday - 86400000).toISOString().slice(0,10);
      const future = new Date(now+86400000).toISOString().slice(0,10);
      for(const s of ['2026-02-30','2026-13-01','bad']) {
        const r=await store.claimForVerifiedPrincipal({playerId:'p1',originalUtcDate:s,manifestDigest:A});
        assert.deepEqual(r,{ok:false,reason:'INVALID_DATE'});
      }
      for(const s of [old,future]) {
        const r=await store.claimForVerifiedPrincipal({playerId:'p1',originalUtcDate:s,manifestDigest:A});
        assert.deepEqual(r,{ok:false,reason:'CLAIM_WINDOW_CLOSED'});
      }
      const bad=await store.claimForVerifiedPrincipal({playerId:'p1',originalUtcDate:today,manifestDigest:'client-claims-trusted'});
      assert.deepEqual(bad,{ok:false,reason:'UNVERIFIED_INPUT'});
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM tournament_daily_claim')).rows[0].n,0);
    } finally { await pool.end(); }
  });

  it('same UTC week historical new claim is allowed, but not On-Time proof', async () => {
    const { pool, store, today } = await fixture();
    try {
      const ms=Date.parse(today+'T00:00:00Z');
      const day=new Date(ms).getUTCDay();
      if(day===1) return; // current Monday has no earlier date in open week
      const yesterday=new Date(ms-86400000).toISOString().slice(0,10);
      const result=await store.claimForVerifiedPrincipal({playerId:'p1',originalUtcDate:yesterday,manifestDigest:A});
      assert.equal(result.ok,true);
      if(result.ok) {
        assert.equal(result.claim.originalUtcDate,yesterday);
        assert.notEqual(new Date(result.claim.startedAtMs).toISOString().slice(0,10),yesterday);
      }
    } finally { await pool.end(); }
  });
});
