/**
 * PZD-53 personal-record unit tests (no live staging DB).
 * PostgreSQL integration tests live in player-personal-records-pg.test.mts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  difficultyForSubgameOrdinal,
  parsePracticeSyncBody,
  PRACTICE_PROVENANCE,
} from '../../../src/tournament/results/player-personal-records.mts';

test('ordinal maps to difficulty categories', () => {
  assert.equal(difficultyForSubgameOrdinal(1), 'easy');
  assert.equal(difficultyForSubgameOrdinal(2), 'easy');
  assert.equal(difficultyForSubgameOrdinal(3), 'easy');
  assert.equal(difficultyForSubgameOrdinal(4), 'medium');
  assert.equal(difficultyForSubgameOrdinal(5), 'medium');
  assert.equal(difficultyForSubgameOrdinal(6), 'hard');
  assert.equal(difficultyForSubgameOrdinal(0), null);
  assert.equal(difficultyForSubgameOrdinal(7), null);
});

test('practice sync accepts a bounded valid batch', () => {
  const parsed = parsePracticeSyncBody({
    records: [
      {
        difficulty: 'easy',
        score: 24500,
        rulesVersion: 'core-001.v2',
        generatorVersion: 'gen-001.v1',
        achievedAt: '2026-11-27T10:00:00.000Z',
        completionId: 'practice-1',
        localRevision: 1,
      },
    ],
  });
  assert.ok(parsed);
  assert.equal(parsed!.length, 1);
  assert.equal(parsed![0]!.score, 24500);
  assert.equal(parsed![0]!.difficulty, 'easy');
});

test('practice sync rejects tournament provenance or series fields', () => {
  assert.equal(
    parsePracticeSyncBody({
      records: [{
        difficulty: 'easy',
        score: 100,
        rulesVersion: 'core-001.v2',
        generatorVersion: 'gen-001.v1',
        achievedAt: '2026-11-27T10:00:00.000Z',
        completionId: 'x',
        localRevision: 1,
        source: 'tournament',
      }],
    }),
    null,
  );
  assert.equal(
    parsePracticeSyncBody({
      records: [{
        difficulty: 'easy',
        score: 100,
        rulesVersion: 'core-001.v2',
        generatorVersion: 'gen-001.v1',
        achievedAt: '2026-11-27T10:00:00.000Z',
        completionId: 'x',
        localRevision: 1,
        provenance: 'tournament_f2b_verified_subgame',
      }],
    }),
    null,
  );
  assert.equal(
    parsePracticeSyncBody({
      records: [{
        difficulty: 'easy',
        score: 100,
        rulesVersion: 'core-001.v2',
        generatorVersion: 'gen-001.v1',
        achievedAt: '2026-11-27T10:00:00.000Z',
        completionId: 'x',
        localRevision: 1,
        seriesId: '00000000-0000-0000-0000-000000000001',
      }],
    }),
    null,
  );
});

test('practice sync rejects invalid score, difficulty, and unsupported versions', () => {
  const base = {
    difficulty: 'easy',
    score: 100,
    rulesVersion: 'core-001.v2',
    generatorVersion: 'gen-001.v1',
    achievedAt: '2026-11-27T10:00:00.000Z',
    completionId: 'x',
    localRevision: 1,
  };
  assert.equal(parsePracticeSyncBody({ records: [{ ...base, score: -1 }] }), null);
  assert.equal(parsePracticeSyncBody({ records: [{ ...base, difficulty: 'EASY' }] }), null);
  assert.equal(parsePracticeSyncBody({ records: [{ ...base, rulesVersion: 'core-999' }] }), null);
  assert.equal(parsePracticeSyncBody({ records: [] }), null);
  assert.equal(parsePracticeSyncBody({ records: Array.from({ length: 17 }, (_, i) => ({
    ...base,
    difficulty: 'easy',
    completionId: `c-${i}`,
    localRevision: i + 1,
  })) }), null);
});

test('practice sync rejects duplicate difficulty keys in one batch', () => {
  const row = {
    difficulty: 'easy',
    score: 100,
    rulesVersion: 'core-001.v2',
    generatorVersion: 'gen-001.v1',
    achievedAt: '2026-11-27T10:00:00.000Z',
    completionId: 'a',
    localRevision: 1,
    provenance: PRACTICE_PROVENANCE,
  };
  assert.equal(
    parsePracticeSyncBody({
      records: [row, { ...row, completionId: 'b', localRevision: 2, score: 200 }],
    }),
    null,
  );
});

test('practice sync allows explicit practice provenance', () => {
  const parsed = parsePracticeSyncBody({
    records: [{
      difficulty: 'medium',
      score: 0,
      rulesVersion: 'core-001.v2',
      generatorVersion: 'gen-001.v1',
      achievedAtMs: 1_732_000_000_000,
      completionId: 'practice-zero',
      localRevision: 2,
      provenance: PRACTICE_PROVENANCE,
      source: 'practice',
    }],
  });
  assert.ok(parsed);
  assert.equal(parsed![0]!.score, 0);
});
