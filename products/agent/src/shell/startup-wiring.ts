import { logger, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { HookDispatcher, HookEventPath, HookPhase, HookCategory } from '@goodvibes-jev/engine/sdk/platform/hooks';
import {
  checkRecoveryFile,
  createShellPathService,
  formatReturnContextForDisplay,
  persistConversation,
  writeRecoveryFile,
} from '@/runtime/index.ts';
import type { SessionSnapshot, SessionSurface } from '@/runtime/index.ts';
import {
  readOnboardingCheckMarker,
  readOnboardingCompletionMarker,
} from '../runtime/onboarding/index.ts';
import { deriveOnboardingState } from '../runtime/onboarding/onboarding-state.ts';
import { buildSetupIncompleteHint } from '../core/setup-incomplete-hint.ts';
import { answerWorkspaceRegistrationPrompt, isBroadWorkspaceRoot, normalizeWorkspaceRoot, resolveWorkspaceRegistrationSync } from '../config/workspace-registration.ts';
import type { AskWorkspaceRegistration } from './workspace-registration-question.ts';
import { createDaemonRepairPrompt, type DaemonRepairPrompt } from './daemon-repair-prompt.ts';
import { createDaemonRepairSessionMemory, diagnoseDaemonRepair, type DaemonRepairConfig, type DaemonRepairSessionMemory } from '../runtime/daemon-repair.ts';
import type { DaemonCliRunner } from '../runtime/daemon-cli-service.ts';

export interface SessionPersistenceAndRecoveryDeps {
  readonly buildCurrentSessionSnapshot: () => SessionSnapshot;
  readonly runtime: { readonly sessionId: string; readonly model: string; readonly provider: string };
  readonly conversation: { readonly title?: string | null };
  readonly workingDir: string;
  readonly homeDirectory: string;
  /** Declare-once session-storage handle (platform/runtime/session-surface.ts); threaded through every persistConversation/checkRecoveryFile/writeRecoveryFile call below instead of loose workingDirectory/homeDirectory options. */
  readonly surface: SessionSurface;
  readonly systemMessageRouter: { high(message: string): void; low(message: string): void };
  readonly render: () => void;
  readonly unsubs: Array<() => void>;
  readonly uiServicesTurns: {
    on(event: 'TURN_COMPLETED' | 'STREAM_START' | 'STREAM_DELTA', handler: () => void): () => void;
  };
  readonly hookDispatcher: HookDispatcher;
  /**
   * Called whenever the computed stream-token speed changes so that main.ts
   * (which owns the render closure) can keep the value up to date.
   */
  readonly onStreamSpeedUpdate: (tokensPerSecond: number) => void;
  /**
   * The wedged-machine check (runtime/daemon-repair.ts). Absent in the narrow
   * test fixtures that only exercise persistence/recovery; when present, a
   * machine whose daemon is off in both places is offered the one-touch repair.
   */
  readonly daemonRepair?: {
    readonly config: DaemonRepairConfig;
    /** Defaults to a fresh per-process memory; injected only by tests that assert re-offer behaviour. */
    readonly session?: DaemonRepairSessionMemory | undefined;
    /** Injectable so a test never spawns the real daemon CLI. */
    readonly runDaemonCli?: DaemonCliRunner | undefined;
    /** Injectable repair, so a test drives accept without touching a service manager. */
    readonly repair?: Parameters<typeof createDaemonRepairPrompt>[0]['repair'];
  } | undefined;
  /**
   * Asks the first-start workspace question where the owner can see it (the
   * shell passes a selection modal, workspace-registration-question.ts).
   * Absent, the question is not asked this launch.
   */
  readonly askWorkspaceRegistration?: AskWorkspaceRegistration | undefined;
}

export interface SessionPersistenceAndRecoveryResult {
  /** Interval handle for the periodic recovery-file writer; clear it on exit. */
  recoveryInterval: ReturnType<typeof setInterval>;
  /**
   * The sessionId of the offered recovery snapshot when an unsaved session
   * was found and the user prompt was shown; null otherwise. Threading the
   * actual id (not just a found/not-found boolean) lets the caller consume
   * or remove EXACTLY the snapshot it offered, even when more than one
   * snapshot exists on disk, see checkRecoveryFile's RecoveryFileInfo.sessionId.
   */
  recoveryPending: string | null;
  /** The workspace root the first-start question was asked about this launch, null when it was not asked. */
  workspaceRegistrationAsked: string | null;
  /**
   * The one-touch daemon repair controller when this launch offered a repair,
   * null otherwise. Handed straight to handleBlockingShellInput; it owns its
   * own awaiting-answer state, so the shell never reassigns it.
   */
  daemonRepairPrompt: DaemonRepairPrompt | null;
}

/**
 * Wires streaming-speed event subscriptions, auto-save on turn completion,
 * and the post-first-render recovery-file check + periodic writer.
 *
 * Call AFTER the first render() so that:
 * - announceAwayDigest has already run
 * - startHardwareProbe has already fired
 * - The recovery prompt lands as ambient context, not a startup blocker
 */
export function wireSessionPersistenceAndRecovery(
  deps: SessionPersistenceAndRecoveryDeps,
): SessionPersistenceAndRecoveryResult {
  const {
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
  } = deps;
  const shellPaths = createShellPathService({ workingDirectory: workingDir, homeDirectory });

  // --- Streaming speed + tool preview wiring ---
  let streamStartTime = 0;
  let streamDeltaCount = 0;

  unsubs.push(uiServicesTurns.on('TURN_COMPLETED', () => {
    // Auto-save after every LLM turn so kills don't lose the session
    try {
      const snapshot = buildCurrentSessionSnapshot();
      persistConversation(
        runtime.sessionId,
        snapshot,
        runtime.model,
        runtime.provider,
        conversation.title || '',
        { surface },
        // Automatic post-turn save, not a user-directed one, stays 'auto' so
        // the retention sweep can reclaim it (see /save's explicit 'user' save
        // in input/commands/session-content.ts).
        'auto',
      );
      hookDispatcher.fire({ path: 'Lifecycle:session:save' as HookEventPath, phase: 'Lifecycle' as HookPhase, category: 'session' as HookCategory, specific: 'save', sessionId: runtime.sessionId, timestamp: Date.now(), payload: { sessionId: runtime.sessionId } }).catch((err: unknown) => logger.debug('hook fire error', { error: summarizeError(err) }));
    } catch (e) { logger.debug('auto-save on turn:complete failed', { error: summarizeError(e) }); }
  }));

  unsubs.push(uiServicesTurns.on('STREAM_START', () => {
    streamStartTime = Date.now();
    streamDeltaCount = 0;
    onStreamSpeedUpdate(0);
  }));
  unsubs.push(uiServicesTurns.on('STREAM_DELTA', () => {
    streamDeltaCount++;
    const elapsed = (Date.now() - streamStartTime) / 1000;
    // Note: counts stream deltas, not actual tokens. ~1 delta per token for most providers.
    onStreamSpeedUpdate(elapsed > 0 ? streamDeltaCount / elapsed : 0);
  }));

  // Recovery file check: display prompt if an unsaved session exists.
  // Runs after the first render so the message lands as ambient context.
  let recoveryPending: string | null = null;
  const recoveryInfo = checkRecoveryFile({ surface });
  if (recoveryInfo) {
    systemMessageRouter.high(`[Recovery] Found unsaved session from ${new Date(recoveryInfo.timestamp).toLocaleString()}. Title: "${recoveryInfo.title}". Press Ctrl+R to restore, Esc to discard, or start typing to ignore it.`);
    for (const line of formatReturnContextForDisplay(recoveryInfo.returnContext)) {
      systemMessageRouter.low(`[Recovery] ${line}`);
    }
    render();
    // Carry the OFFERED snapshot's sessionId (not just a boolean) so the
    // Ctrl+R/Esc handlers in blocking-input.ts consume/remove exactly this
    // snapshot, never a different one that happens to exist on disk.
    recoveryPending = recoveryInfo.sessionId;
  }

  const recoveryInterval = setInterval(() => {
    const snapshot = buildCurrentSessionSnapshot();
    writeRecoveryFile(
      snapshot,
      runtime.sessionId,
      conversation.title ?? '',
      { surface },
    );
  }, 60_000);

  // First-start registration prompt (owner-approved design): only when this
  // directory resolves to unknown (not covered, not declined) AND it isn't a
  // broad root the store would refuse anyway (see isBroadWorkspaceRoot's own
  // doc comment on why an "offer" check is safe to keep separate from the
  // store's authoritative write-time guard). Skipped when a recovery prompt
  // already claimed this launch's ambient attention, and while onboarding is
  // still incomplete, the full-screen onboarding wizard would otherwise
  // compete with this prompt for the very next keypress the owner types.
  const onboardingDone = Boolean(readOnboardingCompletionMarker(shellPaths, 'user').payload);

  // One-touch daemon repair, offered before the workspace prompt below because
  // the two compete for the very next keypress and this one is about a machine
  // that cannot reach the platform at all. Same guards as that prompt: skipped
  // when a recovery offer already claimed this launch's attention, and while
  // onboarding is still incomplete. The check itself costs nothing on a healthy
  // machine, it reads one setting and returns, and only consults the daemon's
  // CLI once that setting is already false. See runtime/daemon-repair.ts.
  let daemonRepairPrompt: DaemonRepairPrompt | null = null;
  if (!recoveryPending && onboardingDone && daemonRepair) {
    const daemonRepairSession = daemonRepair.session ?? createDaemonRepairSessionMemory();
    const offer = diagnoseDaemonRepair({
      config: daemonRepair.config,
      session: daemonRepairSession,
      ...(daemonRepair.runDaemonCli ? { runDaemonCli: daemonRepair.runDaemonCli } : {}),
    });
    if (offer) {
      // One line: what is wrong, then the offer. Both come from the policy
      // module so the interactive wording and headless run's stderr wording
      // cannot drift apart.
      systemMessageRouter.high(`[Daemon] ${offer.diagnosis} ${offer.offer}`);
      render();
      daemonRepairPrompt = createDaemonRepairPrompt({
        offer,
        config: daemonRepair.config,
        session: daemonRepairSession,
        systemMessageRouter,
        render,
        runDaemonCli: daemonRepair.runDaemonCli,
        repair: daemonRepair.repair,
      });
    }
  }

  let workspaceRegistrationAsked: string | null = null;
  if (!recoveryPending && !daemonRepairPrompt && onboardingDone && deps.askWorkspaceRegistration) {
    const resolution = resolveWorkspaceRegistrationSync(shellPaths, workingDir);
    if (resolution.status === 'unknown' && !isBroadWorkspaceRoot(shellPaths, workingDir)) {
      const root = normalizeWorkspaceRoot(workingDir);
      workspaceRegistrationAsked = root;
      deps.askWorkspaceRegistration(root, (accepted) => {
        answerWorkspaceRegistrationPrompt(shellPaths, root, accepted);
        systemMessageRouter.high(accepted
          ? `[Workspace] Registered ${root}, automatic checkpoints are now allowed here.`
          : `[Workspace] Not registered, automatic checkpoints stay off here (won't ask again for this location).`);
        render();
      });
    }
  }

  return { recoveryInterval, recoveryPending, workspaceRegistrationAsked, daemonRepairPrompt };
}

/**
 * Deps for the setup-incomplete hint, kept narrow so the function is easily
 * testable and doesn't pull in the full bootstrap context.
 */
export interface SetupIncompleteHintDeps {
  /**
   * Shell path service, used to locate onboarding marker files.
   * Must satisfy the minimal interface required by readOnboardingCheckMarker.
   */
  readonly shellPaths: Parameters<typeof readOnboardingCheckMarker>[0];
  /**
   * Whether a model route is currently configured and usable for chat.
   * Pass true when the provider registry has a ready model, false otherwise.
   */
  readonly providerReady: boolean;
  /**
   * Whether a local model route has been detected and is ready for chat.
   * Pass true when the local-model-cookbook status === 'detected-local-route'.
   * Omit or pass false when unavailable. Best-effort: errors should produce false.
   * This mirrors the 'local-model-readiness' plan item in the real buildSetupPlan.
   */
  readonly localReady?: boolean;
  /**
   * Whether the assistant service (connected host) is known to be running.
   * Pass true/false for a confirmed live signal; omit or pass null/undefined
   * when the signal is unreliable or unavailable at startup time.
   */
  readonly hostReady?: boolean | null;
  /** Low-priority message channel, same interface as SystemMessageRouter.low(). */
  readonly systemMessageRouter: { low(message: string): void };
}

/**
 * Derives the current onboarding state from disk markers and, if setup is
 * in-progress, pushes a plain-language hint to the conversation feed.
 *
 * Best-effort: any error is caught silently so startup is never blocked.
 * Call after the first render, alongside announceAwayDigest.
 */
export function wireSetupIncompleteHint(deps: SetupIncompleteHintDeps): void {
  try {
    const { shellPaths, providerReady, localReady, hostReady, systemMessageRouter } = deps;

    const checkMarker = readOnboardingCheckMarker(shellPaths, 'user');
    const completionMarker = readOnboardingCompletionMarker(shellPaths, 'user');

    // Build a minimal plan with BOTH provider-access AND local-model-readiness so
    // that deriveReadyToChat mirrors the workspace's canonical definition:
    //   readyToChat = providerItem.ready OR localModelItem.ready
    //
    // local-model-readiness uses blocksAutonomy:false so it never becomes a false
    // blocker when only the local route is available (matching real plan behaviour).
    // We intentionally skip the full buildSetupPlan (requires CommandContext +
    // async collectSnapshot) because this is a best-effort ambient hint.
    const minimalPlan = [
      {
        id: 'provider-access',
        label: 'Model access',
        status: providerReady ? ('ready' as const) : ('blocked' as const),
        priority: 20,
        blocksAutonomy: true,
        reason: '',
        nextAction: 'Choose a model to start chatting.',
        userRoute: 'Agent Workspace -> Start -> Choose main model',
        modelRoute: '',
      },
      {
        id: 'local-model-readiness',
        label: 'Local model',
        status: localReady ? ('ready' as const) : ('recommended' as const),
        priority: 25,
        blocksAutonomy: false,
        reason: '',
        nextAction: 'Run /agent to set up a local model route.',
        userRoute: 'Agent Workspace -> Start -> Use a local model (no sign-in)',
        modelRoute: '',
      },
    ];

    const state = deriveOnboardingState({ plan: minimalPlan, checkMarker, completionMarker });

    const hint = buildSetupIncompleteHint(state, hostReady);
    if (hint === null) return;

    for (const line of hint.lines) {
      systemMessageRouter.low(`[Setup] ${line}`);
    }
  } catch {
    // Never block startup on hint errors.
  }
}
