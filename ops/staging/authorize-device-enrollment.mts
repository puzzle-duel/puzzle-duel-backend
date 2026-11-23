/** Operator-only: authorizes the 128-bit challenge displayed on the physical iPhone. */
import { createHash } from 'node:crypto';
import pg from 'pg';
const code = process.env.PZD_ENROLLMENT_CODE ?? '';
const slug = process.env.PZD_ENROLLMENT_PLAYER ?? '';
if (process.env.PZD_RUNTIME_PROFILE !== 'staging' ||
    process.env.PZD_NAMED_ENROLLMENT_APPROVED !== 'YES' ||
    !/^[0-9a-f]{32}$/.test(code) || !['gokhan','serap'].includes(slug)) {
  throw new Error('Invalid staging enrollment authorization');
}
const url = process.env.PZD_STAGING_DATABASE_URL ?? '';
const parsed = new URL(url);
if (!['localhost','127.0.0.1'].includes(parsed.hostname) || parsed.pathname !== '/pzd_staging') {
  throw new Error('Non-staging database refused');
}
const pool = new pg.Pool({ connectionString:url, max:1 });
try {
  const result = await pool.query(
    `INSERT INTO public.pzd_staging_enrollment_grants(code_digest,player_id,expires_at)
     SELECT $1, player_id, now() + interval '10 minutes'
       FROM public.pzd_staging_test_players WHERE slug=$2
     ON CONFLICT (code_digest) DO NOTHING`,
    [createHash('sha256').update(code).digest('hex'),slug],
  );
  if (result.rowCount !== 1) throw new Error('Enrollment not authorized');
  console.log('Named staging device challenge authorized (expires in ten minutes)');
} finally {
  await pool.end();
}
