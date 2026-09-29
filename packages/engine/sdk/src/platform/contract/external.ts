/**
 * The external work seam (docs/design/contract-runner.md 8.4): surfaces and
 * partner apps that do not embed the contract runner dispatch, poll, cancel
 * and fetch contract work through an adapter with these four methods. The
 * in-process hosted adapter (hosted-sessions/contract-work-adapter.ts) and
 * the operator adapter (operator-sdk contract-work-adapter.ts) implement it.
 *
 * The types, the bridge and the mapping from a contract to a snapshot or a
 * result are declared in the wire contracts package, which the operator SDK
 * can reach and this package cannot be reached from; they are re-exported
 * here so the runner's barrel carries the whole seam.
 */
export {
  CONTRACT_WORK_STATUS,
  ContractExternalWorkBridge,
  contractWorkHandle,
  contractWorkProgress,
  contractWorkResult,
  contractWorkSnapshot,
} from '@goodvibes-jev/engine/contracts';
export type {
  ContractExternalWorkAdapter,
  ContractExternalWorkHandle,
  ContractExternalWorkRequest,
  ContractExternalWorkResult,
  ContractExternalWorkSnapshot,
  ContractExternalWorkStatus,
  ContractWorkFields,
} from '@goodvibes-jev/engine/contracts';
