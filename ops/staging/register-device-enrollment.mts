/** Operator-only: install a device-generated enrollment-code digest.
 * Usage: PZD_ENROLLMENT_PLAYER=gokhan PZD_ENROLLMENT_DIGEST=<64 hex>
 * Never accept or print the original one-time secret.
 */
import pg from 'pg';
import { issueEnrollmentCode } from '../../src/staging/named-device-enrollment.mts';
const slug = process.env.PZD_ENROLLMENT_PLAYER;
const hash = process.env.PZD_ENROLLMENT_DIGEST;
const url = process.env.PZD_STAGING_DATABASE_URL;
if (process.env.PZD_RUNTIME_PROFILE !== 'staging' ||
    process.env.PZD_RANKED_HTTP_ENABLED === 'true' ||
    (slug !== 'gokhan' && slug !== 'serap') ||
    !hash || !/^[a-f0-9]{64}$/.test(hash) || !url ||
    !['localhost','127.0.0.1'].includes(new URL(url).hostname) ||
    new URL(url).pathname !== '/pzd_staging') throw new Error('STAGING_OPERATOR_GUARD');
const pool = new pg.Pool({connectionString:url,max:2});
try {
  const result = await issueEnrollmentCode(pool, slug, hash);
  console.log('Enrollment code digest registered, expiring at', result.expiresAt);
} finally { await pool.end(); }
