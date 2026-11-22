import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { PostgresStagingGuestAuth, GuestCredentialError } from '../../src/staging/guest-auth-service.mts';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
type RefreshRow = { family_id: string; player_id: string; token_digest: string; expires_at: Date;
  used_at: Date | null; rotation_id_digest: string | null };
class FakePool {
  families = new Map<string, { player_id: string; revoked_at: Date | null }>();
  refreshes = new Map<string, RefreshRow>();
  readonly commands: string[] = [];
  async connect() { return { query: (sql: string, values: unknown[] = []) => this.query(sql, values), release() {} }; }
  async query(sql: string, values: unknown[] = []) {
    this.commands.push(sql);
    const v = values as (string | Date | null)[];
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: null };
    if (sql.startsWith('INSERT INTO pzd_guest_accounts')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('INSERT INTO pzd_guest_families')) {
      this.families.set(v[0] as string, { player_id: v[1] as string, revoked_at: null });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO pzd_guest_refresh')) {
      this.refreshes.set(v[2] as string, { family_id: v[0] as string, player_id: v[1] as string,
        token_digest: v[2] as string, expires_at: v[3] as Date, used_at: null, rotation_id_digest: null });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT family_id FROM pzd_guest_refresh')) {
      const row = this.refreshes.get(v[0] as string);
      return { rows: row ? [{ family_id: row.family_id }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith('SELECT family_id FROM pzd_guest_families')) {
      const found = this.families.has(v[0] as string);
      return { rows: found ? [{ family_id: v[0] }] : [], rowCount: found ? 1 : 0 };
    }
    if (sql.includes('FROM pzd_guest_refresh r JOIN pzd_guest_families')) {
      const row = this.refreshes.get(v[0] as string);
      const family = row && this.families.get(row.family_id);
      return { rows: row && family ? [{ ...row, revoked_at: family.revoked_at }] : [],
        rowCount: row && family ? 1 : 0 };
    }
    if (sql.startsWith('SELECT used_at FROM pzd_guest_refresh')) {
      const row = this.refreshes.get(v[1] as string);
      const found = row?.family_id === v[0];
      return { rows: found ? [{ used_at: row!.used_at }] : [], rowCount: found ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE pzd_guest_refresh SET used_at=')) {
      const row = this.refreshes.get(v[0] as string)!;
      row.used_at = v[1] as Date;
      row.rotation_id_digest = v[2] as string | null;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE pzd_guest_refresh SET used_at =')) {
      this.refreshes.get(v[0] as string)!.used_at = v[1] as Date;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE pzd_guest_families SET revoked_at')) {
      const family = this.families.get(v[0] as string)!;
      family.revoked_at = v[1] as Date;
      return { rows: [], rowCount: 1 };
    }
    throw new Error('Unhandled SQL');
  }
}

test('same rotation ID survives 02:59 to 03:02 Istanbul UTC cutover without revocation', async () => {
  const pool = new FakePool();
  const guest = new PostgresStagingGuestAuth(pool as never, privateKey, 'test', true);
  const t = new Date('2026-11-21T23:59:30.000Z');
  const initial = await guest.create(t);
  const rotationId = '0123456789abcdef0123456789abcdef';
  const first = await guest.refresh(initial.refreshToken, rotationId, t);
  const again = await guest.refresh(initial.refreshToken, rotationId, new Date(t.getTime() + 3 * 60_000));
  assert.equal(again.refreshToken, first.refreshToken);
  assert.equal(pool.families.size, 1);
  assert.equal([...pool.families.values()][0]!.revoked_at, null);
  assert.equal(pool.refreshes.size, 2);
  const next = await guest.refresh(first.refreshToken, 'fedcba9876543210fedcba9876543210', new Date(t.getTime() + 60_000));
  assert.notEqual(next.refreshToken, first.refreshToken);
});

test('wrong rotation ID replays and revokes; expired retry window fails closed', async () => {
  for (const delta of [30_000, 11 * 60_000]) {
    const pool = new FakePool();
    const guest = new PostgresStagingGuestAuth(pool as never, privateKey, 'test', true);
    const t = new Date('2026-11-22T00:02:00.000Z');
    const initial = await guest.create(t);
    await guest.refresh(initial.refreshToken, '0123456789abcdef0123456789abcdef', t);
    const id = delta === 30_000 ? 'fedcba9876543210fedcba9876543210' : '0123456789abcdef0123456789abcdef';
    await assert.rejects(() => guest.refresh(initial.refreshToken, id, new Date(t.getTime() + delta)),
      (e: unknown) => e instanceof GuestCredentialError && e.code === 'REFRESH_REPLAY');
    assert.ok([...pool.families.values()][0]!.revoked_at);
  }
});

test('legacy refresh has no retry backdoor and replay revokes', async () => {
  const pool = new FakePool();
  const guest = new PostgresStagingGuestAuth(pool as never, privateKey, 'test');
  const now = new Date('2026-11-22T00:02:00.000Z');
  const initial = await guest.create(now);
  await guest.refresh(initial.refreshToken, undefined, now);
  await assert.rejects(() => guest.refresh(initial.refreshToken, undefined, now),
    (e: unknown) => e instanceof GuestCredentialError && e.code === 'REFRESH_REPLAY');
});
