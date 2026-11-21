import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stagingConfig } from '../../src/staging/staging-server.mts';

const base = {
  PZD_RUNTIME_PROFILE: 'staging',
  PZD_STAGING_DATABASE_URL: 'postgresql://pzd_staging_app:placeholder@127.0.0.1:5432/pzd_staging',
};
test('staging binds to loopback and isolated database', () => {
  const config = stagingConfig(base);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8787);
});
test('rejects non-loopback bind', () => {
  assert.throws(() => stagingConfig({ ...base, PZD_STAGING_HOST: '0.0.0.0' }));
});
test('rejects production or UAT databases', () => {
  assert.throws(() => stagingConfig({ ...base, PZD_STAGING_DATABASE_URL: 'postgresql://localhost:5432/pzd_ingress' }));
});
test('rejects ranked gate and automatic migrations', () => {
  assert.throws(() => stagingConfig({ ...base, PZD_RANKED_HTTP_ENABLED: 'true' }));
  assert.throws(() => stagingConfig({ ...base, PZD_UAT_APPLY_MIGRATIONS: '1' }));
});
test('rejects missing runtime profile', () => {
  assert.throws(() => stagingConfig({ ...base, PZD_RUNTIME_PROFILE: undefined }));
});

test('guest auth remains disabled by default', () => {
  assert.equal(stagingConfig(base).guestAuthEnabled, false);
});
test('guest auth requires explicit private key path and key ID', () => {
  assert.throws(() => stagingConfig({ ...base, PZD_STAGING_GUEST_AUTH_ENABLED: 'true' }));
  assert.throws(() => stagingConfig({
    ...base, PZD_STAGING_GUEST_AUTH_ENABLED: 'true',
    PZD_STAGING_GUEST_SIGNING_KEY_FILE: 'relative.pem',
    PZD_STAGING_GUEST_SIGNING_KID: 'staging-1',
  }));
  const config = stagingConfig({
    ...base, PZD_STAGING_GUEST_AUTH_ENABLED: 'true',
    PZD_STAGING_GUEST_SIGNING_KEY_FILE: '/etc/pzd/guest-private.pem',
    PZD_STAGING_GUEST_SIGNING_KID: 'staging-1',
  });
  assert.equal(config.guestAuthEnabled, true);
});
