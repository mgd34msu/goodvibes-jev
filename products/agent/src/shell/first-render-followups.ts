/**
 * first-render-followups.ts, everything main.ts starts once the first frame is
 * on screen.
 *
 * Split out of main.ts when that module passed the 800-line ceiling, along the
 * seam its own comments already drew: each of these lands as ambient context
 * and none of them may block the first paint. Keeping them together is what
 * makes that rule checkable, a new startup step added here is visibly after
 * the render, not buried among the wiring above it.
 */
import type { SessionPersistenceAndRecoveryDeps, SessionPersistenceAndRecoveryResult } from './startup-wiring.ts';
import { wireSessionPersistenceAndRecovery, wireSetupIncompleteHint } from './startup-wiring.ts';
import { localModelCookbook } from '../tools/agent-harness-model-routing.ts';
import { localModelSetupStatus } from '../tools/agent-harness-setup-model-helpers.ts';
import { startHardwareProbe } from '../core/hardware-profile.ts';

// Re-exported so main.ts, which sits against the 800-line architecture cap,
// names the boot-followup module once instead of importing the prompt type
// from a second path.
export type { DaemonRepairPrompt } from './daemon-repair-prompt.ts';

export interface FirstRenderFollowupDeps extends Omit<SessionPersistenceAndRecoveryDeps, 'uiServicesTurns'> {
  readonly shellPaths: Parameters<typeof wireSetupIncompleteHint>[0]['shellPaths'];
  readonly providerRegistry: { readonly getCurrentModel: () => { readonly id?: string } | null | undefined };
  readonly commandContext: Parameters<typeof localModelCookbook>[0];
  readonly autonomy: { readonly announceAwayDigest: () => void };
  readonly uiServicesTurns: SessionPersistenceAndRecoveryDeps['uiServicesTurns'];
}

export function startFirstRenderFollowups(deps: FirstRenderFollowupDeps): SessionPersistenceAndRecoveryResult {
  const {
    autonomy,
    buildCurrentSessionSnapshot,
    commandContext,
    conversation,
    hookDispatcher,
    homeDirectory,
    onStreamSpeedUpdate,
    providerRegistry,
    render,
    runtime,
    shellPaths,
    surface,
    systemMessageRouter,
    uiServicesTurns,
    unsubs,
    workingDir,
    daemonRepair,
    askWorkspaceRegistration,
  } = deps;

  // Async GPU probe runs off the render frame, nvidia-smi result will populate
  // the module cache and appear on the next render cycle after it completes.
  startHardwareProbe();

  // Away digest runs after the first render so it lands as ambient context,
  // never a startup blocker.
  autonomy.announceAwayDigest();

  // If setup is in-progress (user has opened /agent but not finished), show a
  // gentle plain-language reminder and point them back to /agent.
  wireSetupIncompleteHint({
    shellPaths,
    providerReady: (() => {
      try { return Boolean(providerRegistry.getCurrentModel()?.id); } catch { return false; }
    })(),
    // localReady mirrors the 'local-model-readiness' plan item from buildSetupPlan:
    // cookbook status === 'detected-local-route'. Best-effort, never blocks render.
    localReady: (() => {
      try { return localModelSetupStatus(localModelCookbook(commandContext, false) as Record<string, unknown>) === 'ready'; } catch { return false; }
    })(),
    // hostReady is intentionally omitted: at startup the external-services stub
    // always reports mode='external', which would produce a misleading 'active'
    // line before any real probe has run. Omitting it keeps the hint honest.
    systemMessageRouter,
  });

  // Wire streaming-speed metrics, auto-save, and recovery, all run after the
  // first render so they land as ambient context, never startup blockers.
  return wireSessionPersistenceAndRecovery({
    buildCurrentSessionSnapshot,
    runtime,
    conversation,
    workingDir,
    homeDirectory,
    surface,
    systemMessageRouter,
    render,
    unsubs,
    uiServicesTurns,
    hookDispatcher,
    onStreamSpeedUpdate,
    daemonRepair,
    askWorkspaceRegistration,
  });
}
