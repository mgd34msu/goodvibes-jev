/**
 * Wiring the `google` tool to this process's stores.
 *
 * Split out of `bootstrap-core.ts` because it is the one tool whose options
 * carry a genuine argument rather than a value: WHY the write ports are here
 * at all, and why they are unscoped. That reasoning is several paragraphs and
 * it belongs next to the wiring, not buried in a file that registers thirty
 * other things.
 *
 * The native Gmail/Calendar route. The operator contract catalogs `email.send`
 * and `calendar.events.list` with `invokable: false`, no daemon serves them,
 * so this is the route the capability index points at.
 */

import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { registerAgentGoogleTool } from '../tools/agent-google-tool.ts';
import { startLoopbackListener } from '@goodvibes-jev/engine/sdk/platform/google/node';
import { getOutwardApprovalStore, OUTWARD_APPROVAL_GESTURE } from '../trust/outward-approvals.ts';
import type { ConfigManager, SecretsManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { retainGoogleConnectionOwners } from '../tools/agent-google-admission.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';

/** The slice of the runtime this wiring needs. Nothing wider. */
export interface GoogleToolWiringDeps {
  readonly configManager: ConfigManager;
  readonly secretsManager: SecretsManager;
  readonly homeDirectory: string;
}

function readGoogleConfiguration(config: ConfigManager, key: string): unknown {
  let value: unknown = config.getRaw();
  for (const part of key.split('.')) {
    if (!value || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, part);
    if (!descriptor) return undefined;
    if (!('value' in descriptor)) throw new ToolInputProjectionError('held');
    value = descriptor.value;
  }
  return value;
}

export function captureGoogleConnectionCurrent(deps: GoogleToolWiringDeps): () => void {
  return retainGoogleConnectionOwners(deps);
}

export function wireAgentGoogleTool(registry: ToolRegistry, deps: GoogleToolWiringDeps): void {
  registerAgentGoogleTool(registry, {
    homeDirectory: deps.homeDirectory,
    configManager: deps.configManager,
    secretsManager: deps.secretsManager,
    configGet: (key: string) => readGoogleConfiguration(deps.configManager, key),
    secretGet: (key: string) => deps.secretsManager.get(key),
    captureConnectionCurrent: () => captureGoogleConnectionCurrent(deps),

    // Exact config and credential plans publish into their native owning stores.

    // Binding the port Google redirects back to is real machine I/O, so the
    // connector takes it as a port and the concrete listener is named here.
    loopback: startLoopbackListener,

    // Existing native approval records remain exact and one-use. Model refusal
    // text does not turn this separate control into a runtime fallback.
    approvals: getOutwardApprovalStore(),
    approvalGesture: OUTWARD_APPROVAL_GESTURE,
  });
}
