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

/** The slice of the runtime this wiring needs. Nothing wider. */
export interface GoogleToolWiringDeps {
  readonly configManager: { get(key: string): unknown; setDynamic(key: string, value: unknown): void };
  readonly secretsManager: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
  readonly homeDirectory: string;
}

export function wireAgentGoogleTool(registry: ToolRegistry, deps: GoogleToolWiringDeps): void {
  registerAgentGoogleTool(registry, {
    homeDirectory: deps.homeDirectory,
    configGet: (key: string) => deps.configManager.get(key),
    secretGet: (key: string) => deps.secretsManager.get(key),

    // ── The write half ────────────────────────────────────────────────────
    //
    // Here so `connect.client` can finish what the setup walkthrough started.
    // Without these the tool could only ever tell the owner to go and run a
    // command with the two values he had just pasted into the conversation,
    // a chore handed over at the exact moment the platform held everything it
    // needed, which is precisely what the intent-completion rule forbids.
    //
    // No scope is passed, and that is deliberate. Every key the connector
    // writes derives from a daemon-owned config path, so the store files it in
    // the daemon tier by itself. Forcing a surface scope here would override
    // that and hide the credential from the daemon, the runtime that has to
    // answer mail at 3am, long after this surface has exited.
    configSet: (key: string, value: unknown) => { deps.configManager.setDynamic(key, value); },
    secretSet: (key: string, value: string) => deps.secretsManager.set(key, value),

    // Binding the port Google redirects back to is real machine I/O, so the
    // connector takes it as a port and the concrete listener is named here.
    loopback: startLoopbackListener,

    // The approval path, wired. It used to be absent, and the refusal invented
    // a remedy to fill the gap, telling the owner to reply "send it now" to a
    // mechanism no code implemented. A surface that supplies no store now gets
    // a refusal that says so plainly instead.
    approvals: getOutwardApprovalStore(),
    approvalGesture: OUTWARD_APPROVAL_GESTURE,
  });
}
