/**
 * PZD-21 / gen-001.v1: server-side deterministic challenge generation.
 * Only Accepted GEN-01..GEN-07 semantics. No wall clock, Math.random or network.
 */
export type Profile = 'easy' | 'medium' | 'hard';
export type Shape = 'circle' | 'diamond' | 'triangle';
export type Direction = 'up' | 'right' | 'down' | 'left';
export type Piece = Readonly<{ shape: Shape; direction: Direction }>;
export type Config = Readonly<{ boardSize: number; moveLimit: number; obstacleCount: number; occupiedCount: number }>;
export type Challenge = Readonly<{
  generatorVersion: 'gen-001.v1'; rulesVersion: 'core-001.v2'; seed: number;
  profile: Profile; config: Config; blocked: readonly (readonly [number, number])[];
  cells: readonly (readonly (Piece | null)[])[]; offers: readonly Piece[];
  futurePieces: readonly Piece[]; turnsUsed: 0; score: 0; status: 'in_progress';
}>;
export type GenerationResult =
  | Readonly<{ ok: true; challenge: Challenge }>
  | Readonly<{ ok: false; code: 'invalid_config' | 'generation_exhausted' }>;

const MASK64 = (1n << 64n) - 1n;
const MASK32 = (1n << 32n) - 1n;
const TWO32 = 1n << 32n;
const MULT = 6364136223846793005n;
const INC = 1442695040664678687n;
const SHAPES: readonly Shape[] = ['circle', 'diamond', 'triangle'];
const DIRECTIONS: readonly Direction[] = ['up', 'right', 'down', 'left'];
export const PROFILES: Readonly<Record<Profile, Config>> = Object.freeze({
  easy: Object.freeze({ boardSize: 5, moveLimit: 15, obstacleCount: 1, occupiedCount: 6 }),
  medium: Object.freeze({ boardSize: 6, moveLimit: 12, obstacleCount: 2, occupiedCount: 10 }),
  hard: Object.freeze({ boardSize: 7, moveLimit: 10, obstacleCount: 4, occupiedCount: 16 }),
});

export class Pcg32 {
  private state = 0n;
  private step(): void { this.state = (this.state * MULT + INC) & MASK64; }
  seed32(seed: number): void {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('seed');
    this.state = 0n;
    this.step();
    this.state = (this.state + BigInt(seed)) & MASK64;
    this.step();
  }
  nextU32(): number {
    const old = this.state;
    this.step();
    const x = (((old >> 18n) ^ old) >> 27n) & MASK32;
    const rot = Number(old >> 59n);
    return Number(((x >> BigInt(rot)) | (x << BigInt((-rot) & 31))) & MASK32) >>> 0;
  }
  randBound(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > 4294967296) throw new RangeError('n');
    if (n === 4294967296) return this.nextU32();
    const limit = (TWO32 / BigInt(n)) * BigInt(n); // intentionally wide
    for (;;) {
      const u = this.nextU32();
      if (BigInt(u) < limit) return u % n;
    }
  }
}
type Coord = readonly [number, number];
function selectK<T>(rng: Pcg32, pool: readonly T[], k: number): T[] {
  const copy = [...pool];
  for (let i = 0; i < k; i++) {
    const j = i + rng.randBound(copy.length - i);
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, k);
}
function piece(rng: Pcg32): Piece {
  return Object.freeze({ shape: SHAPES[rng.randBound(3)]!, direction: DIRECTIONS[rng.randBound(4)]! });
}
function hasRun(grid: readonly (readonly (Piece | null)[])[]): boolean {
  const n = grid.length;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const p = grid[r]![c]; if (p == null) continue;
    if (c + 2 < n && grid[r]![c + 1]?.shape === p.shape && grid[r]![c + 2]?.shape === p.shape) return true;
    if (r + 2 < n && grid[r + 1]![c]?.shape === p.shape && grid[r + 2]![c]?.shape === p.shape) return true;
  }
  return false;
}
function validProfile(profile: unknown): profile is Profile {
  return profile === 'easy' || profile === 'medium' || profile === 'hard';
}
function validConfig(profile: Profile, config: Config): boolean {
  const p = PROFILES[profile];
  return config.boardSize === p.boardSize && config.moveLimit === p.moveLimit &&
    config.obstacleCount === p.obstacleCount && config.occupiedCount === p.occupiedCount;
}
/** maxAttemptsOverride is for exhaustion tests ONLY; production always uses 256. */
export function generateChallenge(
  profile: unknown, seed: unknown,
  options: { generatorVersion?: unknown; rulesVersion?: unknown; config?: unknown; maxAttemptsOverride?: number } = {},
): GenerationResult {
  if (!validProfile(profile) || typeof seed !== 'number' || !Number.isInteger(seed) ||
      seed < 0 || seed > 4294967295 ||
      (options.generatorVersion !== undefined && options.generatorVersion !== 'gen-001.v1') ||
      (options.rulesVersion !== undefined && options.rulesVersion !== 'core-001.v2')) {
    return { ok: false, code: 'invalid_config' };
  }
  const config = options.config ?? PROFILES[profile];
  if (!config || typeof config !== 'object' || !validConfig(profile, config as Config)) {
    return { ok: false, code: 'invalid_config' };
  }
  const cfg = Object.freeze({ ...PROFILES[profile] });
  const attempts = options.maxAttemptsOverride ?? 256;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 256) return { ok: false, code: 'invalid_config' };
  const rng = new Pcg32();
  rng.seed32(seed);
  const all: Coord[] = [];
  for (let row = 0; row < cfg.boardSize; row++)
    for (let col = 0; col < cfg.boardSize; col++) all.push([row, col]);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const blocked = selectK(rng, all, cfg.obstacleCount);
    blocked.sort((a,b) => a[0] - b[0] || a[1] - b[1]);
    const blockedKeys = new Set(blocked.map(([r,c]) => `${r},${c}`));
    const free = all.filter(([r,c]) => !blockedKeys.has(`${r},${c}`));
    const selected = selectK(rng, free, cfg.occupiedCount);
    const grid: (Piece | null)[][] = Array.from({length: cfg.boardSize}, () => Array(cfg.boardSize).fill(null));
    for (const [r,c] of selected) grid[r]![c] = piece(rng);
    if (hasRun(grid)) continue; // no supply draws on rejected attempt; keep RNG state
    const supply = Array.from({length: cfg.moveLimit + 2}, () => piece(rng));
    const challenge: Challenge = Object.freeze({
      generatorVersion: 'gen-001.v1', rulesVersion: 'core-001.v2', seed, profile,
      config: cfg,
      blocked: Object.freeze(blocked.map(([r,c]) => Object.freeze([r,c] as const))),
      cells: Object.freeze(grid.map(row => Object.freeze([...row]))),
      offers: Object.freeze(supply.slice(0,3)),
      futurePieces: Object.freeze(supply.slice(3)),
      turnsUsed: 0, score: 0, status: 'in_progress',
    });
    return { ok: true, challenge };
  }
  return { ok: false, code: 'generation_exhausted' };
}
