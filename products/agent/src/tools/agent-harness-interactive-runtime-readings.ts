import { interactiveRuntimeSchemaStatus, interactiveRuntimeKind, interactiveRuntimeStatus, interactiveRuntimeRouteRole,
  type InteractiveRuntimeRouteRole } from '@goodvibes-jev/engine/sdk/platform/gate';
import { booleanValue, ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { personalOpsEntry } from './agent-harness-personal-ops-source.ts';
import { withCanonicalReading } from './agent-harness-canonical-reading.ts';
import type { AgentHarnessInteractiveRuntimeKind, AgentHarnessInteractiveRuntimeStatus } from './agent-harness-interactive-runtime-records.ts';

export interface InteractiveRuntimeEvidence {
  readonly source: string;
  readonly containerPath: readonly string[];
  readonly record: Readonly<Record<string, unknown>>;
  readonly snapshot: unknown;
}

/** These functions are called only inside the complete protected runtime snapshot scope. */
export function readRuntimeSchema(evidence: InteractiveRuntimeEvidence, options: CatalogRankingOptions): Promise<'certified' | 'legacy'> {
  const site = 'agent.runtime.schema-status';
  return withCanonicalReading(site, [interactiveRuntimeSchemaStatus], options, async (port, assertCurrent, signal) => {
    const run = await interactiveRuntimeSchemaStatus.run(port, personalOpsEntry(evidence), { site, signal, beforeAttempt: assertCurrent });
    assertCurrent(); run.recordAction('read-only published schema interpretation');
    if (run.readings.certified.outcome !== 'act' || run.readings.certified.verdict === 'uncertain') throw new ToolInputProjectionError('held');
    return run.readings.certified.verdict === 'yes' ? 'certified' : 'legacy';
  });
}

export function readRuntimeKind(evidence: InteractiveRuntimeEvidence, options: CatalogRankingOptions): Promise<AgentHarnessInteractiveRuntimeKind> {
  const site = 'agent.runtime.kind';
  return withCanonicalReading(site, [interactiveRuntimeKind], options, async (port, assertCurrent, signal) => {
    const run = await interactiveRuntimeKind.run(port, personalOpsEntry(evidence), { site, signal, beforeAttempt: assertCurrent });
    assertCurrent(); run.recordAction('read-only published runtime kind interpretation');
    if (run.readings.kind.outcome !== 'act') throw new ToolInputProjectionError('held');
    return run.readings.kind.choice;
  });
}

export function readRuntimeStatus(evidence: InteractiveRuntimeEvidence, options: CatalogRankingOptions): Promise<AgentHarnessInteractiveRuntimeStatus> {
  const site = 'agent.runtime.status';
  return withCanonicalReading(site, [interactiveRuntimeStatus], options, async (port, assertCurrent, signal) => {
    const run = await interactiveRuntimeStatus.run(port, personalOpsEntry(evidence), { site, signal, beforeAttempt: assertCurrent });
    assertCurrent(); run.recordAction('read-only published runtime status interpretation');
    if (run.readings.status.outcome !== 'act') throw new ToolInputProjectionError('held');
    return run.readings.status.choice;
  });
}

export function readRuntimeRoute(evidence: InteractiveRuntimeEvidence & {
  readonly key: string; readonly value: unknown; readonly routeContainerPath: readonly string[];
}, options: CatalogRankingOptions): Promise<InteractiveRuntimeRouteRole> {
  const site = 'agent.runtime.route-role';
  return withCanonicalReading(site, [interactiveRuntimeRouteRole], options, async (port, assertCurrent, signal) => {
    const run = await interactiveRuntimeRouteRole.run(port, personalOpsEntry(evidence), { site, signal, beforeAttempt: assertCurrent });
    assertCurrent(); run.recordAction('read-only published runtime route interpretation');
    if (run.readings.role.outcome !== 'act') throw new ToolInputProjectionError('held');
    return run.readings.role.choice;
  });
}

export async function readRuntimeBoolean(evidence: InteractiveRuntimeEvidence, parameter: string, value: unknown,
  description: string, options: CatalogRankingOptions): Promise<boolean | undefined> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'false') return value === 'true';
  if (typeof value !== 'string') throw new ToolInputProjectionError('held');
  const site = 'agent.runtime.boolean-value';
  return withCanonicalReading(site, [booleanValue], options, async (port, assertCurrent, signal) => {
    const run = await booleanValue.run(port, personalOpsEntry({ tool: 'published interactive runtime record', parameter, value, description, evidence }),
      { site, signal, beforeAttempt: assertCurrent });
    assertCurrent(); run.recordAction('read-only published boolean interpretation');
    const reading = run.readings.boolean_value;
    if (reading.outcome !== 'act' || reading.choice === 'neither') throw new ToolInputProjectionError('held');
    return reading.choice === 'true';
  });
}
