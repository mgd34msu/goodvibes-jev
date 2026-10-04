import type { ProductInputContext } from '../runtime/native-conversation-input.ts';
import type { NativeConversationIntakeActions, NativeConversationIntakeState } from '../runtime/native-conversation-intake.ts';
import type { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import type { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { ConversationManager } from '../core/conversation';
import type { ConfigManager } from '../config/index.ts';
import type { DeepReadonly, GoodVibesConfig } from '../config/index.ts';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ProcessManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { PermissionRequestHandler } from '@goodvibes-jev/engine/sdk/platform/permissions';
import type { SelectionItem, SelectionResult, SelectionAction } from './selection-modal.ts';
import type { FileUndoManager } from '@goodvibes-jev/engine/sdk/platform/state';
import type { KeybindingsManager } from './keybindings.ts';
import type { KnowledgeApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { HookApi } from '@goodvibes-jev/engine/sdk/platform/hooks';
import type { McpApi } from '@goodvibes-jev/engine/sdk/platform/mcp';
import type { ProviderApi } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { OpsApi } from '@/runtime/index.ts';
import type { OperatorClient } from '@/runtime/index.ts';
import type { PeerClient } from '@/runtime/index.ts';
import type { DirectTransport } from '@/runtime/index.ts';
import type { AgentPromptContextReceiptStore } from '../agent/prompt-context-receipts.ts';
import type { MemoryConsolidationProposal } from '@goodvibes-jev/engine/sdk/platform/state';
import type { VoiceProviderRegistry, VoiceService } from '@goodvibes-jev/engine/sdk/platform/voice';
import type { AgentMemoryDiagnostics, AgentVoiceSetupService } from '../runtime/services.ts';
import type { MediaProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/media';
import type { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { ChannelDeliveryRouter } from '@goodvibes-jev/engine/sdk/platform/channels';
import type { AgentExecutionLedger } from '../runtime/execution-ledger.ts';
import type { ApprovalsView } from '../runtime/client/approvals-view.ts';
import type {
  CommandWorkspaceShellServices,
} from '@/runtime/index.ts';
import type {
  CommandPlatformShellServices,
} from '@/runtime/index.ts';
import type {
  CommandExtensionShellServices,
} from '@/runtime/index.ts';
import type {
  CommandOpsShellServices,
  RemoteCommandService,
  PlanRuntimeService,
} from '@/runtime/index.ts';

export type {
  RemoteCommandService,
  PlanRuntimeService,
} from '@/runtime/index.ts';

export interface CommandRuntimeState {
  model: string;
  provider: string;
  debugMode: boolean;
  systemPrompt: string;
  reasoningEffort: string;
  sessionId: string;
}

/**
 * Top-level shell actions remain flat because commands and nearby shell routes
 * use them constantly, and nesting them would add noise without clarifying
 * ownership.
 */
export interface CommandUiActions {
  renderRequest: () => void;
  print: (text: string) => void;
  exit: () => void;
  nativeConversationIntake?: NativeConversationIntakeActions;
  dispatchNativeIntakeTurn?: (state: NativeConversationIntakeState) => Promise<void>;
  submitInput?: (text: string, content?: import('@goodvibes-jev/engine/sdk/platform/providers').ContentPart[], context?: ProductInputContext) => void;
  submitSpokenInput?: (text: string, content?: import('@goodvibes-jev/engine/sdk/platform/providers').ContentPart[]) => void;
  stopSpokenOutput?: () => void;
  pasteFromClipboard?: () => {
    pasted: boolean;
    kind: 'image' | 'text' | 'none';
    marker?: string;
  };
  /**
   * Ask the composer for one line of MASKED entry (see input/concealed-input.ts).
   * The typed characters are never echoed, never added to input history, and
   * never printed to the transcript; the plaintext reaches `onSubmit` exactly
   * once. Used by `/payments card` for card number, expiry, CVV and cardholder
   * name.
   *
   * Optional because a command context can be built without a live composer
   * (CLI paths, tests). A caller that needs concealment MUST refuse to fall
   * back to plaintext entry when this is absent rather than degrade, see
   * commands/payment-card-intake.ts.
   */
  beginConcealedInput?: (request: import('./concealed-input.ts').ConcealedInputRequest) => void;
  /**
   * Ask the composer for one line of ORDINARY, echoed entry, the unmasked
   * sibling of beginConcealedInput, used by `/payments address` for the seven
   * billing / shipping fields. Deliberately a separate call rather than a flag
   * on the concealed request; see input/plain-line-input.ts.
   */
  beginPlainInput?: (request: import('./plain-line-input.ts').PlainLineInputRequest) => void;
  executeCommand?: (name: string, args: string[]) => Promise<boolean>;
  cancelGeneration?: () => void;
  /** True while a turn is running (a local or hosted turn has the orchestrator thinking). */
  isGenerating?: () => boolean;
  completeModelSelection?: (selection: {
    model: { id: string; provider: string; displayName: string; registryKey: string };
    effort: string;
    contextCap?: number | null;
    /** Which config target to write the selected model to. Defaults to 'main'. */
    target?: import('./model-picker.ts').ModelPickerTarget;
    /**
     * True only when `effort` came from the picker's effort STEP, an explicit
     * user choice, which is the only thing allowed to update the stored
     * preference `provider.reasoningEffort`. The model-only and context-cap
     * commit routes pass a level merely carried over from the previous model;
     * storing that is how a one-time snap down used to become permanent.
     */
    effortChosenByUser?: boolean;
  }) => void;
  clearScreen?: () => void;
  activatePlan?: (planId: string, task: string) => void;
  requestPermission?: PermissionRequestHandler;
}

export interface CommandShellUiOpeners {
  reloadSystemPrompt?: () => string;
  openModelPicker?: () => void;
  openModelPickerWithTarget?: (target: import('./model-picker.ts').ModelPickerTarget) => boolean;
  openProviderModelPickerWithTarget?: (target: import('./model-picker.ts').ModelPickerTarget) => boolean;
  openProviderPicker?: () => void;
  openReasoningEffortPicker?: () => {
    opened: boolean;
    model?: string;
    levels?: readonly string[];
    reason?: 'unsupported';
  };
  openContextInspector?: () => void;
  openBookmarkModal?: () => void;
  openProcessModal?: () => void;
  openConversationSearch?: (query?: string) => void;
  openPromptHistorySearch?: (query?: string) => void;
  openSlashCommandMode?: (query?: string) => boolean;
  openFilePicker?: (options?: { injectMode?: boolean; query?: string }) => boolean;
  openBlockActions?: () => boolean;
  openLiveTail?: (target?: string) => {
    opened: boolean;
    processId?: string;
    label?: string;
    reason?: 'no_processes' | 'not_found';
  };
  jumpToBookmark?: (key: string) => void;
  scrollToLine?: (line: number) => void;
  openHelpOverlay?: () => void;
  openSelection?: (
    title: string,
    items: SelectionItem[],
    opts: {
      preSelectId?: string;
      allowSearch?: boolean;
      customActions?: Map<string, SelectionAction>;
      /** Live preview: called whenever the highlighted row changes. */
      onHighlight?: (item: SelectionItem | null) => void;
    } | undefined,
    callback: (result: SelectionResult | null) => void,
  ) => void;
  openSettingsModal?: (target?: string) => void;
  openSessionPicker?: () => void;
  openProfilePicker?: () => void;
  openShortcutsOverlay?: () => void;
  getScrollTop?: () => number;
  openWorkspacePicker?: () => void;
  focusPrompt?: () => void;
  openMcpWorkspace?: () => void;
  openAgentWorkspace?: (categoryId?: string) => void;
  dismissAgentWorkspace?: () => boolean;
  openSecurityWorkspace?: () => void;
  openKnowledgeWorkspace?: () => void;
  openSubscriptionWorkspace?: () => void;
  /** Open the Activity modal (Ctrl+O, /activity). */
  openActivityModal?: () => void;
  /** Open the notification history (/notifications): every system notice in full. */
  openNotifications?: () => void;
  /**
   * Open an agent or a background process full screen (core/session-focus.ts).
   * False when it is not known here (the caller keeps its own fallback).
   */
  openSessionView?: (target: { readonly kind: 'agent' | 'process'; readonly id: string }) => boolean;
}

export interface CommandSessionServices {
  readonly conversationManager: ConversationManager;
  readonly runtime: CommandRuntimeState;
  readonly sessionManager?: import('@goodvibes-jev/engine/sdk/platform/sessions').SessionManager;
  readonly sessionMemoryStore?: import('@goodvibes-jev/engine/sdk/platform/core').SessionMemoryStore;
  readonly sessionLineageTracker?: import('@goodvibes-jev/engine/sdk/platform/core').SessionLineageTracker;
  readonly changeTracker?: import('@goodvibes-jev/engine/sdk/platform/sessions').SessionChangeTracker;
  /**
   * Writes the surface-scoped last-session pointer file. Bound once at
   * bootstrap to the runtime's SessionSurface (see
   * the SDK's bindWriteLastSessionPointerToSurface)
   * so this command layer never has to re-derive the surface itself. Called
   * at the moment runtime.sessionId changes to a session the user explicitly
   * homed the live session on (/session resume, /session fork) so the next
   * launch's "resume last session" reads the session actually in use, not a
   * stale pointer.
   */
  readonly writeLastSessionPointer?: (sessionId: string) => void;
  /** Reload a resumed session's persisted rewind anchors. Bound at bootstrap to the runtime's SessionSurface; returns how many were restored. */
  readonly restoreTurnAnchors?: (sessionId: string) => number;
  /**
   * The runtime's declare-once session-storage handle: the directory the
   * session files and their sidecars (rewind anchors, work-tree view) live in.
   */
  readonly surface?: import('@/runtime/index.ts').SessionSurface;
  /**
   * Recompute the Orchestrator's usage totals and context occupancy from the
   * conversation's current messages (after /clear empties it, both read zero).
   */
  readonly hydrateSessionUsage?: () => void;
}

export interface CommandProviderServices {
  readonly providerRegistry: ProviderRegistry;
  readonly providerOptimizer?: import('@goodvibes-jev/engine/sdk/platform/providers').ProviderOptimizer;
  readonly favoritesStore?: import('@goodvibes-jev/engine/sdk/platform/providers').FavoritesStore;
  readonly benchmarkStore?: import('@goodvibes-jev/engine/sdk/platform/providers').BenchmarkStore;
}

/**
 * Compose locally-owned command helpers with the narrower runtime-owned
 * runtime surfaces exported from runtime/shell-command-services.ts.
 */
export interface CommandWorkspaceUiServices {
  keybindingsManager?: KeybindingsManager;
  fileUndoManager?: FileUndoManager;
  processManager?: ProcessManager;
  profileManager?: import('@goodvibes-jev/engine/sdk/platform/profiles').ProfileManager;
  bookmarkManager?: import('@goodvibes-jev/engine/sdk/platform/bookmarks').BookmarkManager;
  projectPlanningService?: import('@goodvibes-jev/engine/sdk/platform/knowledge').ProjectPlanningService;
  projectPlanningProjectId?: string;
  workPlanStore?: import('@goodvibes-jev/engine/sdk/platform/workflow').WorkPlanStore;
}

export interface CommandWorkspaceServices
  extends CommandWorkspaceUiServices,
    CommandWorkspaceShellServices {}

export interface CommandPlatformConfigServices {
  readonly config: DeepReadonly<GoodVibesConfig>;
  readonly configManager: ConfigManager;
  readonly voiceProviderRegistry?: VoiceProviderRegistry;
  readonly voiceService?: VoiceService;
  readonly voiceSetup?: AgentVoiceSetupService;
  /** Live memory-governance snapshot source (/health memory); absent against an older host build. */
  readonly memoryGovernor?: AgentMemoryDiagnostics;
  readonly mediaProviderRegistry?: MediaProviderRegistry;
  readonly artifactStore?: Pick<ArtifactStore, 'create'> & Partial<Pick<ArtifactStore, 'get' | 'list' | 'readContent'>>;
  readonly channelDeliveryRouter?: Pick<ChannelDeliveryRouter, 'deliver' | 'listStrategies'>;
}

export interface CommandPlatformServices
  extends CommandPlatformConfigServices,
    CommandPlatformShellServices {}

export interface CommandOpsServices
  extends CommandOpsShellServices {
  readonly executionLedger?: AgentExecutionLedger;
  /**
   * The approvals list's source: the daemon's record over `approvals.list`
   * unioned with the asks this process still holds, plus the honest reason
   * when the daemon's record could not be read. Optional because a narrow
   * command context (a one-shot subcommand, a test double) may carry no
   * runtime graph, `/health approvals` says so rather than rendering zero.
   */
  readonly approvalsView?: ApprovalsView;
}

export interface CommandExtensionRegistryServices {
  readonly toolRegistry: ToolRegistry;
  readonly mcpRegistry: McpRegistry;
}

export interface CommandExtensionServices
  extends CommandExtensionRegistryServices,
    CommandExtensionShellServices {
  readonly agentKnowledgeService?: import('@goodvibes-jev/engine/sdk/platform/knowledge').KnowledgeService;
}

/** Read-only handle onto pending memory-consolidation judgment proposals (see agent/memory-consolidation-proposals.ts). */
export interface ConsolidationProposalsClient {
  listPendingProposals(): readonly MemoryConsolidationProposal[];
}

/**
 * CommandContext - Passed to every slash command handler so commands can
 * interact with the shell-facing platform surface without treating every
 * service as one flat bag of unrelated properties.
 */
export interface CommandContext
  extends CommandUiActions,
    CommandShellUiOpeners {
  nativeWorkLedger?: import('../runtime/native-work-ledger.ts').NativeWorkLedgerView;
  readonly session: CommandSessionServices;
  readonly provider: CommandProviderServices;
  readonly workspace: CommandWorkspaceServices;
  readonly platform: CommandPlatformServices;
  readonly ops: CommandOpsServices;
  readonly extensions: CommandExtensionServices;
  readonly clients?: {
    readonly operator?: OperatorClient;
    readonly peer?: PeerClient;
    readonly providerApi?: ProviderApi;
    readonly agentKnowledgeApi?: KnowledgeApi;
    readonly promptContextReceipts?: AgentPromptContextReceiptStore;
    readonly hookApi?: HookApi;
    readonly mcpApi?: McpApi;
    readonly opsApi?: OpsApi;
    readonly transport?: DirectTransport;
    /**
     * Read-only access to pending memory-consolidation judgment proposals
     * (contradictions, cross-scope duplicates, stale-delete candidates),
     * adopts the SDK's memory.consolidation.receipts verb shape locally
     * (see agent/memory-consolidation-proposals.ts), since this runtime owns
     * the consolidation scheduler directly rather than reaching it over the
     * wire.
     */
    readonly memoryConsolidation?: ConsolidationProposalsClient;
  };
  /**
   * True when the MODEL invoked this command rather than the owner typing it.
   *
   * The `agent_harness mode:"run_command"` tool can run any registered command,
   * so "it came in as a slash command" is not by itself evidence that a human
   * performed a gesture, a model reading injected text can produce a tool call
   * as easily as any other. Most commands do not care. A command that grants
   * authority does: see input/commands/google-runtime.ts, where the approval
   * path refuses unless this is absent.
   *
   * Set only by the harness command runner, which knows what it is. Absent
   * means the surface's own input handler received keystrokes.
   */
  readonly invokedByModel?: boolean | undefined;
}

/**
 * SlashCommand - A single slash command definition.
 */
export interface SlashCommand {
  /** Primary name, e.g. "model". Full invocation is "/model". */
  name: string;
  /** Alternate names, e.g. ["m"]. */
  aliases?: string[];
  /** One-line description shown in /help output. */
  description: string;
  /** Optional usage hint, e.g. "<model-id>". */
  usage?: string;
  /** Short inline argument hint shown after cursor in dim grey, e.g. "[name]". Falls back to usage if not set. */
  argsHint?: string;
  /**
   * Hidden commands still run when typed, but stay out of fuzzy autocomplete
   * suggestions. They surface in autocomplete on an exact name or alias match.
   * The /help overlay also filters them. The /commands slash command lists
   * all commands including hidden ones, labeled "(hidden)".
   */
  hidden?: boolean;
  /** The function executed when the command is invoked. */
  handler: (args: string[], context: CommandContext) => void | Promise<void>;
}

/**
 * CommandRegistry - Central registry for all slash commands.
 * Supports fuzzy prefix matching for autocomplete.
 */
export class CommandRegistry {
  private commands = new Map<string, SlashCommand>();
  private aliasIndex = new Map<string, SlashCommand>();

  /**
   * Register a command. Also indexes all aliases for O(1) lookup.
   *
   * Collisions are LOUD: a second registration of the same primary name, or an
   * alias that shadows an existing command's name or alias, throws instead of
   * silently overwriting. Silent last-write-wins hid a real /session
   * double-registration (session-workflow.ts vs commands/session.ts); the fork
   * bypassed this check, so make it fail fast at startup instead.
   */
  register(command: SlashCommand): void {
    const existingByName = this.commands.get(command.name) ?? this.aliasIndex.get(command.name);
    if (existingByName) {
      throw new Error(
        `Command registration collision: "${command.name}" is already registered by /${existingByName.name}.`,
      );
    }
    for (const alias of command.aliases ?? []) {
      const holder = this.commands.get(alias) ?? this.aliasIndex.get(alias);
      if (holder) {
        throw new Error(
          `Command alias collision: "${alias}" on /${command.name} is already registered by /${holder.name}.`,
        );
      }
    }
    this.commands.set(command.name, command);
    for (const alias of command.aliases ?? []) {
      this.aliasIndex.set(alias, command);
    }
  }

  /** Remove a command by primary name. Also removes its alias entries. */
  unregister(name: string): void {
    const cmd = this.commands.get(name);
    if (cmd) {
      for (const alias of cmd.aliases ?? []) {
        this.aliasIndex.delete(alias);
      }
    }
    this.commands.delete(name);
  }

  /**
   * get - Look up a command by its primary name or alias. O(1) for both.
   */
  get(name: string): SlashCommand | undefined {
    return this.commands.get(name) ?? this.aliasIndex.get(name);
  }

  /** All registered commands. */
  getAll(): SlashCommand[] {
    return Array.from(this.commands.values());
  }

  /** Commands that should appear in autocomplete and /help listings. */
  getVisible(): SlashCommand[] {
    return this.getAll().filter((command) => !command.hidden);
  }

  /**
   * list - Compatibility alias for the simpler SDK registry surface.
   */
  list(): SlashCommand[] {
    return this.getAll();
  }

  /**
   * fuzzyMatch - Return commands ranked by how well `query` matches their
   * name or aliases. Returns all commands when query is empty.
   */
  fuzzyMatch(query: string): Array<{ command: SlashCommand; score: number }> {
    const q = query.toLowerCase();
    const results: Array<{ command: SlashCommand; score: number }> = [];

    for (const cmd of this.commands.values()) {
      const names = [cmd.name, ...(cmd.aliases ?? [])];
      let bestScore = 0;

      for (const candidate of names) {
        const score = scoreMatch(q, candidate);
        if (score > bestScore) bestScore = score;
      }

      // Hidden commands stay out of suggestions until the user types the
      // exact name or alias, they still execute normally.
      if (cmd.hidden && !names.map((n) => n.toLowerCase()).includes(q)) continue;

      if (bestScore > 0 || q === '') {
        results.push({ command: cmd, score: q === '' ? 1 : bestScore });
      }
    }

    // Sort: higher score first, then alphabetically
    results.sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name));
    return results;
  }

  /**
   * execute - Look up and run a command. Returns true if found, false otherwise.
   */
  async execute(rawName: string, args: string[], context: CommandContext): Promise<boolean> {
    const cmd = this.get(rawName);
    if (!cmd) return false;
    await cmd.handler(args, context);
    return true;
  }
}

/**
 * scoreMatch - Simple prefix/subsequence scorer.
 * Returns 0 if no match, higher is better.
 */
function scoreMatch(query: string, candidate: string): number {
  if (query === '') return 1;
  if (candidate === query) return 100;
  if (candidate.startsWith(query)) return 80;

  // Subsequence check
  let qi = 0;
  for (let ci = 0; ci < candidate.length && qi < query.length; ci++) {
    if (candidate[ci] === query[qi]) qi++;
  }
  if (qi === query.length) return 40 - query.length; // shorter query → higher score
  return 0;
}
