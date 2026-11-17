import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControllableClock } from '../../../src/tournament/ingress/clock.mts';
import { MemoryAdmissionJournal } from '../../../src/tournament/ingress/journal.mts';
import { MemorySeriesFenceStore } from '../../../src/tournament/ingress/series-fence.mts';
import { idleDeadlineFrom } from '../../../src/tournament/ingress/types.mts';
import {
  TrustedGameplayService,
  bindTrustedChallenge,
  MemoryAcceptedMoveLedger,
  MemoryAuthoritativeSnapshotStore,
  MemoryTrustedChallengeStore,
  MemoryVerifiedAuthorizationGateway,
  type TrustedAuthorizationContext,
} from '../../../src/tournament/adjudication/index.mts';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const FIXTURE = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../docs/contracts/gameplay/v3/fixtures/V3-01-legal-placement.json',
    ),
    'utf8',
  ),
);

export const T0 = new Date('2026-11-17T12:00:00.000Z');

export function makeAuth(overrides?: Partial<{
  seriesKey: string;
  playerId: string;
  writerGeneration: number;
  ordinal: number;
  status: TrustedAuthorizationContext['series']['status'];
  deviceId: string;
  sessionId: string;
}>): TrustedAuthorizationContext {
  const playerId = overrides?.playerId ?? 'player-1';
  const seriesKey = overrides?.seriesKey ?? 'series-1';
  return {
    principal: { playerId },
    session: {
      sessionId: overrides?.sessionId ?? 'sess-1',
      deviceId: overrides?.deviceId ?? 'device-1',
      writerGeneration: overrides?.writerGeneration ?? 1,
    },
    series: {
      seriesKey,
      ownerPlayerId: playerId,
      activeSubgameOrdinal: overrides?.ordinal ?? 1,
      status: overrides?.status ?? 'ACTIVE',
    },
    authorizedAt: T0,
    authProofId: `proof-${seriesKey}-${playerId}`,
  };
}

export async function bootMemory(opts?: {
  auth?: TrustedAuthorizationContext;
  seriesKey?: string;
  playerId?: string;
  ordinal?: number;
}) {
  const seriesKey = opts?.seriesKey ?? 'series-1';
  const playerId = opts?.playerId ?? 'player-1';
  const ordinal = opts?.ordinal ?? 1;
  const clock = new ControllableClock(T0);
  const journal = new MemoryAdmissionJournal({ clock });
  const fence = new MemorySeriesFenceStore();
  const challenges = new MemoryTrustedChallengeStore();
  const ledger = new MemoryAcceptedMoveLedger();
  const snapshots = new MemoryAuthoritativeSnapshotStore();
  const authGw = new MemoryVerifiedAuthorizationGateway();
  const auth = opts?.auth ?? makeAuth({ seriesKey, playerId, ordinal });
  authGw.register(auth);

  await fence.put({
    seriesKey,
    boardRevision: 0,
    writerGeneration: auth.session.writerGeneration,
    status: 'ACTIVE',
    idleDeadlineAt: idleDeadlineFrom(T0, 300),
    hardCutoffAt: null,
    score: 0,
    resultsPublished: false,
    lastAppliedAdmissionId: null,
    thinkingExtensionConsumed: false,
  });
  const binding = bindTrustedChallenge({
    seriesKey,
    playerId,
    subgameOrdinal: ordinal,
    challengeId: 'chal-v3-01',
    generatorVersion: 'gen-001.v1-adapter-test',
    contentVersion: 'stage-e-test',
    initialStateRaw: FIXTURE.initialState,
    assignedAt: T0,
  });
  await challenges.put(binding);
  await snapshots.put({
    seriesKey,
    playerId,
    subgameOrdinal: ordinal,
    challengeId: binding.challengeId,
    boardRevision: 0,
    moveCursor: 0,
    stateHash: binding.initialStateDigest,
    score: 0,
    status: 'in_progress',
    terminalReason: null,
    state: binding.initialState,
    ledgerAdmissionSeq: 0,
    writerGeneration: auth.session.writerGeneration,
    producedByAdmissionId: null,
  });

  const service = new TrustedGameplayService({
    journal,
    fence,
    challenges,
    ledger,
    snapshots,
    clock,
    authorization: authGw,
    resolveActiveOrdinal: async () => ordinal,
  });

  return {
    service,
    fence,
    ledger,
    snapshots,
    challenges,
    binding,
    clock,
    journal,
    authGw,
    auth,
    seriesKey,
    playerId,
    ordinal,
    hints: {
      seriesKeyHint: seriesKey,
      playerIdHint: playerId,
      writerGenerationHint: auth.session.writerGeneration,
    },
  };
}

export function legalMoveCmd(idempotencyKey = 'm1', revision = 0, writer = 1) {
  return {
    commandType: 'move' as const,
    idempotencyKey,
    move: {
      offerIndex: 0 as const,
      tap: [0, 0] as [number, number],
      expectedBoardRevision: revision,
      writerGeneration: writer,
    },
  };
}
