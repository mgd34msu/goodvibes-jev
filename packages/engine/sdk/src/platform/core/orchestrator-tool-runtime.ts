import { autonomousRevision, type AutonomousToolSource } from '../permissions/autonomous.js';
import type { PreparedToolCall } from '../tools/registry.js';
import type { AutonomousPermissionAdmission } from '../permissions/manager.js';
import type { TurnHookOwner } from '../hooks/turn-ownership.js';
import { ToolError, PermissionError } from '../types/errors.js';
import type { HookEvent, HookEventPath, HookResult } from '../hooks/types.js';
import type { ToolCall, ToolResult } from '../types/tools.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { PermissionManager } from '../permissions/manager.js';
import { buildToolDenial, buildDenialErrorMessage } from '../permissions/denial.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import {
  emitContractSpawnGuardTriggered,
  emitToolExecuting,
  emitToolFailed,
  emitToolPermissioned,
  emitToolReconciled,
  emitToolReceived,
  emitToolSucceeded,
  toToolResultSummary,
} from '../runtime/emitters/index.js';
import { buildSyntheticResult, detectUnresolvedToolCalls, type ReconciliationReason } from './tool-reconciliation.js';
import { logger } from '../utils/logger.js';
import type { ConfigManager } from '../config/manager.js';
import type { AgentManager } from '../tools/agent/index.js';
import type { AgentInput } from '../tools/agent/schema.js';
import type { ExecutionPlan, ExecutionPlanManager, PlanItem } from './execution-plan.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { evaluateOrchestrationSpawn } from '../runtime/orchestration/spawn-policy.js';
import { summarizeError } from '../utils/error-display.js';
import { isActiveAgent } from '../tools/agent/predicates.js';
import { withCostOriginAsync, mcpServerOfToolName } from '../runtime/cost/cost-origin.js';

type HookDispatcherLike = {
  fire(event: HookEvent): Promise<HookResult>;
};

/**
 * Prefers `checkDetailed()` (carries `modifiedArgs` for per-hunk edit
 * approval) but falls back to the boolean-only `check()` for any caller
 * that injects a duck-typed permission manager stub without it (e.g. test
 * doubles built before `checkDetailed` existed). Mirrors the same
 * defensive duck-typing already used by the phased tool executor's
 * permission phase.
 */
async function resolvePermissionCheck(
  permissionManager: Pick<PermissionManager, 'checkDetailed' | 'check'> | { check: PermissionManager['check'] },
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  hookOwner?: TurnHookOwner,
): Promise<import('../permissions/types.js').PermissionCheckResult> {
  const manager = permissionManager as {
    checkDetailed?: PermissionManager['checkDetailed'];
    check: PermissionManager['check'];
  };
  if (typeof manager.checkDetailed === 'function') {
    return manager.checkDetailed(toolName, args, undefined, { signal, hookOwner });
  }
  const approved = await manager.check(toolName, args, undefined, { signal, hookOwner });
  return {
    approved,
    persisted: false,
    sourceLayer: approved ? 'config_policy' : 'user_prompt',
    reasonCode: approved ? 'config_allow' : 'user_denied',
    analysis: {
      classification: 'generic',
      riskLevel: 'medium',
      summary: `Permission ${approved ? 'approved' : 'denied'} for ${toolName}`,
      reasons: [],
    },
  };
}

type EmitterContextFactory = (turnId: string) => import('../runtime/emitters/index.js').EmitterContext;

export type ToolExecutionDeps = {
  /** Trusted native lifecycle decorator over the same shared recorded transport. */
  autonomousPort?: ((port: import('@goodvibes-jev/judgment').JudgmentPort) => import('@goodvibes-jev/judgment').JudgmentPort) | undefined;
  /** Current source supplied by the real turn/contract owner. Required for autonomous execution. */
  autonomousSource?: (() => AutonomousToolSource) | undefined;
  hookOwner?: TurnHookOwner | undefined;
  /** This execution's immutable whole-turn signal, never a later turn's controller. */
  turnSignal?: AbortSignal | undefined;
  toolRegistry: ToolRegistry;
  permissionManager: Pick<PermissionManager, 'checkDetailed' | 'check' | 'admitAutonomous' | 'autonomousPreparation'>;
  hookDispatcher: HookDispatcherLike | null;
  runtimeBus: RuntimeEventBus | null;
  sessionId: string;
  emitterContext: EmitterContextFactory;
  /**
   * Stage B: called once per executed tool with (toolName, resolved args, success) so a
   * code-index reindex scheduler can debounce an incremental reindex of touched files. Invoked
   * for BOTH success and failure (the scheduler no-ops on failure); never awaited, it must not
   * block the tool-result path.
   */
  onToolExecuted?: ((toolName: string, args: Record<string, unknown>, success: boolean) => void) | undefined;
  /**
   * Per-call cancellation seam: `open(callId)` yields the AbortSignal passed to
   * the tool body (registering the call as cancellable), `close(callId)`
   * retires it once the call settles. A cancel of ONE call aborts only that
   * call's signal, other calls in the batch and the turn itself continue.
   * Optional/undefined preserves the previous uncancellable behavior.
   */
  toolCallSignals?: {
    open(callId: string): AbortSignal;
    close(callId: string): void;
  } | undefined;
};

/** The human-readable per-call cancellation message the model sees. */
export const TOOL_CALL_CANCELLED_MESSAGE = 'cancelled by user';

/**
 * Normalize a settled (or thrown-through) result of a call whose per-call
 * signal was aborted into the structured cancelled shape: the model sees
 * "cancelled by user" with `cancelled: true`, keeping any partial output the
 * tool produced before it stopped. The tiny race where a tool completes
 * successfully in the same instant the user cancels still reports cancelled,
 * the user's decision is the truth the model should adapt to.
 */
function toCancelledResult(callId: string, settled: ToolResult | null): ToolResult {
  return {
    callId,
    success: false,
    error: TOOL_CALL_CANCELLED_MESSAGE,
    cancelled: true,
    ...(settled?.output !== undefined ? { output: settled.output } : {}),
    ...(settled?.autonomousDecision ? { autonomousDecision: settled.autonomousDecision } : {}),
  };
}

export async function executeToolCalls(
  deps: ToolExecutionDeps,
  turnId: string,
  calls: ToolCall[],
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  const turnSignal = deps.turnSignal;
  const assertTurnActive = () => turnSignal?.throwIfAborted();

  for (const originalCall of calls) {
    assertTurnActive();
    let call = { id: originalCall.id, name: originalCall.name, arguments: originalCall.arguments };
    let prepared: PreparedToolCall | undefined;
    let admission: AutonomousPermissionAdmission | undefined;
    // Production managers/registries use the migrated path. The boolean seam is
    // retained only for pre-existing duck-typed test/embedding implementations.
    const autonomous = typeof deps.permissionManager.admitAutonomous === 'function'
      && typeof deps.toolRegistry.prepareCall === 'function';
    const sourceId = autonomousRevision({ session: deps.sessionId, turn: turnId, call: call.id });
    const sourceOf = deps.autonomousSource;
    if (autonomous && !sourceOf) throw new Error('Autonomous execution requires the host source goal and criteria');
    const earlyCallSignal = autonomous ? deps.toolCallSignals?.open(call.id) : undefined;
    const admissionSignal = turnSignal && earlyCallSignal ? AbortSignal.any([turnSignal, earlyCallSignal]) : turnSignal ?? earlyCallSignal;
    try {
      if (autonomous) {
        const preparation = deps.permissionManager.autonomousPreparation(sourceId, sourceOf!, admissionSignal, deps.autonomousPort);
        prepared = await deps.toolRegistry.prepareCall(call.id, call.name, call.arguments, { ...(admissionSignal ? { signal: admissionSignal } : {}), port: preparation.port });
        preparation.assertCurrent();
        call = { id: prepared.callId, name: prepared.name, arguments: prepared.args };
      }
      if (deps.runtimeBus) {
        emitToolReceived(deps.runtimeBus, deps.emitterContext(turnId), {
          callId: call.id,
          turnId,
          tool: call.name,
          args: call.arguments,
        });
      }

      // Event observers and every awaited admission boundary can cancel the turn.
      assertTurnActive();
      let checkResult: import('../permissions/types.js').PermissionCheckResult;
      if (prepared) {
        const consumedRevisions: string[] = [];
        let permittedRevisionIds: readonly string[] | undefined;
        while (true) {
          const currentPrepared = prepared;
          admission = await deps.permissionManager.admitAutonomous(sourceId, currentPrepared.name, currentPrepared.args, { sourceOf: sourceOf!, decoratePort: deps.autonomousPort, signal: admissionSignal, hookOwner: deps.hookOwner, consumedRevisions, ...(permittedRevisionIds ? { permittedRevisionIds } : {}), schemaRevision: currentPrepared.schemaRevision, preparationDecisionIds: currentPrepared.judgmentDecisionIds, assertPrepared: () => deps.toolRegistry.assertPrepared(currentPrepared) });
          assertTurnActive();
          permittedRevisionIds ??= admission.revisionIds;
          checkResult = admission.result;
          if (!admission.revision) break;
          const revision = admission.revision;
          if (consumedRevisions.includes(revision.ref.id)) throw new Error('Autonomous revision was already consumed');
          consumedRevisions.push(revision.ref.id);
          const preparation = deps.permissionManager.autonomousPreparation(sourceId, sourceOf!, admissionSignal, deps.autonomousPort);
          prepared = await deps.toolRegistry.prepareCall(call.id, revision.toolName, revision.args, { ...(admissionSignal ? { signal: admissionSignal } : {}), port: preparation.port });
          preparation.assertCurrent();
          call = { id: prepared.callId, name: prepared.name, arguments: prepared.args };
        }
      } else {
        checkResult = await resolvePermissionCheck(deps.permissionManager, call.name, call.arguments, turnSignal, deps.hookOwner);
      }
      assertTurnActive();
      const approved = checkResult.approved;
      if (deps.runtimeBus) {
        emitToolPermissioned(deps.runtimeBus, deps.emitterContext(turnId), {
          callId: call.id,
          turnId,
          tool: call.name,
          approved,
          ...(checkResult.autonomousDecision ? { autonomousDecision: checkResult.autonomousDecision } : {}),
        });
      }
      assertTurnActive();
      if (!approved) {
        // Structured, call-scoped denial: the asking agent gets reason + scope on
        // the failed result (not just a bare string) and can continue honestly.
        // Plan-mode refusals surface reason 'plan-mode' with plan-steering text.
        const denialSource = { reasonCode: checkResult.reasonCode, sourceLayer: checkResult.sourceLayer, userReason: checkResult.userReason, detail: checkResult.detail };
        const err = new PermissionError(buildDenialErrorMessage(call.name, denialSource));
        const deniedResult = {
          callId: call.id,
          success: false,
          error: err.message,
          denial: buildToolDenial(denialSource),
          ...(checkResult.autonomousDecision ? { autonomousDecision: checkResult.autonomousDecision } : {}),
        };
        results.push(deniedResult);
        if (deps.runtimeBus) {
          emitToolFailed(deps.runtimeBus, deps.emitterContext(turnId), {
            callId: call.id,
            turnId,
            tool: call.name,
            error: err.message,
            durationMs: 0,
            result: toToolResultSummary(deniedResult),
          });
        }
        continue;
      }

      const startedAt = Date.now();
      if (deps.runtimeBus) {
        emitToolExecuting(deps.runtimeBus, deps.emitterContext(turnId), {
          callId: call.id,
          turnId,
          tool: call.name,
          startedAt,
        });
      }

      assertTurnActive();
      if (deps.hookDispatcher) {
        try {
          const preEvent: HookEvent = {
            path: `Pre:tool:${call.name}`,
            phase: 'Pre',
            category: 'tool',
            specific: call.name,
            sessionId: deps.sessionId,
            timestamp: Date.now(),
            payload: { callId: call.id, tool: call.name, args: call.arguments },
          };
          const preResult = await deps.hookDispatcher.fire(preEvent);
          assertTurnActive();
          if (preResult.decision === 'deny') {
            const deniedResult: ToolResult = {
              callId: call.id,
              success: false,
              error: preResult.reason ?? `Tool '${call.name}' denied by hook`,
            };
            if (deps.runtimeBus) {
              emitToolFailed(deps.runtimeBus, deps.emitterContext(turnId), {
                callId: call.id,
                turnId,
                tool: call.name,
                error: deniedResult.error ?? `Tool '${call.name}' denied by hook`,
                durationMs: Date.now() - startedAt,
                result: toToolResultSummary(deniedResult),
              });
            }
            results.push(deniedResult);
            continue;
          }
        } catch (hookErr) {
          logger.error('Orchestrator: Pre hook error', {
            tool: call.name,
            error: hookErr instanceof Error ? hookErr.message : String(hookErr),
          });
        }
      }

      // The hook catch deliberately tolerates hook failures, but cannot swallow
      // cancellation. No new call may acquire a fresh, un-aborted execution signal.
      assertTurnActive();
      let result: ToolResult;
      const perCallSignal = earlyCallSignal ?? deps.toolCallSignals?.open(call.id);
      const callSignal = turnSignal && perCallSignal ? AbortSignal.any([turnSignal, perCallSignal]) : turnSignal ?? perCallSignal;
      try {
        assertTurnActive();
        callSignal?.throwIfAborted();
        // Open a cost-attribution origin scope around the tool body: any LLM usage
        // a tool drives synchronously (e.g. an MCP tool's model call) is attributed
        // to this tool/MCP server rather than the agent's own reasoning.
        result = await withCostOriginAsync(
          { tool: call.name, callId: call.id, mcpServer: mcpServerOfToolName(call.name) },
          () => prepared && admission
            ? deps.toolRegistry.executePrepared(prepared, admission.claim, callSignal ? { signal: callSignal } : undefined)
            : deps.toolRegistry.execute(call.id, call.name, checkResult.modifiedArgs ?? call.arguments, callSignal ? { signal: callSignal } : undefined),
        );
        if (checkResult.autonomousDecision) result = { ...result, autonomousDecision: checkResult.autonomousDecision };
        if (callSignal?.aborted) {
          // The user cancelled THIS call mid-flight: the model sees a structured
          // cancelled result and the turn continues.
          result = toCancelledResult(call.id, result);
        }
      } catch (err) {
        const message = callSignal?.aborted
          ? TOOL_CALL_CANCELLED_MESSAGE
          : err instanceof ToolError
            ? err.message
            : err instanceof Error
              ? err.message
              : summarizeError(err);
        result = callSignal?.aborted
          ? toCancelledResult(call.id, null)
          : {
            callId: call.id,
            success: false,
            error: message,
          };

        if (deps.hookDispatcher && !turnSignal?.aborted) {
          try {
            const failEvent: HookEvent = {
              path: `Fail:tool:${call.name}`,
              phase: 'Fail',
              category: 'tool',
              specific: call.name,
              sessionId: deps.sessionId,
              timestamp: Date.now(),
              payload: { callId: call.id, tool: call.name, error: message },
            };
            await deps.hookDispatcher.fire(failEvent);
          } catch (hookErr) {
            logger.error('Orchestrator: Fail hook error', {
              tool: call.name,
              error: hookErr instanceof Error ? hookErr.message : String(hookErr),
            });
          }
        }
      } finally {
        if (!earlyCallSignal) deps.toolCallSignals?.close(call.id);
      }

      if (checkResult.autonomousDecision) result = { ...result, autonomousDecision: checkResult.autonomousDecision };
      // Do not race the tool promise: abort-ignoring work must actually return
      // before this throw allows the turn's terminal cancellation event.
      assertTurnActive();
      if (deps.hookDispatcher && result.success === true) {
        try {
          const postEvent: HookEvent = {
            path: `Post:tool:${call.name}`,
            phase: 'Post',
            category: 'tool',
            specific: call.name,
            sessionId: deps.sessionId,
            timestamp: Date.now(),
            payload: { callId: call.id, tool: call.name, result },
          };
          await deps.hookDispatcher.fire(postEvent);
        } catch (hookErr) {
          logger.error('Orchestrator: Post hook error', {
            tool: call.name,
            error: hookErr instanceof Error ? hookErr.message : String(hookErr),
          });
        }
      }

      assertTurnActive();
      if (deps.runtimeBus) {
        if (result.success) {
          emitToolSucceeded(deps.runtimeBus, deps.emitterContext(turnId), {
            callId: call.id,
            turnId,
            tool: call.name,
            durationMs: Date.now() - startedAt,
            result: toToolResultSummary(result),
          });
        } else {
          emitToolFailed(deps.runtimeBus, deps.emitterContext(turnId), {
            callId: call.id,
            turnId,
            tool: call.name,
            error: result.error ?? 'unknown tool failure',
            durationMs: Date.now() - startedAt,
            result: toToolResultSummary(result),
          });
        }
      }

      assertTurnActive();
      if (deps.hookDispatcher && (call.name === 'write' || call.name === 'edit')) {
        const filePath = typeof call.arguments['path'] === 'string' ? call.arguments['path'] :
          (Array.isArray(call.arguments['files']) ? JSON.stringify(call.arguments['files']) : '');
        const phase = result.success ? 'Post' : 'Fail';
        try {
          // This admitted file-hook dispatch belongs to the turn, exactly like
          // the tool hooks above. Await its existing bounded dispatcher promise;
          // do not manufacture settlement while it is still doing work.
          await deps.hookDispatcher.fire({
            path: `${phase}:file:${call.name}` as HookEventPath,
            phase,
            category: 'file',
            specific: call.name,
            sessionId: deps.sessionId,
            timestamp: Date.now(),
            payload: { tool: call.name, path: filePath, callId: call.id, ...(result.success ? {} : { error: result.error }) },
          });
        } catch (err) {
          logger.warn(`${phase}:file:${call.name} hook error`, { error: summarizeError(err) });
        }
        // A cancellation during dispatch cannot admit another tool or continue
        // the turn, including when the hook rejected and was logged above.
        assertTurnActive();
      }

      if (result.success && result.output && call.name === 'read') {
        try {
          const parsed = JSON.parse(result.output) as Record<string, unknown>;
          if (Array.isArray(parsed['images']) && (parsed['images'] as unknown[]).length > 0) {
            const images = parsed['images'] as Array<{ path: string; base64: string; mediaType: string; description: string }>;
            delete parsed['images'];
            if (parsed['files'] && typeof parsed['files'] === 'object') {
              for (const key of Object.keys(parsed['files'] as Record<string, unknown>)) {
                const f = (parsed['files'] as Record<string, unknown>)[key];
                if (f && typeof f === 'object') {
                  delete (f as Record<string, unknown>)['imageData'];
                }
              }
            }
            result.output = JSON.stringify(parsed);
            (result as ToolResult & { _images?: typeof images })._images = images;
          }
        } catch {
          // leave result as-is
        }
      }

      if (deps.onToolExecuted) {
        // Fire-and-forget: the scheduler only records a debounce timer; it must never block the
        // tool-result path. Args are the ones actually executed (post-permission modification).
        try {
          deps.onToolExecuted(call.name, checkResult.modifiedArgs ?? call.arguments, result.success === true);
        } catch (err) {
          logger.warn('onToolExecuted hook error', { tool: call.name, error: summarizeError(err) });
        }
      }

      results.push(result);
    } catch (error) {
      if (earlyCallSignal?.aborted && !turnSignal?.aborted) results.push(toCancelledResult(call.id, admission?.result.autonomousDecision
        ? { callId: call.id, success: false, autonomousDecision: admission.result.autonomousDecision } : null));
      else throw error;
    } finally {
      if (earlyCallSignal) deps.toolCallSignals?.close(call.id);
    }
  }

  assertTurnActive();
  return results;
}

export type ReconciliationDeps = {
  conversation: { addToolResults: (results: ToolResult[]) => void; addSystemMessage: (message: string) => void };
  runtimeBus: RuntimeEventBus | null;
  emitterContext: EmitterContextFactory;
  isReconciliationEnabled: () => boolean;
  currentSubmissionKey: string | null;
  pendingToolCalls: ToolCall[];
  setPendingToolCalls: (calls: ToolCall[]) => void;
};

export function reconcileUnresolvedToolCalls(
  deps: ReconciliationDeps,
  resolvedResults: ToolResult[],
  reason: ReconciliationReason,
): void {
  const pending = deps.pendingToolCalls;
  if (pending.length === 0) return;

  const unresolved = detectUnresolvedToolCalls(pending, resolvedResults);
  if (unresolved.length === 0) {
    deps.setPendingToolCalls([]);
    return;
  }

  if (!deps.isReconciliationEnabled()) {
    logger.warn(
      'Orchestrator: unresolved tool calls detected but reconciliation is disabled. ' +
      'Enable the tool-result-reconciliation flag to suppress this.',
      { count: unresolved.length, callIds: unresolved.map((c) => c.id), reason },
    );
    deps.setPendingToolCalls([]);
    return;
  }

  const syntheticResults = unresolved.map((call) => buildSyntheticResult(call, reason));
  deps.conversation.addToolResults(syntheticResults);

  const turnId = deps.currentSubmissionKey ?? `reconciled:${Date.now()}`;

  for (const sr of syntheticResults) {
    if (deps.runtimeBus) {
      emitToolFailed(deps.runtimeBus, deps.emitterContext(turnId), {
        callId: sr.callId,
        turnId,
        tool: unresolved.find((call) => call.id === sr.callId)?.name ?? 'unknown',
        error: sr.error ?? 'synthetic tool reconciliation failure',
        durationMs: 0,
        result: toToolResultSummary(sr),
      });
    }
  }

  deps.conversation.addSystemMessage(
    `[Tool Reconciliation] ${unresolved.length} tool call(s) (${unresolved.map((c) => `'${c.name}'`).join(', ')}) were not executed before ` +
    `the turn ended. Synthetic error results have been injected. ` +
    `Review the situation and avoid repeating the same tool calls if the root cause has not changed.`,
  );

  if (deps.runtimeBus) {
    emitToolReconciled(deps.runtimeBus, deps.emitterContext(turnId), {
      turnId,
      count: unresolved.length,
      callIds: unresolved.map((c) => c.id),
      toolNames: unresolved.map((c) => c.name),
      reason,
      timestamp: Date.now(),
    });
  }

  logger.warn('Orchestrator: reconciled unresolved tool calls', {
    count: unresolved.length,
    callIds: unresolved.map((c) => c.id),
    reason,
  });

  deps.setPendingToolCalls([]);
}

export function autoSpawnPendingItems(
  conversation: { addSystemMessage: (message: string) => void },
  plan: ExecutionPlan,
  items: PlanItem[],
  agentManager: Pick<AgentManager, 'list' | 'spawn'>,
  configManager: Pick<ConfigManager, 'get'>,
  providerRegistry: Pick<ProviderRegistry, 'getCurrentModel'>,
  runtimeBus: RuntimeEventBus | null = null,
  emitterContext: import('../runtime/emitters/index.js').EmitterContext | null = null,
  planManager: Pick<ExecutionPlanManager, 'updateItem'> | null = null,
): string[] {
  const currentModel = providerRegistry.getCurrentModel();
  const ctx = runtimeBus && emitterContext
    ? {
        ...emitterContext,
        traceId: `${emitterContext.traceId}:plan:${plan.id}`,
      }
    : null;

  let running = agentManager.list().filter(a => isActiveAgent(a)).length;
  const spawnDecision = evaluateOrchestrationSpawn({
    configManager,
    mode: 'plan-auto',
    activeAgents: running,
    requestedDepth: 1,
  });

  if (!spawnDecision.allowed) {
    if (runtimeBus && ctx) {
      emitContractSpawnGuardTriggered(runtimeBus, ctx, {
        agentId: 'conversation',
        depth: 1,
        activeAgents: running,
        reason: spawnDecision.reason ?? 'plan auto-spawn is currently blocked',
      });
    }
    return [];
  }

  const spawned: string[] = [];

  for (const item of items) {
    const decision = evaluateOrchestrationSpawn({
      configManager,
      mode: 'plan-auto',
      activeAgents: running,
      requestedDepth: 1,
    });
    if (!decision.allowed) {
      if (runtimeBus && ctx) {
        emitContractSpawnGuardTriggered(runtimeBus, ctx, {
          agentId: 'conversation',
          depth: 1,
          activeAgents: running,
          reason: decision.reason ?? 'plan auto-spawn is currently blocked',
        });
      }
      conversation.addSystemMessage(
        `[Plan] ${decision.reason ?? `Agent limit reached (${running}/${decision.maxAgents}). Remaining items will be spawned as agents complete.`}`
      );
      break;
    }

    try {
      const spawnInput: AgentInput = {
        mode: 'spawn',
        task: item.description,
        template: 'engineer',
        model: currentModel.registryKey,
        provider: currentModel.provider,
      };
      const agentRecord = agentManager.spawn(spawnInput);
      planManager?.updateItem(plan.id, item.id, 'in_progress', agentRecord.id);
      spawned.push(item.description);
      running++;
      logger.info('Orchestrator: Auto-spawned agent for plan item', {
        agentId: agentRecord.id,
        planItemId: item.id,
        description: item.description,
      });
    } catch (spawnErr) {
      logger.error('Orchestrator: Failed to auto-spawn agent for plan item', {
        planItemId: item.id,
        error: spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
      });
    }
  }

  return spawned;
}
