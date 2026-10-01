/**
 * work-tree-wiring.ts, connecting the conversation work tree to the live
 * runtime: the timing store fed by tool and turn events, agent lanes read
 * from the agent manager (contracts from the contract runner, cost from
 * the fleet read model), the call a permission prompt is holding, and the
 * per-session fold state.
 *
 * One call from main.ts; everything the work tree reads at render time goes
 * through the WorkTreeSources this installs.
 */

import type { AgentManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ContractView } from '@goodvibes-jev/engine/sdk/platform/contract';
import type { ProcessNode } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import type { ConversationMessageSnapshot } from '@goodvibes-jev/engine/sdk/platform/core';
import type { UiRuntimeEvents } from '@/runtime/index.ts';
import type { ConversationManager } from './conversation.ts';
import { WorkTreeTimingStore, userMessageFingerprint, type AgentLaneInfo, type TurnOutcome } from './work-tree-sources.ts';
import { loadWorkTreeFolds, loadWorkTreeTurnOutcomes, saveWorkTreeFolds, sweepOrphanWorkTreeFolds } from './work-tree-fold-store.ts';
import { onSemanticSummaryReady } from '../renderer/lane-graph/semantic-memo.ts';

type AgentRecord = ReturnType<AgentManager['list']>[number];

export interface WorkTreeWiringDeps {
  readonly conversation: ConversationManager;
  readonly events: UiRuntimeEvents;
  readonly agentManager: Pick<AgentManager, 'getStatus' | 'getConversationSnapshot'>;
  readonly listContracts: () => readonly ContractView[];
  /** Contract lifecycle/commit/owner events can arrive after the main turn stops. */
  readonly onContractsChanged?: ((listener: () => void) => (() => void)) | undefined;
  readonly fleetNodes: () => readonly ProcessNode[];
  /** The call id a permission prompt is holding, if any. */
  readonly pendingCallId: () => string | undefined;
  readonly turnActive: () => boolean;
  readonly sessionsDir: string;
  readonly sessionId: () => string;
  /** Repaint (a ◈ summary of an opened edit landed). */
  readonly requestRender: () => void;
}

/** A finished agent's transcript never changes: read it once. */
interface SnapshotMemo { readonly stamp: string; readonly messages: readonly ConversationMessageSnapshot[] }

export interface WorkTreeWiring {
  readonly timings: WorkTreeTimingStore;
  readonly unsubs: Array<() => void>;
  readonly syncSession: () => void;
}

export function wireWorkTree(deps: WorkTreeWiringDeps): WorkTreeWiring {
  const timings = new WorkTreeTimingStore();
  const unsubs: Array<() => void> = [];
  const { conversation, events } = deps;
  if (deps.onContractsChanged) unsubs.push(deps.onContractsChanged(() => { conversation.workTree.invalidate(); deps.requestRender(); }));

  unsubs.push(events.tools.on('TOOL_EXECUTING', (ev) => timings.callStarted(ev.callId, ev.startedAt)));
  unsubs.push(events.tools.on('TOOL_SUCCEEDED', (ev) => timings.callSettled(ev.callId, ev.durationMs, Date.now())));
  unsubs.push(events.tools.on('TOOL_FAILED', (ev) => timings.callSettled(ev.callId, ev.durationMs, Date.now())));
  unsubs.push(events.tools.on('TOOL_CANCELLED', (ev) => timings.callSettled(ev.callId, undefined, Date.now())));
  // Everything the session sidecar keeps: fold decisions and failed/cancelled turn endings.
  const persistView = (): void => saveWorkTreeFolds(deps.sessionsDir, deps.sessionId(), conversation.workTree.foldState(), conversation.workTree.turnOutcomes());

  unsubs.push(events.turns.on('TURN_SUBMITTED', () => {
    const snapshot = conversation.getMessageSnapshot();
    for (let i = snapshot.length - 1; i >= 0; i--) {
      if (snapshot[i]!.role === 'user') { timings.turnStarted(i, Date.now(), userMessageFingerprint(snapshot[i])); break; }
    }
  }));
  const endTurn = (outcome: TurnOutcome): void => {
    const ended = timings.turnEnded(Date.now(), outcome);
    // The header drops "working" and states a failure on the next build.
    conversation.workTree.invalidate();
    if (!ended || ended.timing.fingerprint === undefined) return;
    if (conversation.workTree.recordTurnOutcome({ index: ended.index, fingerprint: ended.timing.fingerprint, outcome })) persistView();
  };
  unsubs.push(events.turns.on('TURN_COMPLETED', (ev) => endTurn(ev.stopReason === 'empty_response' ? 'failed' : 'completed')));
  unsubs.push(events.turns.on('TURN_ERROR', () => endTurn('failed')));
  unsubs.push(events.turns.on('TURN_CANCEL', () => endTurn('cancelled')));
  unsubs.push(events.turns.on('PREFLIGHT_FAIL', () => endTurn('failed')));
  // A new or resumed transcript: turn timings are keyed by message index and belong to the old one.
  unsubs.push(conversation.workTree.onReset(() => timings.clear()));

  const snapshots = new Map<string, SnapshotMemo>();
  const messagesOf = (record: AgentRecord): readonly ConversationMessageSnapshot[] => {
    const finished = record.status !== 'running' && record.status !== 'pending';
    const stamp = `${record.status}:${record.completedAt ?? ''}:${record.toolCallCount}`;
    const memo = snapshots.get(record.id);
    if (finished && memo && memo.stamp === stamp) return memo.messages;
    const messages = deps.agentManager.getConversationSnapshot(record.id);
    if (finished) snapshots.set(record.id, { stamp, messages });
    return messages;
  };

  const costOf = (agentId: string): number | undefined => {
    const node = deps.fleetNodes().find((n) => n.id === agentId);
    // Only a real reading: an unpriced node has no cost to state.
    return node && node.costState !== 'unpriced' && typeof node.costUsd === 'number' ? node.costUsd : undefined;
  };

  const agent = (agentId: string): AgentLaneInfo | null => {
    const record = deps.agentManager.getStatus(agentId);
    const contract = deps.listContracts().find((view) => view.ownerAgentId === agentId);
    if (!record && !contract) return null;
    if (!record && contract) return {
      id: agentId, name: 'owner', task: contract.ask,
      status: contract.status === 'passed' ? 'completed' : contract.status === 'failed' ? 'failed' : contract.status === 'cancelled' ? 'cancelled' : 'running',
      startedAt: contract.createdAt, completedAt: contract.completedAt,
      toolCallCount: 0, costUsd: costOf(agentId), messages: [], contract,
    };
    if (!record) return null;
    return {
      id: record.id,
      name: record.template,
      task: record.task,
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      toolCallCount: record.toolCallCount,
      costUsd: costOf(record.id),
      error: record.error,
      messages: contract ? [] : messagesOf(record),
      contract,
    };
  };

  conversation.setWorkTreeSources({
    callTiming: (callId) => timings.callTiming(callId),
    turnTiming: (index) => timings.turnTiming(index),
    agent,
    waitingCallIds: () => {
      const id = deps.pendingCallId();
      return id ? new Set([id]) : new Set<string>();
    },
    turnActive: deps.turnActive,
    turnOutcome: (index) => conversation.workTree.turnOutcome(index),
    now: () => Date.now(),
  });

  // Fold decisions persist per session, beside the session file.
  conversation.workTree.onFoldChange(persistView);
  sweepOrphanWorkTreeFolds(deps.sessionsDir);
  unsubs.push(onSemanticSummaryReady(() => { conversation.workTree.invalidate(); deps.requestRender(); }));
  // Agent resumes sessions through multiple routes; restore folds once per new session.
  let syncedSession: string | undefined;
  const syncSession = (): void => {
    const current = deps.sessionId();
    if (current === syncedSession) return;
    syncedSession = current;
    restoreWorkTreeFolds(conversation, deps.sessionsDir, current);
  };
  return { timings, unsubs, syncSession };
}

/**
 * Restore a resumed session's fold decisions and failed/cancelled turn
 * endings (called by the resume routine, after the transcript is restored).
 */
export function restoreWorkTreeFolds(conversation: ConversationManager, sessionsDir: string, sessionId: string): number {
  const entries = loadWorkTreeFolds(sessionsDir, sessionId);
  conversation.workTree.restoreFoldState(entries);
  conversation.workTree.restoreTurnOutcomes(loadWorkTreeTurnOutcomes(sessionsDir, sessionId));
  return entries.length;
}
