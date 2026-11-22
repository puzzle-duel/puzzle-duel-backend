import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertStagingRecoverySchemaReady, stagingSameDeviceRecoveryEnabled } from '../../src/staging/staging-tournament.mts';

const enabled = {
  PZD_RUNTIME_PROFILE: 'staging',
  PZD_STAGING_TOURNAMENT_ENABLED: 'true',
  PZD_STAGING_SAME_DEVICE_RECOVERY_ENABLED: 'true',
};

test('staging recovery is opt-in, cannot enable in prod or without ranked staging', () => {
  assert.equal(stagingSameDeviceRecoveryEnabled(enabled), true);
  for (const env of [
    { ...enabled, PZD_STAGING_SAME_DEVICE_RECOVERY_ENABLED: 'false' },
    { ...enabled, PZD_STAGING_TOURNAMENT_ENABLED: 'false' },
    { ...enabled, PZD_RUNTIME_PROFILE: 'prod' },
    { ...enabled, NODE_ENV: 'production' },
    { ...enabled, NODE_ENV: 'prod' },
  ]) assert.equal(stagingSameDeviceRecoveryEnabled(env), false);
});

test('staging fails closed when any required recovery table or column is missing', async () => {
  const values = {
    device_table: 'tournament_device_credential',
    challenge_table: 'tournament_writer_recovery_challenge',
    session_column: true,
    writer_column: true,
  };
  const pool = {
    query: async () => ({ rows: [values] }),
  };
  await assertStagingRecoverySchemaReady(pool as never);
  for (const override of [
    { device_table: null },
    { challenge_table: null },
    { session_column: false },
    { writer_column: false },
  ]) {
    const bad = { query: async () => ({ rows: [{ ...values, ...override }] }) };
    await assert.rejects(() => assertStagingRecoverySchemaReady(bad as never),
      /STAGING_RECOVERY_SCHEMA_NOT_READY/);
  }
});
