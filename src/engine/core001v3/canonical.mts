import { createHash } from 'node:crypto';
import { JSON_MAX_SAFE_INTEGER } from './checked_int.mts';
import { RULES_VERSION, stateToJson, type GameState } from './types.mts';

export class CanonicalJsonException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonException';
  }
}

function utf8KeyCompare(a: string, b: string): number {
  const aa = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const n = Math.min(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const d = aa[i]! - bb[i]!;
    if (d !== 0) return d;
  }
  return aa.length - bb.length;
}

function writeCanonicalString(out: string[], value: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 0x7f) {
      throw new CanonicalJsonException('non-ASCII string content');
    }
  }
  out.push('"');
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x22) out.push('\\"');
    else if (code === 0x5c) out.push('\\\\');
    else if (code <= 0x1f) {
      out.push('\\u00');
      out.push(code.toString(16).padStart(2, '0'));
    } else {
      out.push(String.fromCharCode(code));
    }
  }
  out.push('"');
}

function writeCanonical(out: string[], value: unknown): void {
  if (value === null) {
    out.push('null');
    return;
  }
  if (typeof value === 'boolean') {
    out.push(value ? 'true' : 'false');
    return;
  }
  if (typeof value === 'number') {
    if (Object.is(value, -0)) {
      throw new CanonicalJsonException('negative zero rejected');
    }
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalJsonException('integer out of JSON-safe range');
    }
    if (value < -JSON_MAX_SAFE_INTEGER || value > JSON_MAX_SAFE_INTEGER) {
      throw new CanonicalJsonException('integer out of JSON-safe range');
    }
    out.push(String(value));
    return;
  }
  if (typeof value === 'string') {
    writeCanonicalString(out, value);
    return;
  }
  if (Array.isArray(value)) {
    out.push('[');
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(',');
      writeCanonical(out, value[i]);
    }
    out.push(']');
    return;
  }
  if (typeof value === 'object') {
    const entries: [string, unknown][] = [];
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      entries.push([key, entry]);
    }
    entries.sort((a, b) => utf8KeyCompare(a[0], b[0]));
    out.push('{');
    for (let i = 0; i < entries.length; i++) {
      if (i > 0) out.push(',');
      writeCanonicalString(out, entries[i]![0]);
      out.push(':');
      writeCanonical(out, entries[i]![1]);
    }
    out.push('}');
    return;
  }
  throw new CanonicalJsonException('unsupported JSON value type');
}

/** ADR-E01 §8 canonical_json_v3 — not JSON.stringify. */
export function canonicalJsonV3(value: unknown): string {
  const out: string[] = [];
  writeCanonical(out, value);
  return out.join('');
}

export function sha256HexOfUtf8(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Integrity digest of a validated v3 state.
 * Matching a client-supplied hash is never ranked authenticity.
 */
export function stateHashV3(state: GameState): string {
  if (state.rulesVersion !== RULES_VERSION) {
    throw new CanonicalJsonException('stateHashV3 requires core-001.v3');
  }
  return sha256HexOfUtf8(canonicalJsonV3(stateToJson(state)));
}
