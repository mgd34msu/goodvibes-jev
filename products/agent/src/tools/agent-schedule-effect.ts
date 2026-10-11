import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { assertProjectionExecution, type ToolInputProjector, type ToolRegistry, ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ShellPathService } from '@/runtime/index.ts';
import type { AgentConnectedHostConfigReader } from '../agent/routine-schedule-promotion.ts';
import { captureOperatorConnection } from '../agent/operator-connection-owner.ts';
import { captureOperatorAutomationTarget } from '../agent/operator-automation-target.ts';
import { executeOperatorMethodWithReceipt } from '../agent/operator-method-receipt.ts';
import { scheduleNextRouteLines } from '../agent/schedule-next-routes.ts';
import { getSessionUntrustedContentLedger } from '../trust/untrusted-content.ts';
import { agentArtifactEffectGuard, captureAgentExportPath } from './agent-artifact-effect.ts';

let nextScheduleCall = 0;
const captures = new WeakMap<object, { readonly shellPaths: ShellPathService; readonly configManager: AgentConnectedHostConfigReader;
  readonly connection: ReturnType<typeof captureOperatorConnection>;
  readonly selectedTarget?: { readonly id: string; readonly revision: string; readonly record: Readonly<Record<string, unknown>> } | undefined }>();

/** Resolve selected sources before any repair or model admission. */
export function createScheduleInputProjector(shellPaths: ShellPathService, configManager: AgentConnectedHostConfigReader): ToolInputProjector {
  return { async project(request) {
    request.assertCurrent(); request.signal?.throwIfAborted();
    const directory = shellPaths.workingDirectory;
    const workspace = captureAgentExportPath(directory, directory);
    const ledger = getSessionUntrustedContentLedger(), revisionOf = ledger.getPublicationRevision;
    const ledgerRevision = revisionOf.call(ledger);
    const connection = captureOperatorConnection(shellPaths, configManager, () => {
      request.signal?.throwIfAborted();
      if (shellPaths.workingDirectory !== directory) throw new ToolInputProjectionError('stale');
      if (getSessionUntrustedContentLedger() !== ledger || ledger.getPublicationRevision !== revisionOf
        || revisionOf.call(ledger) !== ledgerRevision) throw new ToolInputProjectionError('stale');
      workspace.assertCurrent();
    });
    const assertCurrent = () => { request.assertCurrent(); connection.assertCurrent(); };
    assertCurrent();
    let selectedTarget: { readonly id: string; readonly revision: string; readonly record: Readonly<Record<string, unknown>> } | undefined;
    if (request.name === 'agent_schedule_edit') {
      const id = [request.args.scheduleId, request.args.jobId].find(value => typeof value === 'string' && value.trim());
      if (typeof id !== 'string') throw new ToolInputProjectionError('held');
      const targetId = id.trim();
      const native = await captureOperatorAutomationTarget('automation.jobs.update', { jobId: targetId }, connection,
        { signal: request.signal, assertCurrent });
      assertCurrent();
      const revision = native.wireFields.expectedMutationRevision;
      if (typeof revision !== 'string' || !revision || !native.originalTarget) throw new ToolInputProjectionError('held');
      selectedTarget = Object.freeze({ id: targetId, revision, record: native.originalTarget });
    }
    const context = Object.freeze({});
    captures.set(context, { shellPaths, configManager, connection, selectedTarget });
    return { status: 'projected', args: request.args, executionContext: context, assertCurrent,
      async release() { captures.delete(context); } };
  } };
}

/** A connection/workspace restriction accompanies each newly admitted operator child. */
export function captureScheduleEffect(rawArgs: Record<string, unknown>, options: Parameters<Tool['execute']>[1],
  shellPaths: ShellPathService, configManager: AgentConnectedHostConfigReader, registry: ToolRegistry) {
  const assertEffect = agentArtifactEffectGuard(rawArgs, options);
  assertEffect();
  const context = options?.inputProjectionContext, capture = context && captures.get(context);
  if (!context || !capture || capture.shellPaths !== shellPaths || capture.configManager !== configManager) throw new ToolInputProjectionError('held');
  const assertSource = () => {
    assertProjectionExecution(context, rawArgs); capture.connection.assertCurrent();
  };
  const assertCurrent = () => { assertEffect(); assertSource(); };
  assertCurrent();
  const invokeReceipt = async (methodId: string, input: Record<string, unknown>) => {
    assertCurrent();
    const receipt = await executeOperatorMethodWithReceipt(registry, `schedule-operator-${++nextScheduleCall}`, methodId,
      input, options, { signal: options?.signal, assertCurrent: assertSource });
    assertCurrent();
    return receipt;
  };
  return {
    assertCurrent,
    async invoke(methodId: string, input: Record<string, unknown>): Promise<Awaited<ReturnType<Tool['execute']>>> {
      let payload = input;
      if (methodId === 'automation.jobs.update') {
        const target = capture.selectedTarget;
        if (!target || target.id !== input.jobId) throw new ToolInputProjectionError('held');
        payload = { ...input, expectedMutationRevision: target.revision, admission: 'autonomous' };
      }
      const receipt = await invokeReceipt(methodId, payload);
      assertCurrent();
      if (receipt.kind === 'held' && receipt.result.success) return { success: false, error: 'The native operator effect receipt is unavailable.' };
      if (receipt.kind === 'received') {
        const body = receipt.body;
        if (!body || typeof body !== 'object' || Array.isArray(body) || !('id' in body) || typeof body.id !== 'string'
          || !body.id.trim() || (methodId === 'automation.jobs.update' && body.id !== input.jobId)) {
          return { success: false, error: 'The native schedule effect returned no matching schedule receipt.', output: receipt.result.output };
        }
      }
      return receipt.result;
    },
  };
}

/** Redacted child output is used only for presentation, never as effect authority. */
export function formatScheduleOperatorResult(result: Awaited<ReturnType<Tool['execute']>>, heading: string): Awaited<ReturnType<Tool['execute']>> {
  if (!result.success || !result.output) return result;
  let displayId = '(unknown)';
  try {
    const receipt: unknown = JSON.parse(result.output);
    if (receipt && typeof receipt === 'object' && !Array.isArray(receipt) && 'body' in receipt) {
      const body = receipt.body;
      if (body && typeof body === 'object' && !Array.isArray(body) && 'id' in body && typeof body.id === 'string') displayId = body.id;
    }
  } catch { /* The redacted receipt remains available as display text. */ }
  return { success: true, output: [heading, ...scheduleNextRouteLines(displayId), result.output].join('\n') };
}
