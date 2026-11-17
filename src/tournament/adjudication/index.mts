export {
  validateUntrustedClientCommand,
  computeAuthoritativePayloadDigest,
  type UntrustedClientCommand,
  type UntrustedMovePayload,
  type ClientCommandValidation,
} from './client-commands.mts';

export {
  bindTrustedChallenge,
  digestInitialState,
  selfConsistentJsonHash,
  challengeBindingFingerprint,
  MemoryTrustedChallengeStore,
  type TrustedChallengeBinding,
  type TrustedChallengeStore,
} from './trusted-challenge.mts';

export {
  MemoryAcceptedMoveLedger,
  MemoryAuthoritativeSnapshotStore,
  type AcceptedMoveLedger,
  type AcceptedMoveLedgerEntry,
  type AuthoritativeGameSnapshot,
  type AuthoritativeSnapshotStore,
} from './move-ledger.mts';

export {
  TrustedGameplayService,
  type TrustedGameplayDecision,
  type TrustedGameplayServiceOptions,
  type RankedCommandHints,
  type ServerDerivedMoveEffect,
  type ServerMoveEffectResolver,
} from './trusted-gameplay.mts';

export {
  FailClosedAuthorizationGateway,
  MemoryVerifiedAuthorizationGateway,
  assertContextMatchesCommand,
  type TrustedAuthorizationContext,
  type TrustedPrincipal,
  type TrustedSession,
  type TrustedSeriesEntitlement,
  type AuthorizationGateway,
  type AuthorizationDecision,
  type AuthorizationFailureReason,
  type RankedCommandType,
} from './authorization.mts';

export {
  freezeAdmissionResult,
  type ImmutableAdmissionResult,
} from './admission-result.mts';

export {
  PostgresTrustedUnitOfWork,
  type UowFaultPoint,
  type UowFaultHooks,
  type AdjudicateMoveInput,
  type AdjudicateMoveResult,
} from './postgres-uow.mts';

export {
  PostgresTrustedChallengeStore,
  PostgresAcceptedMoveLedger,
  PostgresAuthoritativeSnapshotStore,
  TRUSTED_GAMEPLAY_DDL,
  ADMISSION_RESULT_DDL,
} from './postgres-stores.mts';
