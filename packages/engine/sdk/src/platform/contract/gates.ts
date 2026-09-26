/**
 * Quality gates: the configured commands (`contract.gates`) whose results are
 * contract evidence and a deterministic input to a check's outcome
 * (docs/design/contract-runner.md sections 4.3 and 4.6). A failing gate that
 * was not skipped means the unit cannot pass, whatever the readings say.
 *
 * This module holds the gate types now; `runContractGates`, `executeGateCommand`,
 * `getSkippedGateReason` and `loadPackageScripts` move here in ledger task R.3.
 */

/** One configured gate. */
export interface QualityGate {
  name: string;
  command: string;
  enabled: boolean;
}

/** The result of running one gate. */
export interface QualityGateResult {
  gate: QualityGate['name'];
  /** A skipped gate is recorded as passed, with the skip reason as its output. */
  passed: boolean;
  output: string;
  durationMs: number;
  /** True when the gate did not apply to the tree it ran against (for example, no script of that name). */
  skipped?: boolean | undefined;
}
