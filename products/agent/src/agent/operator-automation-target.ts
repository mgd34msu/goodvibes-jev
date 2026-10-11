import { captureStrictJudgmentJson } from '@goodvibes-jev/engine/sdk/platform/gate';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { isDeepStrictEqual } from 'node:util';
import { createDaemonOperatorInvoke } from './daemon-operator-client.ts';
import { findOperatorContractMethod } from './operator-contract-routes.ts';
import type { captureOperatorConnection } from './operator-connection-owner.ts';

const CREATED_METHODS = new Set(['automation.jobs.create', 'automation.schedules.create']);
const SELECTED_TARGETS: Readonly<Record<string, 'jobId' | 'scheduleId'>> = {
  'automation.jobs.update': 'jobId', 'automation.jobs.enable': 'jobId', 'automation.jobs.disable': 'jobId',
  'automation.jobs.delete': 'jobId', 'automation.schedules.enable': 'scheduleId',
  'automation.schedules.disable': 'scheduleId', 'automation.schedules.delete': 'scheduleId',
};
export interface OperatorAutomationTarget {
  readonly wireFields: Record<string, unknown>;
  /** Complete untouched native record stays in the registration's private scope. */
  readonly originalTarget?: Record<string, unknown> | undefined;
}

/** Native CAS identity is kept private and never supplied by model condition fields. */
export async function captureOperatorAutomationTarget(methodId: string, input: Record<string, unknown>,
  connection: ReturnType<typeof captureOperatorConnection>, options: { readonly signal?: AbortSignal | undefined; readonly assertCurrent: () => void }): Promise<OperatorAutomationTarget> {
  if (CREATED_METHODS.has(methodId)) return { wireFields: { admission: 'autonomous' } };
  const targetKey = SELECTED_TARGETS[methodId];
  if (!targetKey) return { wireFields: {} };
  const targetId = input[targetKey];
  if (typeof targetId !== 'string' || !targetId.trim()) throw new ToolInputProjectionError('held');
  const readMethod = findOperatorContractMethod('automation.schedules.list');
  const readSnapshot = captureStrictJudgmentJson(readMethod);
  const assertCurrent = () => {
    options.assertCurrent(); connection.assertCurrent();
    if (!readMethod || findOperatorContractMethod('automation.schedules.list') !== readMethod
      || !isDeepStrictEqual(captureStrictJudgmentJson(readMethod), readSnapshot)) throw new ToolInputProjectionError('stale');
  };
  assertCurrent();
  const receipt = await createDaemonOperatorInvoke(() => connection)('automation.schedules.list', {}, { signal: options.signal, assertCurrent });
  assertCurrent();
  if (!receipt.ok) throw new ToolInputProjectionError('held');
  const body = captureStrictJudgmentJson(receipt.body);
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('jobs' in body) || !Array.isArray(body.jobs)) throw new ToolInputProjectionError('held');
  const targets = body.jobs.filter((entry: unknown): entry is Record<string, unknown> => entry !== null && typeof entry === 'object'
    && !Array.isArray(entry) && 'id' in entry && entry.id === targetId);
  const target = targets.length === 1 ? targets[0] : undefined;
  if (!target || typeof target.mutationRevision !== 'string' || !target.mutationRevision) throw new ToolInputProjectionError('held');
  // A native parent may already retain an older target. Never advance it to a changed target.
  if (input.expectedMutationRevision !== undefined && input.expectedMutationRevision !== target.mutationRevision) throw new ToolInputProjectionError('stale');
  assertCurrent();
  return { originalTarget: target, wireFields: { admission: 'autonomous', expectedMutationRevision: target.mutationRevision } };
}
