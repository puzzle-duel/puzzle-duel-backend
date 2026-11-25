import type { Provider, ProviderKey } from './provider-token-verifier.mts';

const endpoints = {
  apple: 'https://appleid.apple.com/auth/keys',
  google: 'https://www.googleapis.com/oauth2/v3/certs',
} as const;
type Entry = { keys: readonly ProviderKey[]; expires: number; fetched: number };
export class ProviderJwks {
  private cache = new Map<Provider, Entry>();
  private pending = new Map<Provider, Promise<Entry>>();
  private lastFailure = new Map<Provider, number>();
  private readonly request: typeof fetch;
  private readonly now: () => number;
  constructor(request: typeof fetch = fetch, now: () => number = Date.now) {
    this.request = request;
    this.now = now;
  }
  async keys(provider: Provider, kid: string): Promise<readonly ProviderKey[]> {
    if (!Object.hasOwn(endpoints, provider) || !kid || kid.length > 256) {
      throw new Error('INVALID_PROVIDER_ASSERTION');
    }
    const old = this.cache.get(provider);
    if (old && old.expires > this.now() && old.keys.some(k => k.kid === kid)) return old.keys;
    let pending = this.pending.get(provider);
    if (!pending) {
      const failedAt = this.lastFailure.get(provider);
      if (failedAt !== undefined && this.now() - failedAt < 10000) {
        throw new Error('PROVIDER_KEYS_UNAVAILABLE');
      }
      pending = this.load(provider).then((entry) => {
        this.lastFailure.delete(provider);
        return entry;
      }, (error: unknown) => {
        this.lastFailure.set(provider, this.now());
        throw error;
      });
      this.pending.set(provider, pending);
    }
    try {
      const entry = await pending;
      if (!entry.keys.some(k => k.kid === kid)) throw new Error('INVALID_PROVIDER_ASSERTION');
      return entry.keys;
    } finally {
      if (this.pending.get(provider) === pending) this.pending.delete(provider);
    }
  }
  private async load(provider: Provider): Promise<Entry> {
    const response = await this.request(endpoints[provider], {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json' },
    });
    if (!response.ok || !response.body) throw new Error('PROVIDER_KEYS_UNAVAILABLE');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) throw new Error('PROVIDER_KEYS_UNAVAILABLE');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { keys?: unknown };
    if (!Array.isArray(body.keys) || body.keys.length > 64) throw new Error('PROVIDER_KEYS_UNAVAILABLE');
    const keys: ProviderKey[] = [];
    for (const k of body.keys) {
      if (!k || typeof k !== 'object' || Array.isArray(k)) continue;
      const row = k as Record<string, unknown>;
      if (row.kty !== 'RSA' || typeof row.kid !== 'string' || !row.kid ||
          typeof row.n !== 'string' || typeof row.e !== 'string' ||
          (row.alg !== undefined && row.alg !== 'RS256') ||
          (row.use !== undefined && row.use !== 'sig')) continue;
      if (keys.some(x => x.kid === row.kid)) throw new Error('PROVIDER_KEYS_UNAVAILABLE');
      keys.push(Object.freeze({
        kid: row.kid,
        kty: 'RSA',
        n: row.n,
        e: row.e,
        alg: typeof row.alg === 'string' ? row.alg : undefined,
        use: typeof row.use === 'string' ? row.use : undefined,
      }));
    }
    if (!keys.length) throw new Error('PROVIDER_KEYS_UNAVAILABLE');
    const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(response.headers.get('cache-control') ?? '');
    const ttl = /(?:^|,)\s*(?:no-store|no-cache)\b/i.test(response.headers.get('cache-control') ?? '')
      ? 0
      : Math.min(3600, maxAge ? Number(maxAge[1]) : 60);
    const fetched = this.now();
    const entry = { keys: Object.freeze(keys), fetched, expires: fetched + ttl * 1000 };
    this.cache.set(provider, entry);
    return entry;
  }
}
