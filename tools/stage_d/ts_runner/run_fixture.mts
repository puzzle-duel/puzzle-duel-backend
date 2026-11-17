#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import {
  applyMove,
  canonicalJsonV3,
  compareReplayToClientReport,
  parseGameState,
  parseInitialGameState,
  parseMove,
  replayCore001V3,
  sha256HexOfUtf8,
  stateHashV3,
  stateToJson,
  ValidationFailure,
} from '../../../src/engine/core001v3/index.mts';

const path = process.argv[2];
if (!path) {
  console.error('usage: run_fixture.mts <fixture.json>');
  process.exit(2);
}

const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const kind = (doc.kind as string) ?? 'fullMove';
const out: Record<string, unknown> = {
  engine: 'typescript',
  id: doc.id,
  kind,
};

try {
  switch (kind) {
    case 'hashOnly':
      hashOnly(doc, out);
      break;
    case 'parseOnly':
      parseOnly(doc, out);
      break;
    case 'replaySecurity':
      replaySecurity(doc, out);
      break;
    default:
      fullMove(doc, out);
  }
} catch (error) {
  if (error instanceof ValidationFailure) {
    out.ok = false;
    out.codes = error.wires;
  } else {
    throw error;
  }
}

process.stdout.write(JSON.stringify(out));

function hashOnly(doc: Record<string, unknown>, out: Record<string, unknown>): void {
  if (doc.id === 'V3-51') {
    const vectors: [string, unknown][] = [
      ['CV-01', {}],
      ['CV-02', { kind: 'spent' }],
      ['CV-03', { kind: 'piece', shape: 'circle', direction: 'up' }],
      ['CV-04', null],
      ['CV-05', 0],
      ['CV-06', 900],
      ['CV-07', 'ended'],
      ['CV-08', 'a"b'],
      ['CV-09', 'a\\b'],
    ];
    out.ok = true;
    out.atoms = vectors.map(([id, value]) => {
      const c = canonicalJsonV3(value);
      return { id, canonicalJson: c, sha256: sha256HexOfUtf8(c) };
    });
    return;
  }
  const state = parseGameState(doc.state);
  out.ok = true;
  out.stateHash = stateHashV3(state);
  out.canonicalJson = canonicalJsonV3(stateToJson(state));
}

function parseOnly(doc: Record<string, unknown>, out: Record<string, unknown>): void {
  try {
    const state =
      doc.initial === true
        ? parseInitialGameState(doc.state)
        : parseGameState(doc.state);
    out.ok = true;
    out.state = stateToJson(state);
    out.stateHash = stateHashV3(state);
  } catch (error) {
    if (error instanceof ValidationFailure) {
      out.ok = false;
      out.codes = error.wires;
      return;
    }
    throw error;
  }
}

function fullMove(doc: Record<string, unknown>, out: Record<string, unknown>): void {
  const requireInitial = doc.requireInitial !== false;
  let current;
  try {
    current =
      requireInitial
        ? parseInitialGameState(doc.initialState)
        : parseGameState(doc.initialState);
  } catch (error) {
    if (error instanceof ValidationFailure) {
      out.ok = false;
      out.reason = 'invalid_initial';
      out.codes = error.wires;
      return;
    }
    throw error;
  }
  const moves = (doc.moves as unknown[]) ?? [];
  const applied: unknown[] = [];
  for (const raw of moves) {
    const result = applyMove(current, parseMove(raw));
    if (result.kind === 'rejected') {
      out.ok = false;
      out.result = { kind: 'rejected', code: result.code };
      out.state = stateToJson(result.state);
      return;
    }
    if (result.kind === 'unsafe') {
      out.ok = false;
      out.result = { kind: 'unsafe', reason: result.reason };
      out.state = stateToJson(result.state);
      return;
    }
    applied.push({
      landing: [result.landing.row, result.landing.column],
      turnsUsed: result.turnsUsed,
      scoreDelta: result.scoreDelta,
      waves: result.waves.map((w) => ({
        wave: w.wave,
        cleared: w.cleared.map((c) => [c.row, c.column]),
        scoreDelta: w.scoreDelta,
        moved: w.moved.map((m) => ({
          sourceIndex: m.sourceIndex,
          from: [m.from.row, m.from.column],
          to: [m.to.row, m.to.column],
          shape: m.shape,
          direction: m.direction,
        })),
      })),
      finalState: stateToJson(result.finalState),
      stateHash: stateHashV3(result.finalState),
    });
    current = result.finalState;
  }
  out.ok = true;
  out.finalState = stateToJson(current);
  out.stateHash = stateHashV3(current);
  out.canonicalJson = canonicalJsonV3(stateToJson(current));
  out.applied = applied;
}

function replaySecurity(doc: Record<string, unknown>, out: Record<string, unknown>): void {
  if (doc.id === 'V3-46') {
    const a = replayCore001V3({
      initialState: doc.trustedInitial,
      moves: doc.movesA as unknown[],
    });
    const b = replayCore001V3({
      initialState: doc.trustedInitial,
      moves: doc.movesB as unknown[],
    });
    out.ok = true;
    out.hashA = a.ok ? a.stateHash : null;
    out.hashB = b.ok ? b.stateHash : null;
    out.hashesDiffer = out.hashA !== out.hashB;
    return;
  }
  if (doc.id === 'V3-45') {
    const replayed = replayCore001V3({
      initialState: doc.trustedInitial,
      moves: [],
    });
    const claimed = parseGameState(doc.claimedSnapshot);
    out.ok = true;
    out.replayFinalDiffersFromClaimed =
      replayed.ok &&
      JSON.stringify(stateToJson(replayed.finalState)) !==
        JSON.stringify(stateToJson(claimed));
    return;
  }
  if (doc.id === 'V3-42') {
    const replayed = replayCore001V3({
      initialState: doc.trustedInitial,
      moves: [],
    });
    if (!replayed.ok) {
      out.ok = false;
      out.replayOk = false;
      return;
    }
    const expected = stateToJson(replayed.finalState);
    const client = {
      ...(doc.clientReport as Record<string, unknown>),
      board: expected.cells,
      offers: expected.offers,
      turnsUsed: replayed.finalState.turnsUsed,
      status: replayed.finalState.status,
      terminalReason: replayed.finalState.terminalReason,
    };
    // Force forged score+hash from fixture while completing required fields.
    const report = doc.clientReport as Record<string, unknown>;
    client.score = report.score;
    client.stateHash = report.stateHash;
    const cmp = compareReplayToClientReport({
      replayed: replayed.finalState,
      client,
    });
    out.ok = true;
    out.replayOk = true;
    out.fullCompareOk = cmp.ok === true;
    out.mismatches = cmp.ok ? [] : cmp.mismatches;
    return;
  }
  out.ok = false;
  out.reason = 'unsupported_replay_security_id';
}
