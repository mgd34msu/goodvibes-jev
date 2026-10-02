#!/usr/bin/env bun
import { homedir } from 'node:os';
import { settleInteractiveExit } from './shell/exit-completion.ts';
import { Compositor } from './renderer/compositor.ts';
import { installStartupThemeProbe } from './renderer/startup-theme-probe.ts';
import { ThinkingStallClock, buildThinkingOverlay, createThrobberSource, mainPermissionAsk } from './core/thinking-overlay.ts';
import { UIFactory } from './renderer/ui-factory.ts';
import { Orchestrator } from '@goodvibes-jev/engine/sdk/platform/core';
import { conversationMessagesAsSessionRecords } from './core/conversation-message-snapshot.ts';
import { createTranscriptNavigators } from './shell/transcript-navigation.ts';
import { InputHandler } from './input/handler.ts';
import { SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import type { ContentPart } from '@goodvibes-jev/engine/sdk/platform/providers';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { registerAllTools } from '@goodvibes-jev/engine/sdk/platform/tools';
import { FileUndoManager } from '@goodvibes-jev/engine/sdk/platform/state';
import { PermissionManager } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PermissionPromptUI } from './permissions/prompt.ts';
import { CommandRegistry } from './input/command-registry.ts';
import type { CommandContext } from './input/command-registry.ts';
import { registerBuiltinCommands } from './input/commands.ts';
import { ScheduleManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import { InputHistory } from './input/input-history.ts';
import { ShellPassthrough, SHELL_USAGE_HINT } from './input/shell-passthrough.ts';
import { buildShellFooter, estimateShellFooterHeight } from './renderer/shell-surface.ts';
import { HEADER_GAP_ROWS, withHeaderGap } from './renderer/header-line.ts';
import { TranscriptScroll, mainBackToBottom, transcriptEscape } from './shell/transcript-scroll.ts';
import { buildConversationViewport, centerViewportContent } from './renderer/conversation-layout.ts';
import { applyConversationOverlays, buildConversationLayers } from './renderer/conversation-overlays.ts';
import { buildActivityAgentRows, type ActivityView } from './renderer/activity-modal.ts';
import { ActivityModal } from './input/activity-modal.ts';
import { logger, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { bootstrapRuntime } from './runtime/bootstrap.ts';
import { readAgentHostSetting } from './config/host-settings.ts';
import type { BootstrapContext } from './runtime/bootstrap.ts';
import type { HITLMode } from '@goodvibes-jev/engine/sdk/platform/state';
import { startFirstRenderFollowups, type DaemonRepairPrompt } from './shell/first-render-followups.ts';
import { localModelCookbook } from './tools/agent-harness-model-routing.ts';
import { localModelSetupStatus } from './tools/agent-harness-setup-model-helpers.ts';
import {
  consumeRecovery,
  removeRecoveryPoint,
} from '@/runtime/index.ts';
import type { SessionSnapshot } from '@/runtime/index.ts';
import { handleBlockingShellInput, type PendingPermissionState } from './shell/blocking-input.ts';
import { createWorkspaceRegistrationQuestion } from './shell/workspace-registration-question.ts';
import { getTerminalSize } from './shell/terminal-size.ts';
import { buildShellSessionContinuityHints } from './shell/session-continuity-hints.ts';
import { wireShellUiOpeners } from './shell/ui-openers.ts';
import { deriveComposerState } from './core/composer-state.ts';
import { describePowerStatus } from './renderer/power-status.ts';
import { buildPersistedSessionContext } from '@/runtime/index.ts';
import { installFocusModeExitGuard, markFocusModeEnabled, wrapRequestPermissionWithApprovalAlert } from './shell/terminal-focus-mode.ts';
import { buildEnterSequence, buildExitSequence } from './renderer/terminal-escapes.ts';
import { prepareShellCliRuntime } from './cli/entrypoint.ts';
import { reachabilityAtLaunch } from './runtime/path-shadow-startup.ts';
import { selfUpdateAtLaunch } from './cli/launch-auto-update.ts';
import { startPeriodicSelfUpdate } from './runtime/periodic-update.ts';
import { applyInitialTuiCliState, getInteractiveTerminalLaunchError, reportFatalStartupError } from './cli/tui-startup.ts';
import { writeFatalLine } from './utils/fatal-boot-write.ts';
import { wireSpokenTurnRuntime } from './audio/spoken-turn-wiring.ts';
import { installVoiceCapture } from './shell/voice-capture-shell.ts';
import { createProcessFaultHandlers } from './runtime/process-fault-capture.ts';
import { attachSpokenTurnModelRouting, createSpokenTurnInputOptions } from './audio/spoken-turn-model-routing.ts';
import { allowTerminalWrite, createShellLayout, installFullScreenTerminalOutputGuard } from '@goodvibes-jev/engine/terminal-shell';
import { buildCommandArgsHint } from './input/command-args-hint.ts';
import { GOODVIBES_AGENT_PAIRING_SURFACE } from './config/surface.ts';
import { createAutonomySurfacing, buildCalendarEventsLister, buildSkillDraftProposer } from './shell/autonomy-surfacing.ts';
import { bindApprovals } from './shell/approvals-binding.ts';
import { buildListAutomationRunsSince } from './agent/automation-runs-source.ts';
import { startHardwareProbe } from './core/hardware-profile.ts';
import { readApprovalPostureFromConfig } from './permissions/approval-posture.ts';
import { installRemoteConversationRouting } from './shell/remote-conversation-wiring.ts';
import { applyAtModelSwitches } from './input/at-model-switch.ts';
import { createCommandContextUi } from './shell/command-context-ui.ts';
import { createTerminalPaintWindow } from './shell/terminal-paint-window.ts';
import { wireWorkTree } from './core/work-tree-wiring.ts';
import { SessionViews } from './shell/session-views.ts';

// Escape bytes and enter/exit sequencing live in renderer/terminal-escapes.ts (re-exported from @goodvibes-jev/engine/terminal-shell) so this file never holds its own drifting copy.

async function main() {
  const stdout = process.stdout;
  const stdin = process.stdin;
  installFocusModeExitGuard(stdout); // see shell/terminal-focus-mode.ts
  const { cli, configManager, bootstrapWorkingDir, bootstrapHomeDirectory } = await prepareShellCliRuntime(process.argv.slice(2), {
    defaultWorkingDirectory: process.env['GOODVIBES_WORKING_DIR'] ?? process.cwd(),
    homeDirectory: process.env['GOODVIBES_AGENT_HOME'] ?? homedir(),
  }, 'goodvibes-agent');

  const terminalLaunchError = getInteractiveTerminalLaunchError({
    binary: cli.binary,
    stdinIsTTY: stdin.isTTY,
    stdoutIsTTY: stdout.isTTY,
  });
  if (terminalLaunchError !== null) {
    // Descriptor write, not process.stderr: this is a refusal that exits
    // immediately, and a stream write can still be in flight when the process
    // stops existing. See utils/fatal-boot-write.ts.
    writeFatalLine(terminalLaunchError);
    process.exit(2);
  }

  // Launch-time self-update, before any bootstrap or terminal mode change; on
  // an installed update this restarts onto the swapped binary and never returns.
  const launchUpdateLines = await selfUpdateAtLaunch({ configManager, stdout });
  const reachabilityLines = await reachabilityAtLaunch({ stdout });

  const ctx: BootstrapContext = await bootstrapRuntime(stdout, {
    configManager,
    workingDir: bootstrapWorkingDir,
    homeDirectory: bootstrapHomeDirectory,
  });
  const {
    conversation,
    orchestrator,
    runtime,
    toolRegistry,
    compositor,
    selection,
    commandContext,
    uiServices,
    commandRegistry,
    inputHistory,
    hookDispatcher,
    bootstrapUnsubs,
    agentStatusIntervalRef,
    orchestratorRefs,
    setRenderRequest,
    permissionPromptRef,
    systemMessageRouter,
  } = ctx;
  const workingDir = ctx.services.workingDirectory;
  const homeDirectory = ctx.services.homeDirectory;
  const { approvalBroker, agentManager, modeManager, processManager, providerRegistry, secretsManager, subscriptionManager } = ctx.services;
  conversation.setSessionMemoryStore(ctx.services.sessionMemoryStore);
  conversation.setSessionLineageTracker(ctx.services.sessionLineageTracker);
  orchestrator.setCoreServices({
    configManager,
    providerRegistry,
    favoritesStore: ctx.services.favoritesStore,
    planManager: ctx.services.planManager,
    adaptivePlanner: ctx.services.adaptivePlanner,
    sessionMemoryStore: ctx.services.sessionMemoryStore,
    sessionLineageTracker: ctx.services.sessionLineageTracker,
    idempotencyStore: ctx.services.idempotencyStore,
  });
  let activeConversationWidth = getTerminalSize(stdout).width;
  conversation.setWidthProvider(() => activeConversationWidth);

  // Re-surface pre-bootstrap launch-update lines in-session (the alternate
  // screen wipes the stdout copies written before the renderer existed).
  for (const line of launchUpdateLines) systemMessageRouter.high(`[Update] ${line}`);
  for (const line of reachabilityLines) systemMessageRouter.high(`[Install] ${line}`);
  {
    const hitlMode = configManager.get('behavior.hitlMode') as HITLMode | undefined;
    if (hitlMode && (hitlMode === 'quiet' || hitlMode === 'balanced' || hitlMode === 'operator')) {
      modeManager.setHITLMode(hitlMode);
    }
  }

  const buildSessionContinuityHints = () => buildShellSessionContinuityHints(
    uiServices.readModels.session.getSnapshot(),
    uiServices.readModels.tasks.getSnapshot(),
    uiServices.readModels.remote.getSnapshot(),
  );
  const buildCurrentSessionSnapshot = (): SessionSnapshot => {
    const messages = conversation.getMessageSnapshot();
    const persisted = buildPersistedSessionContext(messages, conversation.getTitleSource(), buildSessionContinuityHints());
    return {
      messages: conversationMessagesAsSessionRecords(messages),
      timestamp: Date.now(),
      title: conversation.title,
      ...persisted,
    };
  };

  let pendingPermission: PendingPermissionState | null = null;
  const approvalsBinding = bindApprovals({
    broker: approvalBroker,
    approvalsView: ctx.services.approvalsView,
    // Deferred: `render` is declared further down, and the binding only ever
    // calls it from inside the broker subscription.
    render: () => { render(); },
    getPending: () => pendingPermission,
    setPending: (next) => { pendingPermission = next; },
  });

  let streamTokenSpeed = 0;

  const thinkingClock = new ThinkingStallClock(); // thinking-indicator stall clock

  // Where the main transcript is scrolled to; each frame's clamp is fed back (shell/transcript-scroll.ts).
  const transcript = new TranscriptScroll();

  const shellPassthrough = new ShellPassthrough();

  // Ambient autonomy surfacing: away digest at launch + the Activity modal's Coming up.
  const autonomy = createAutonomySurfacing({
    shellPaths: ctx.services.shellPaths,
    listAutomationJobs: () => ctx.services.automationManager.listJobs(),
    listAutomationRunsSince: buildListAutomationRunsSince(configManager, homeDirectory),
    listApprovals: approvalsBinding.listApprovals,
    describeApprovalsUnavailable: approvalsBinding.describeApprovalsUnavailable,
    getTasksSnapshot: () => uiServices.readModels.tasks.getSnapshot().tasks,
    router: {
      high: (message) => systemMessageRouter.high(message),
      getFeed: () => systemMessageRouter.getFeed(),
    },
    render: () => render(),
    listCalendarEvents: buildCalendarEventsLister(ctx.services.shellPaths),
    onAwayDigest: buildSkillDraftProposer(ctx.services.shellPaths, commandContext),
  });

  // The Activity modal's view (Ctrl+O, /activity), read live on every paint of it:
  // the running work, what needs you, what is coming up and the activity feed.
  const activityView = (): ActivityView => {
    const sessionSnapshot = uiServices.readModels.session.getSnapshot();
    const activeAgents = uiServices.readModels.agents.getSnapshot().active;
    return {
      now: {
        busy: orchestrator.isThinking,
        label: remoteConversation.hostedToolPreview() ?? sessionSnapshot.streamToolPreview?.trim() ?? undefined,
        agents: buildActivityAgentRows(activeAgents, ctx.services.fleetUnion.nodes()),
        processes: processManager.list().filter((p) => processManager.getStatus(p.id)?.done === false).length,
      },
      needsYou: pendingPermission ? ['Approval needed, answer the prompt on screen.'] : [],
      comingUp: [...autonomy.comingUpItems()],
      recent: systemMessageRouter.getFeed()?.latest(200) ?? [],
    };
  };

  const getPromptContentWidth = () => {
    // Composer text runs from column 5 and wraps at width-9 (composer.ts), leaving the cursor room at width-4.
    return Math.max(1, getTerminalSize(stdout).width - 9);
  };

  // Live-microphone footer row (the wake detector); assigned once voice capture is wired below, null until then so pre-wiring frames size correctly.
  let voiceCaptureStatus: () => import('./core/voice-capture-status.ts').VoiceCaptureIndicatorState | null = () => null;

  // Agents and background processes opened full screen: Enter on a lane or ▶ bead, the Activity modal, the process monitor (shell/session-views.ts).
  const sessionViews = new SessionViews({ conversation, agentManager, processManager, contractRunner: ctx.services.contractRunner, fleetNodes: () => ctx.services.processRegistry.query().nodes, steer: (id, text) => ctx.services.processRegistry.steer(id, text), killAgent: (id) => ctx.services.processRegistry.kill(id, { cascade: true }), mainBusy: () => orchestrator.isThinking, mainModel: () => providerRegistry.getCurrentModel().id, promptText: () => input.prompt, requestRender: () => render() });
  commandContext.openSessionView = (target) => sessionViews.open(target);
  const getViewportHeight = (): number => // less the header row (+ chips) and, on the main screen, the empty row under them (a view's body brings its own)
    getTerminalSize(stdout).height - sessionViews.headerRows() - (sessionViews.active ? 0 : HEADER_GAP_ROWS) - estimateShellFooterHeight(input.getVisiblePromptLineCount(getPromptContentWidth()));

  const scroll = (delta: number) => {
    if (sessionViews.active) { sessionViews.scroll(-delta); return; } // a view scrolls its own lines (up is positive there)
    transcript.scrollBy(delta, () => Math.max(0, conversation.history.getLineCount() - getViewportHeight()));
  };

  // Only follow the tail while parked at the bottom (a manual scroll-up stays); submitInput re-locks.
  const scrollToEnd = (vHeight: number) => transcript.followTail(conversation.history.getLineCount(), vHeight);

  const unsubs: Array<() => void> = [];
  unsubs.push(() => input.settingsModal.close());
  // The work tree's live facts: call/turn timings, agent lanes, the call a permission prompt holds, fold persistence (work-tree-wiring.ts).
  const workTreeWiring = wireWorkTree({ conversation, events: uiServices.events, agentManager, listContracts: () => ctx.services.contractRunner.list({ sessionId: runtime.sessionId, includeTerminal: true }), onContractsChanged: (listener) => ctx.services.runtimeBus.onDomain('contracts', listener), fleetNodes: () => ctx.services.processRegistry.query().nodes, pendingCallId: () => pendingPermission?.callId, turnActive: () => orchestrator.isThinking, sessionsDir: ctx.services.surface.sessionsDir, sessionId: () => runtime.sessionId, requestRender: () => render() });
  unsubs.push(...workTreeWiring.unsubs, () => sessionViews.dispose());
  const throbberSource = createThrobberSource(uiServices.events.tools, () => ctx.services.contextAccountingHolder.getSource()?.getCompactionState().isCompacting === true); unsubs.push(...throbberSource.unsubs); // the throbber's running call and compaction clock
  let recoveryInterval: ReturnType<typeof setInterval> | null = null;
  let stopSpokenOutputForExit: (() => Promise<void>) | null = null;
  // sessionId of the offered recovery snapshot, or null when none is pending.
  let recoveryPending: string | null = null, daemonRepairPrompt: DaemonRepairPrompt | null = null;
  // The window in which this app owns the screen: opened by the enter sequence below, closed by exitApp before the terminal-restore write. render() paints only inside it, see shell/terminal-paint-window.ts for what the early frames did to the boot surface and to the shell's screen.
  const paintWindow = createTerminalPaintWindow({ enter: () => allowTerminalWrite(() => { markFocusModeEnabled(); return stdout.write(buildEnterSequence(cli.flags.noAltScreen)); }), discardCompositorState: () => compositor.resetDiff() });

  const sigintHandler = (): void => input.feed('\x03');
  const processFaults = createProcessFaultHandlers({
    notifyHigh: (message) => systemMessageRouter.high(message), render: () => render(),
    shellPaths: ctx.services.shellPaths, activeSessionId: () => runtime.sessionId,
  });
  const resizeHandler = (): void => {
    input.setContentWidth(getPromptContentWidth());
    compositor.resetDiff();
    render();
  };

  let exiting = false;
  // `handOver` replaces the process AFTER the orderly teardown below and exits
  // with its code, how a periodic self-update restarts onto its new binary.
  const exitApp = (handOver?: () => number): void => {
    // Reentrancy guard: a second /exit or keypress during the bounded
    // spoken-audio drain below must not re-run teardown.
    if (exiting) return;
    exiting = true;
    // Gate render() before anything else so no late frame follows the terminal-restore write below.
    paintWindow.close();
    // Exit lets the spoken audio the user is already hearing finish inside a
    // short bounded window (capped inside stopForExit) instead of killing the
    // player mid-drain; queued-but-unplayed speech is dropped. Deliberate
    // interrupts (Ctrl+C, /tts stop) still cut instantly via spokenTurns.stop().
    let spokenOutputDrain: Promise<void> = Promise.resolve();
    try {
      spokenOutputDrain = Promise.resolve(stopSpokenOutputForExit?.()).then(() => undefined);
    } catch (error) { spokenOutputDrain = Promise.reject(error); }
    unsubs.forEach(fn => fn());
    // Persist last-seen before shutdown so the next launch can compute the digest.
    autonomy.stop();
    const snapshot = buildCurrentSessionSnapshot();
    const runtimeShutdown = ctx.shutdown(snapshot);
    const exitCompletion = settleInteractiveExit(runtimeShutdown, spokenOutputDrain);
    if (recoveryInterval !== null) { clearInterval(recoveryInterval); recoveryInterval = null; }
    // Scoped to this session only, a keyless call would clear every snapshot in the recovery dir.
    removeRecoveryPoint(ctx.services.surface, runtime.sessionId);
    stdin.removeAllListeners('data');
    stdout.removeListener('resize', resizeHandler);
    process.removeListener('SIGINT', sigintHandler);
    processFaults.dispose();
    allowTerminalWrite(() => stdout.write(buildExitSequence(cli.flags.noAltScreen)));
    terminalOutputGuard.dispose();
    stdin.setRawMode(false);
    // The terminal is restored immediately. Process exit and executable
    // handover wait for runtime ownership release and the bounded audio drain.
    void exitCompletion.then((failures) => {
      for (const error of failures) logger.warn('Owned cleanup failed during exitApp', { error: summarizeError(error) });
      process.exit(handOver ? handOver() : 0);
    });
  };

  commandContext.exit = exitApp;

  // A long-running agent looks for a newer release too, not only at launch: it
  // installs at an idle moment and restarts in place (runtime/periodic-update.ts).
  unsubs.push(startPeriodicSelfUpdate({
    configManager, services: ctx.services, exit: exitApp,
    notify: (line) => { systemMessageRouter.high(`[Update] ${line}`); render(); },
  }));

  const spokenTurns = wireSpokenTurnRuntime({
    voiceService: ctx.services.voiceService,
    configManager,
    events: uiServices.events,
    notify: (message) => { systemMessageRouter.high(message); render(); },
  });
  // Exit-path stop: bounded drain of the audio already playing (see stopForExit).
  stopSpokenOutputForExit = () => spokenTurns.stopForExit();
  unsubs.push(...spokenTurns.unsubs);
  unsubs.push(attachSpokenTurnModelRouting({
    orchestrator,
    providerRegistry,
    configManager,
    notify: (message) => { systemMessageRouter.high(message); render(); },
  }));
  // Where a turn runs, see shell/remote-conversation-wiring.ts.
  const remoteConversation = installRemoteConversationRouting(ctx, {
    render: () => render(),
    notify: (message) => systemMessageRouter.high(message),
  });
  unsubs.push(() => remoteConversation.dispose());

  const submitInput = (text: string, content?: ContentPart[], options: { readonly spokenOutput?: boolean } = {}) => {
    input.clearModalStack();
    transcript.toBottom(); // Re-lock on user input
    let processedText = applyAtModelSwitches(text, {
      providerRegistry,
      configManager,
      onModelChanged: (model) => { runtime.model = model.id; runtime.provider = model.provider; },
      notify: (message) => systemMessageRouter.high(message),
    });
    if (processedText.startsWith('!#')) {
      const memoryText = processedText.slice(2).trim();
      if (!memoryText) {
        systemMessageRouter.high('[Memory] Usage: !# <text to pin as conversation-pinned memory>');
        render();
        processedText = '';
      } else {
        const memId = ctx.services.sessionMemoryStore.add(memoryText);
        systemMessageRouter.high(`[Memory] Pinned: "${memoryText}" (${memId})`);
        processedText = memoryText;
      }
    } else if (processedText.startsWith('!')) {
      const command = processedText.slice(1).trim();
      if (!command) {
        systemMessageRouter.high(SHELL_USAGE_HINT);
        render();
        return;
      }
      systemMessageRouter.high(`[Shell] $ ${command}`); render();
      void shellPassthrough.run(command, workingDir)
        .then((result) => systemMessageRouter.high(result.display))
        .catch((shellErr: unknown) => systemMessageRouter.high(`[Shell] Failed to run: ${summarizeError(shellErr)}`))
        .finally(() => render());
      return;
    }
    if (processedText || content) {
      void (async () => {
        const inputOptions = options.spokenOutput ? createSpokenTurnInputOptions() : undefined;
        const outgoing = shellPassthrough.consumeContext(processedText);
        if (options.spokenOutput && processedText) {
          spokenTurns.submitNextTurn(processedText);
        }
        // Routed to the daemon, or run here with the reason already stated.
        if (await remoteConversation.routeOrExplain(outgoing, Boolean(content?.length))) return;
        orchestrator.handleUserInput(outgoing, content, inputOptions).catch((err: unknown) => {
          logger.debug('handleUserInput safety catch (already handled by runTurn)', { error: summarizeError(err) });
        });
      })();
    } else {
      render();
    }
  };

  const cancelGeneration = () => {
    spokenTurns.stop('Spoken output stopped.');
    // A hosted turn sets the same isThinking the local path does, but its
    // waiting state is owned here, not by orchestrator.abort().
    remoteConversation.cancelHostedTurn();
    if (orchestrator.isThinking) {
      orchestrator.abort();
    }
  };

  const { jumpToBookmark, scrollToLine } = createTranscriptNavigators({
    conversation,
    getViewportHeight,
    setScrollTop: (line) => { transcript.jumpTo(line); },
    render: () => render(),
    notify: (message) => systemMessageRouter.high(message),
  });

  commandContext.submitInput = submitInput;
  commandContext.submitSpokenInput = (text, content) => submitInput(text, content, { spokenOutput: true });
  commandContext.stopSpokenOutput = () => spokenTurns.stop();
  commandContext.pasteFromClipboard = () => input.handlePaste();
  // Composer line prompts: masked for card material, echoed for addresses (see input/handler-line-prompts.ts).
  commandContext.beginConcealedInput = (request) => input.beginConcealedInput(request);
  commandContext.beginPlainInput = (request) => input.beginPlainInput(request);
  commandContext.executeCommand = (name, args) => commandRegistry.execute(name, args, commandContext);
  commandContext.cancelGeneration = cancelGeneration;
  commandContext.isGenerating = () => orchestrator.isThinking;
  commandContext.jumpToBookmark = jumpToBookmark;
  commandContext.scrollToLine = scrollToLine;
  const commandUi = createCommandContextUi({
    compositor, stdout, render: () => render(), terminalWidth: () => getTerminalSize(stdout).width,
    setPendingPermission: (pending) => { pendingPermission = pending; },
  });
  commandContext.clearScreen = commandUi.clearScreen;
  // The Activity modal (Ctrl+O, /activity): what is running and what happened, as a kit modal.
  commandContext.openActivityModal = () => {
    input.surfaceModals.push(new ActivityModal({
      view: () => activityView(),
      openProcesses: () => { input.modalOpened('process'); input.processModal.open(); render(); },
      openSessionView: (target) => sessionViews.open(target),
    }));
    render();
  };
  // see shell/terminal-focus-mode.ts
  permissionPromptRef.requestPermission = wrapRequestPermissionWithApprovalAlert(commandUi.requestPermission as typeof permissionPromptRef.requestPermission, { focusTracker: ctx.services.focusTracker, configGet: (key) => readAgentHostSetting(configManager, key), conversation });

  const input: InputHandler = new InputHandler(
    () => render(),
    selection,
    () => transcript.top,
    getViewportHeight,
    () => conversation.history,
    scroll,
    exitApp,
    {
      providers: {
        benchmarkStore: ctx.services.benchmarkStore,
        favoritesStore: ctx.services.favoritesStore,
        providerRegistry: ctx.services.providerRegistry,
      },
      platform: {
        configManager: ctx.services.configManager,
        localUserAuthManager: ctx.services.localUserAuthManager,
        mcpRegistry: ctx.services.mcpRegistry,
        serviceRegistry: ctx.services.serviceRegistry,
        surfaceRegistry: ctx.services.surfaceRegistry,
        subscriptionManager: ctx.services.subscriptionManager,
        secretsManager: ctx.services.secretsManager,
        tokenAuditor: ctx.services.tokenAuditor,
        replayEngine: ctx.services.replayEngine,
        webhookNotifier: ctx.services.webhookNotifier,
        focusTracker: ctx.services.focusTracker,
        policyRuntimeState: ctx.services.policyRuntimeState,
        externalServices: uiServices.platform.externalServices,
      },
      shell: {
        bookmarkManager: ctx.services.bookmarkManager,
        keybindingsManager: ctx.services.keybindingsManager,
        processManager,
        profileManager: ctx.services.profileManager,
      },
      sessions: {
        sessionManager: ctx.services.sessionManager,
        sessionBroker: ctx.services.automationSessionRegister,
        sessionOrchestration: ctx.services.sessionOrchestration,
        sessionMemoryStore: ctx.services.sessionMemoryStore,
      },
      environment: {
        workingDirectory: ctx.services.workingDirectory,
        homeDirectory: ctx.services.homeDirectory,
        shellPaths: ctx.services.shellPaths,
      },
    },
  );

  orchestratorRefs.getViewportHeight = getViewportHeight;
  orchestratorRefs.scrollToEnd = scrollToEnd;

  input.setCommandRegistry(commandRegistry, commandContext);
  input.setConversationManager(conversation);
  input.setContentWidth(getPromptContentWidth());
  input.filePicker.setOnUpdate(() => render());
  input.processModal.setOnRefresh(() => render());
  input.surfaceModals.onChange = () => render(); input.sessionView = sessionViews;
  input.transcriptScroll = transcriptEscape(transcript, () => sessionViews.active, () => render()); // Esc while scrolled back returns to the bottom, never interrupts

  // Model picker callback is handled in bootstrap.ts, do not duplicate here.
  input.setHistory(inputHistory);
  // The wake-word capture host: one microphone path, opened only when voice.wake.enabled AND voice.wake.surfaces.agent are both on (shell/voice-capture-shell.ts).
  voiceCaptureStatus = installVoiceCapture({ configManager, voiceService: ctx.services.voiceService, voiceProviders: ctx.services.voiceProviders, daemonVerbs: ctx.services.daemonVerbs, ensureWakeProvisioned: async () => { const outcome = await ctx.services.voiceSetup.wakeEnsureProvisioned(); return { ready: outcome.ready, message: outcome.message }; }, shellPaths: ctx.services.shellPaths, sessionId: runtime.sessionId, unsubs, buffer: input, submitInput, notify: (m) => { systemMessageRouter.high(m); render(); }, render: () => render() });

  const toolCount = toolRegistry.list().length;
  conversation.splashOptions = {
    workingDir,
    model: runtime.model,
    provider: runtime.provider,
    toolCount,
  };

  // A hoisted DECLARATION, not `const`: callbacks wired above fire before this
  // line (bindApprovals starts an unawaited refresh + stream that repaint).
  // Under a `const` they hit the temporal dead zone, every boot logged "Cannot
  // access 'render' before initialization" as an unhandled rejection, which killed
  // that wiring, so the surface never repainted from any async source again.
  function render(): void {
    // Outside the window where this app owns the screen: the alternate screen does not exist yet, or the terminal has already been handed back. Never paint in either case.
    if (!paintWindow.isOpen()) return;
    const { width, height } = getTerminalSize(stdout);

    // Fire-and-forget refresh for the Activity modal's 'Coming up' section.
    autonomy.refreshComingUp();

    // Cache the current model for consistent values across the entire render frame
    const currentModel = providerRegistry.getCurrentModel();
    const sessionSnapshot = uiServices.readModels.session.getSnapshot();
    const agentSnapshot = uiServices.readModels.agents.getSnapshot();
    const activeAgents = agentSnapshot.active;
    const primaryActiveAgent = activeAgents.find((agent) => agent.latestProgress?.trim())
      ?? activeAgents[0];

    const viewFrame = sessionViews.frame(width); // an agent or process open full screen, or null in main
    const headerLines = viewFrame ? [viewFrame.header] : UIFactory.createHeader(width, currentModel.id, conversation.title || undefined);
    const chipsRow = sessionViews.chips(width); // every session to switch to, when there is more than main
    if (chipsRow) headerLines.push(chipsRow);
    const backToBottom = viewFrame
      ? (sessionViews.scrolledBack() ? { escKey: sessionViews.escGoesToBottom() } : null)
      : mainBackToBottom(transcript, { splash: conversation.isSplashShowing(), keysInInput: input.prompt.length === 0 && !input.commandMode && !conversation.workTree.focused && !input.indicatorFocused });
    const thinkingDeps = {
      orchestrator, configManager, streamTokenSpeed, clock: thinkingClock,
      streamToolPreview: remoteConversation.hostedToolPreview() ?? sessionSnapshot.streamToolPreview,
      approvalPending: mainPermissionAsk(pendingPermission) !== null, // a background agent's ask is not main's activity
    };
    const throbber = throbberSource.state({ ...thinkingDeps, width, pendingApproval: mainPermissionAsk(pendingPermission) }); // what main is doing: the row above the input area
    const runningAgentCount = activeAgents.length;
    const runningProcessCount = processManager.list().filter((p) => processManager.getStatus(p.id)?.done === false).length;
    const cw = getPromptContentWidth();
    const promptInfo = input.getWrappedPromptInfo(cw);
    const commandArgsHint = buildCommandArgsHint(input.prompt, commandRegistry);
    const composerState = deriveComposerState({
      text: input.prompt,
      commandMode: input.commandMode,
      pendingApproval: pendingPermission !== null,
      hasAttachments: input.getImageAttachments().size > 0,
      turnState: sessionSnapshot.turnState,
    });
    const footerLines = buildShellFooter({
      width,
      promptText: promptInfo.visibleLines.join('\n'),
      promptLineCount: promptInfo.visibleLines.length,
      promptCursorPos: promptInfo.visibleCursorLine >= 0
        ? promptInfo.visibleLines
          .slice(0, promptInfo.visibleCursorLine)
          .reduce((sum: number, line: string) => sum + line.length + 1, 0) + promptInfo.visibleCursorCol
        : undefined,
      usage: { up: orchestrator.usage.input, down: orchestrator.usage.output },
      showExitNotice: input.showExitNotice,
      lastCopyTime: input.lastCopyTime,
      model: runtime.model, // prices the cost; the header names the model
      workingDir, homeDirectory, view: viewFrame?.footer ?? null,
      contextWindow: providerRegistry.getKnownContextWindowForModel(currentModel), // null: unknown, the meter says so
      compactThreshold: configManager.get('behavior.autoCompactThreshold') as number,
      // Warn about broad automatic approvals even though boundaries or critical
      // stakes can still ask. The shared posture also drives status and explain.
      dangerMode: readApprovalPostureFromConfig(configManager).automaticApprovals,
      powerNote: describePowerStatus(ctx.services.powerManager.getState()) ?? undefined, // see power-status.ts
      lastInputTokens: orchestrator.lastInputTokens,
      commandArgsHint,
      hitlMode: modeManager.getHITLMode(),
      runningAgentCount,
      runningProcessCount,
      indicatorFocused: input.indicatorFocused, promptFocused: !input.indicatorFocused && !conversation.workTree.focused && viewFrame?.footer.disabledReason === undefined, workTreeFocused: conversation.workTree.focused && !viewFrame,
      runningAgentProgress: primaryActiveAgent
        ? `${primaryActiveAgent.label}: ${primaryActiveAgent.latestProgress?.trim() || primaryActiveAgent.status}`
        : undefined,
      composerMode: composerState.modeLabel,
      composerFlags: composerState.flags,
      composerPendingRisk: composerState.pendingRisk,
      voiceCapture: voiceCaptureStatus(),
      throbber, turnRunning: orchestrator.isThinking, backToBottom,
    }).lines;

    const shellHeaderLines = viewFrame ? headerLines : withHeaderGap(headerLines, width); // a view's body starts with its own empty row
    input.bodyTopRow = shellHeaderLines.length; // mouse rows map to transcript rows from here
    const shellFooterLines = footerLines;
    const shellLayout = createShellLayout({
      width,
      height,
      headerHeight: shellHeaderLines.length,
      footerHeight: shellFooterLines.length,
      panelWidth: 0,
    });
    const vHeight = shellLayout.body.height;
    const conversationWidth = shellLayout.conversation.width;
    activeConversationWidth = conversationWidth;
    conversation.setSplashSuppressed(false);

    // Flush pending renders after updating the width provider and splash posture
    // so the transcript and splash rebuild against the current shell layout.
    workTreeWiring.syncSession(); // a resumed session's folds come back with it
    conversation.workTree.tickLive(); // running beads spin and count up
    conversation.getDisplayBlocks();

    // Calculate how many rows are consumed by overlays (thinking, permissions, queue, file picker)
    let overlayRows = 0;
    // The opt-in partial tool preview row (the spinner lives on the status line).
    const thinkingRows = buildThinkingOverlay({ ...thinkingDeps, width: conversationWidth });
    overlayRows += thinkingRows.length;
    overlayRows += orchestrator.messageQueue.length * 3; // queued messages
    // File picker and model picker overlay rows computed from actual rendered line count below
    // Selection modal overlay rows are computed from actual rendered line count below
    if (input.searchManager.active) {
      overlayRows += 1;
    }

    const conversationViewport = buildConversationViewport({
      conversation,
      width: conversationWidth,
      viewportHeight: vHeight,
      scrollTop: transcript.top,
      scrollLocked: transcript.locked,
      overlayRows,
    });
    if (transcript.settle(conversationViewport.nextScrollTop, conversationViewport.maxScroll) && backToBottom && !viewFrame) render(); // unlocked at the bottom re-locks: repaint without the pill
    const scrollTop = transcript.top;
    // The home splash sits in the middle of the conversation area, never clipped.
    let viewport = viewFrame ? viewFrame.body(vHeight) : conversation.isSplashShowing()
      ? centerViewportContent(conversationViewport.viewport, conversationViewport.effectiveHeight, conversationWidth)
      : conversationViewport.viewport;

    if (!viewFrame) viewport.push(...thinkingRows); // main's own rows stay with main

    (viewFrame ? [] : orchestrator.messageQueue).forEach(msg => {
      viewport.push(...UIFactory.createQueuedMessageFragment(conversationWidth, msg.text));
    });

    viewport = applyConversationOverlays(viewport, {
      input,
      conversation,
      commandRegistry,
      keybindingsManager: ctx.services.keybindingsManager,
      conversationWidth,
      viewportHeight: vHeight,
      contextWindow: providerRegistry.getKnownContextWindowForModel(currentModel) ?? 0,
    });

    compositor.composite({
      width, height,
      header: shellHeaderLines,
      viewport,
      footer: shellFooterLines,
      selection: viewFrame ? undefined : {
        isCellSelected: (col, row) => selection.isCellSelected(col, row),
        scrollTop,
        lineCount: conversation.history.getLineCount(),
      },
      search: !viewFrame && input.searchManager.active ? {
        manager: input.searchManager,
        scrollTop,
        viewportStartY: shellHeaderLines.length,
      } : undefined,
      // Modals, the permission dialog and kit modals: stamped over the dimmed screen.
      layers: buildConversationLayers({
        input,
        conversation,
        commandRegistry,
        keybindingsManager: ctx.services.keybindingsManager,
        screenWidth: width,
        screenHeight: height, headerRows: shellHeaderLines.length, footerRows: shellFooterLines.length,
        contextWindow: providerRegistry.getKnownContextWindowForModel(currentModel) ?? 0,
        permission: pendingPermission ? PermissionPromptUI.createPromptLayer(width, height, pendingPermission) : null,
      }),
    });
  }
  const terminalOutputGuard = installFullScreenTerminalOutputGuard({ stdout, stderr: process.stderr, notify: (message) => { systemMessageRouter.low(message); render(); } });

  setRenderRequest(render);
  orchestratorRefs.requestRender = render;
  commandContext.renderRequest = render;
  wireShellUiOpeners({
    commandContext,
    input,
    conversation,
    configManager,
    providerRegistry,
    runtime,
    featureFlags: ctx.featureFlags,
    mcpRegistry: ctx.services.mcpRegistry,
    subscriptionManager,
    secretsManager,
    serviceRegistry: ctx.services.serviceRegistry,
    workingDirectory: workingDir,
    homeDirectory,
    getConfiguredProviderIds: ctx._getConfiguredProviderIds,
    getPinned: ctx._getPinned,
    render,
  });

  stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8'); // one line, as in the TUI's identical boot statement
  paintWindow.open();

  // Theme + forced dark/light before first paint; auto (TTY) probes + repaints once if light; the palette feeds `system`.
  const themeProbe = installStartupThemeProbe({
    configManager, stdout, writeAllowed: allowTerminalWrite,
    resetDiff: () => compositor.resetDiff(), render, invalidateTranscript: () => conversation.invalidateRenderedLines(), forwardInput: (b) => routeInput(b),
  });

  applyInitialTuiCliState({
    cli,
    input,
    commandRegistry,
    commandContext,
    shellPaths: ctx.services.shellPaths,
    surface: ctx.services.surface,
    render,
  });

  const routeInput = (data: string): void => {
    const blocking = handleBlockingShellInput({
      data,
      pendingPermission,
      recoveryPending, daemonRepairPrompt,
      abortTurn: () => orchestrator.abort(),
      conversation,
      systemMessageRouter,
      render,
      // Keyed to the OFFERED snapshot's sessionId (recoveryPending) so a
      // second, unrelated recovery snapshot on disk is never touched.
      consumeRecovery: () => consumeRecovery(ctx.services.surface, recoveryPending ?? undefined).snapshot,
      removeRecoveryPoint: () => { removeRecoveryPoint(ctx.services.surface, recoveryPending ?? undefined); },
    });
    ({ pendingPermission, recoveryPending } = blocking);
    if (blocking.handled) {
      return;
    }

    input.feed(data);
  };
  // Strip the terminal probe replies (OSC 11, and OSC 10 / OSC 4 for the palette) before the input pipeline sees them.
  stdin.on('data', (raw: string) => { const data = themeProbe.filterInput(raw); if (data.length > 0) routeInput(data); });
  process.on('SIGINT', sigintHandler);
  processFaults.register();
  stdout.on('resize', resizeHandler);

  conversation.rebuildHistory();
  render();
  ({ recoveryInterval, recoveryPending, daemonRepairPrompt } = startFirstRenderFollowups({
    shellPaths: ctx.services.shellPaths,
    providerRegistry,
    commandContext, daemonRepair: { config: configManager }, askWorkspaceRegistration: createWorkspaceRegistrationQuestion(input),
    autonomy,
    buildCurrentSessionSnapshot,
    runtime,
    conversation,
    workingDir,
    homeDirectory,
    surface: ctx.services.surface,
    systemMessageRouter,
    render,
    unsubs,
    uiServicesTurns: uiServices.events.turns,
    hookDispatcher,
    onStreamSpeedUpdate: (speed) => { streamTokenSpeed = speed; },
  }));
}
main().catch((err: unknown) => {
  reportFatalStartupError(err, {
    binary: 'goodvibes-agent',
    debug: process.env['GOODVIBES_AGENT_DEBUG'] === '1',
  }, {
    logError: (message, context) => logger.error(message, context),
    // NOT process.stderr.write: installFullScreenTerminalOutputGuard above
    // replaces it, so a failure raised after that install had its explanation
    // intercepted and swallowed, measured on a compiled binary as exit 1 with
    // zero bytes on both streams. A descriptor write cannot be intercepted.
    writeStderr: writeFatalLine,
    exit: (code) => process.exit(code),
  });
});
