/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Controller-compat (see CHANGELOG 0.38.0), stage 1 of the 3-stage WrfcController
 * migration.
 *
 * `fromChainSpec()` produces the canned single-phase engineer
 * WORKSTREAM SPEC that a `WrfcController.createChain(ownerRecord)` call
 * would otherwise start, a NEW opt-in surface for callers that want the
 * engine-backed pipeline. It returns a `CreateWorkstreamInput` (a spec), not
 * a live `Workstream`: realizing one (generated ids, initialized item
 * state) is the engine's own responsibility via
 * `engine.createWorkstream(fromChainSpec(...))`, mirroring how the type
 * model already separates PhaseSpec/WorkItemSpec (input) from Phase/WorkItem
 * (engine-owned state).
 *
 * STAGE 1 (this wave, unchanged): WrfcController itself is NOT touched.
 * spawn-forced-wrfc, /teamwork, and archetypes all keep hitting
 * WrfcController.createChain via AgentManager.manager.ts:565 exactly as
 * before. This function is additive only.
 * STAGE 2 (later, feature-flagged): WrfcController.createChain internally
 * builds a workstream via this same helper and delegates execution to the
 * engine, the public seam (createChain's signature and the three entry
 * points) stays byte-for-byte unchanged.
 * STAGE 3 (future wave): retire the standalone WrfcController state machine
 * once parity is proven.
 */
import type { AgentRecord } from '../tools/agent/manager.js';
import type { ConfigManager } from '../config/manager.js';
import type { WrfcCommitScope } from '../agents/wrfc-config.js';
import { getWrfcCommitScope } from '../agents/wrfc-config.js';
import type { CreateWorkstreamInput } from './engine.js';
import type { PhaseSpec } from './types.js';

/**
 * The canonical phase template: one engineer phase. Both the compat
 * single-chain bridge (`fromChainSpec`, capacity 1) and the multi-item
 * proposal assembly (`fromPlanProposal`, proposal-workstream.ts, capacity =
 * item count) build their phases from it, parameterized only by the capacity
 * knob so N proposal items can run concurrently (dependency-gated) while a
 * single chain stays at capacity 1. The review phase this template once had
 * is gone: the engine no longer reads a reviewer's verdict, since Jev judges a
 * contract unit while its agent works (docs/design/contract-runner.md 7.5).
 */
export function engineerPhases(commitScope: WrfcCommitScope, capacity = 1): PhaseSpec[] {
  return [{ role: 'engineer', capacity, kind: 'engineer', gate: { scope: commitScope, gates: [] } }];
}

export function fromChainSpec(
  ownerRecord: Pick<AgentRecord, 'id' | 'task'>,
  configManager: Pick<ConfigManager, 'get' | 'getCategory'>,
): CreateWorkstreamInput {
  const commitScope = getWrfcCommitScope(configManager);
  return {
    title: ownerRecord.task,
    items: [{ id: ownerRecord.id, title: ownerRecord.task, task: ownerRecord.task }],
    phases: engineerPhases(commitScope, 1),
  };
}
