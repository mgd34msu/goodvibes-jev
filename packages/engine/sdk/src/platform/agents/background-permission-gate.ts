// Background/subagent tool-call permission gate.
//
// Extracted from orchestrator-runner.ts so the runner stays focused on the
// turn loop. This module owns the single rule: a background agent's tool calls
// are brokered through the SAME session permission mode as the foreground turn
// loop, unless the escape-hatch config exempts them.
import type { PermissionManager } from '../permissions/manager.js';
import type { PermissionAttribution } from '../permissions/prompt.js';
import { buildToolDenial, buildDenialErrorMessage } from '../permissions/denial.js';
import type { ToolDenial } from '../types/tools.js';
import type { AgentRecord } from '../tools/agent/index.js';
import { assertPermissionActive, awaitPermission } from '../permissions/cancellation.js';

/** The narrow slice of PermissionManager the background gate consults. */
export type BackgroundPermissionManager = Pick<
  PermissionManager,
  'checkDetailed' | 'check' | 'getBackgroundAgentsMode' | 'passesBoundary'
> & Partial<Pick<PermissionManager, 'admitAutonomous' | 'autonomousPreparation'>>;

export type BackgroundPermissionOutcome =
  | { readonly approved: true; readonly modifiedArgs?: Record<string, unknown> | undefined }
  | { readonly approved: false; readonly error: string; readonly denial: ToolDenial };

/**
 * Broker a background/subagent tool call through the session permission mode.
 *
 * Mirrors the foreground tool-runtime's permission handling so a background
 * agent is subject to the SAME mode: 'inherit' (default) applies the mode's
 * allow/ask/refuse matrix (allow-all approves everything with zero new
 * friction; prompt/plan/accept-edits/custom apply as configured, with any ask
 * bubbling through the injected requestPermission handler carrying subagent
 * attribution). The escape-hatch `permissions.backgroundAgents: 'allow-all'`
 * exempts background agents from the presets and prompts, never from the
 * gate's deterministic boundary: a call the boundary refuses goes through the
 * full gate, which refuses it (or, for a tainted outward call, asks the owner).
 * When no manager is wired the call is left ungated (isolated contexts/tests).
 */
export async function gateBackgroundToolCall(
  context: { readonly permissionManager?: BackgroundPermissionManager | undefined },
  /**
   * `template` is OPTIONAL here, unlike on AgentRecord.
   *
   * The body has always treated it as optional, it emits the attribution's
   * `template` only when the record carries a truthy one, because
   * PermissionAttribution.template is itself optional. Requiring it came from
   * `Pick<AgentRecord, 'id' | 'template'>`, not from anything this function
   * does, and it made every caller that has an id and no archetype invent one.
   * Widening, so the real caller in orchestrator-runner.ts (which passes a full
   * AgentRecord) is unaffected.
   */
  record: Pick<AgentRecord, 'id'> & { readonly template?: AgentRecord['template'] | undefined },
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<BackgroundPermissionOutcome> {
  assertPermissionActive(signal);
  const manager = context.permissionManager;
  if (!manager) return { approved: true };
  if (manager.getBackgroundAgentsMode() === 'allow-all'
    && await awaitPermission(() => manager.passesBoundary(toolName, args, { signal }), signal)) return { approved: true };

  const attribution: PermissionAttribution = {
    kind: 'background-agent',
    agentId: record.id,
    ...(record.template ? { template: record.template } : {}),
  };
  const result = await awaitPermission(() => manager.checkDetailed(toolName, args, attribution, { signal }), signal);
  if (result.approved) {
    return result.modifiedArgs ? { approved: true, modifiedArgs: result.modifiedArgs } : { approved: true };
  }
  const source = { reasonCode: result.reasonCode, sourceLayer: result.sourceLayer, userReason: result.userReason, detail: result.detail };
  return {
    approved: false,
    error: buildDenialErrorMessage(toolName, source),
    denial: buildToolDenial(source),
  };
}
