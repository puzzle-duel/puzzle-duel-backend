import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Provider } from './provider-token-verifier.mts';

type Purpose = 'login' | 'link';
type Scope = { provider: Provider; purpose: Purpose; binding: string };
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
function validate(scope: Scope): void {
  if (!['apple','google'].includes(scope.provider) || !['login','link'].includes(scope.purpose) ||
      !scope.binding || scope.binding.length > 1024) throw new Error('INVALID_PROVIDER_CHALLENGE');
}
/** Binding must be derived by the trusted server from authenticated session
 * proof (link) or a high-entropy pre-auth session secret (login), never an
 * unverified player ID. HTTP wiring and rate limits are separate gates. */
export async function issueProviderChallenge(db: pg.Pool, scope: Scope): Promise<string> {
  validate(scope);
  const nonce = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO public.pzd_provider_challenges
      (nonce_digest,binding_digest,provider,purpose,expires_at)
      VALUES ($1,$2,$3,$4,clock_timestamp()+interval '5 minutes')`,
    [digest(nonce), digest(scope.binding), scope.provider, scope.purpose],
  );
  return nonce;
}
/** Call only after cryptographic assertion verification, with the same
 * verified nonce, inside the transaction that creates/links the account.
 * Rollback must also roll back consumption. */
export async function consumeProviderChallenge(tx: pg.PoolClient, scope: Scope, nonce: string): Promise<void> {
  validate(scope);
  if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Error('INVALID_PROVIDER_CHALLENGE');
  const result = await tx.query(
    `UPDATE public.pzd_provider_challenges SET consumed_at=clock_timestamp()
      WHERE nonce_digest=$1 AND binding_digest=$2 AND provider=$3 AND purpose=$4
        AND consumed_at IS NULL AND expires_at>clock_timestamp()`,
    [digest(nonce), digest(scope.binding), scope.provider, scope.purpose],
  );
  if (result.rowCount !== 1) throw new Error('INVALID_PROVIDER_CHALLENGE');
}
