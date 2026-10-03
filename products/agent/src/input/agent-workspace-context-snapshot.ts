import type { CommandContext } from './command-registry.ts';
import type { PromptContextReceipt } from '../agent/prompt-context-receipts.ts';
import { discoverProjectContextFiles } from '../agent/project-context-files.ts';
import { discoverVibeFiles } from '../agent/vibe-file.ts';
import type { AgentWorkspaceProcessSupervisionSummary, AgentWorkspacePromptContextReceiptSummary, AgentWorkspacePromptContextReceiptTimeline, AgentWorkspaceProjectContextSummary, AgentWorkspaceResearchContractSummary, AgentWorkspaceVibeSummary } from './agent-workspace-types.ts';

type WorkspaceMcpServerRecord = {
  readonly name?: string;
  readonly role?: string;
  readonly connected?: boolean;
  readonly trustMode?: string;
  readonly schemaFreshness?: string;
};

const RESEARCH_BROWSER_TERMS = ['browser', 'desktop', 'computer use', 'screenshot', 'screen recording'];
const WORKSPACE_PROJECT_CONTEXT_SOURCES = ['.hermes.md', 'HERMES.md', 'AGENTS.md', 'CLAUDE.md', 'HERMES_HOME/SOUL.md', '.cursorrules', '.cursor/rules/*.mdc'] as const;
const WORKSPACE_PROMPT_CONTEXT_INSPECT_ROUTE = 'context action:"prompt" includeParameters:true' as const;
type WorkspacePromptReceiptOutcomeStatus = AgentWorkspacePromptContextReceiptSummary['outcomeStatus'];

function promptReceiptInspectRoute(receiptId: string): string {
  return `context action:"receipt" receiptId:${JSON.stringify(receiptId)} includeParameters:true`;
}

function promptReceiptOutcomeRoute(status: WorkspacePromptReceiptOutcomeStatus): string {
  return `context action:"receipts" outcomeStatus:${JSON.stringify(status)} includeParameters:true`;
}

function workspaceMcpServers(context: CommandContext): readonly WorkspaceMcpServerRecord[] {
  try {
    return (context.clients?.mcpApi?.listServerSecurity?.() ?? []) as readonly WorkspaceMcpServerRecord[];
  } catch {
    return [];
  }
}

function matchesResearchBrowserTerm(server: WorkspaceMcpServerRecord): boolean {
  const haystack = `${server.name ?? ''}\n${server.role ?? ''}`.toLowerCase();
  return RESEARCH_BROWSER_TERMS.some((term) => haystack.includes(term));
}

export function buildResearchBrowserRunnerContract(context: CommandContext): AgentWorkspaceResearchContractSummary {
  const browserServers = workspaceMcpServers(context).filter(matchesResearchBrowserTerm);
  const ready = browserServers.some((server) =>
    server.connected === true
    && server.schemaFreshness === 'fresh'
    && server.trustMode !== 'blocked'
    && server.trustMode !== 'quarantined'
  );
  const needsReview = !ready && browserServers.length > 0;
  return {
    status: ready ? 'ready-with-confirmation' : needsReview ? 'needs-review' : 'setup-contract-needed',
    label: ready ? 'ready with confirmation' : needsReview ? 'needs setup review' : 'setup needed',
    next: ready
      ? 'Use browser-backed research only when live browser state or authentication is necessary.'
      : needsReview
        ? 'Review browser/desktop MCP trust, connection, and schema freshness before live browser-backed research.'
        : 'Use public web/fetch research now; configure a trusted browser/desktop route before live UI research.',
    route: 'research action:"plan" includeParameters:true',
    details: [
      'visible run controls',
      'source capture receipts',
      'bounded logs',
      'report handoff',
    ],
  };
}

export function buildResearchVisualReportContract(sourceSnapshot: {
  readonly reviewed: number;
  readonly used: number;
}): AgentWorkspaceResearchContractSummary {
  const sourceReady = sourceSnapshot.reviewed + sourceSnapshot.used > 0;
  return {
    status: sourceReady ? 'visual-report-packet-ready' : 'waiting-for-reviewed-sources',
    label: sourceReady ? 'visual report packet ready' : 'waiting for reviewed sources',
    next: sourceReady
      ? 'Save a sourced visual report packet now, then archive or promote the same reviewed artifact.'
      : 'Review at least one source before saving a report or visual packet.',
    route: sourceReady
      ? 'research action:"report" title:"..." question:"..." sources:[...] visualReport:true requireCitationCoverage:true confirm:true explicitUserRequest:"..."'
      : 'research action:"sources" includeParameters:true',
    details: [
      'at-a-glance',
      'evidence matrix',
      'source map',
      'citations',
      'handoff',
      'archive',
    ],
  };
}

export function buildVibeSummary(context: CommandContext): AgentWorkspaceVibeSummary {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) {
    return {
      status: 'unavailable',
      applied: 0,
      blocked: 0,
      truncated: 0,
      projectInitPath: null,
      globalInitPath: null,
      statusRoute: '/vibe status',
      initProjectRoute: '/vibe init',
      initGlobalRoute: '/vibe init --global',
      next: 'Open a normal Agent workspace before relying on VIBE.md personality files.',
    };
  }
  try {
    const snapshot = discoverVibeFiles(shellPaths);
    const truncated = snapshot.files.filter((file) => file.truncated).length;
    const status = snapshot.blocked.length > 0 ? 'attention' : snapshot.files.length > 0 ? 'ready' : 'needs-setup';
    return {
      status,
      applied: snapshot.files.length,
      blocked: snapshot.blocked.length,
      truncated,
      projectInitPath: snapshot.projectInitPath,
      globalInitPath: snapshot.globalInitPath,
      statusRoute: '/vibe status',
      initProjectRoute: '/vibe init',
      initGlobalRoute: '/vibe init --global',
      next: snapshot.blocked.length > 0
        ? 'Inspect blocked VIBE.md files before relying on custom personality.'
        : snapshot.files.length > 0
          ? 'VIBE.md personality is available for later main-conversation turns.'
          : 'Create a VIBE.md only when the user wants a persistent assistant feel.',
    };
  } catch {
    return {
      status: 'unavailable',
      applied: 0,
      blocked: 0,
      truncated: 0,
      projectInitPath: null,
      globalInitPath: null,
      statusRoute: '/vibe status',
      initProjectRoute: '/vibe init',
      initGlobalRoute: '/vibe init --global',
      next: 'VIBE.md discovery failed; use /vibe status for a focused diagnostic.',
    };
  }
}

export function buildProjectContextSummary(context: CommandContext): AgentWorkspaceProjectContextSummary {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) {
    return {
      status: 'unavailable',
      loaded: 0,
      blocked: 0,
      truncated: 0,
      supportedSources: WORKSPACE_PROJECT_CONTEXT_SOURCES,
      targetAware: true,
      catalogRoute: 'context action:"files"',
      inspectRoute: 'context action:"file"',
      next: 'Open a normal Agent workspace before relying on project context files.',
    };
  }
  try {
    const snapshot = discoverProjectContextFiles(shellPaths);
    const truncated = snapshot.files.filter((file) => file.truncated).length;
    const status = snapshot.blocked.length > 0 ? 'attention' : snapshot.files.length > 0 ? 'ready' : 'needs-setup';
    return {
      status,
      loaded: snapshot.files.length,
      blocked: snapshot.blocked.length,
      truncated,
      supportedSources: WORKSPACE_PROJECT_CONTEXT_SOURCES,
      targetAware: true,
      catalogRoute: 'context action:"files"',
      inspectRoute: 'context action:"file"',
      next: snapshot.blocked.length > 0
        ? 'Inspect blocked context files before relying on project instructions.'
        : snapshot.files.length > 0
          ? 'Project context instructions are available; inspect target-specific files before nuanced work.'
          : 'Add AGENTS.md or another supported context file when the project needs persistent instructions.',
    };
  } catch {
    return {
      status: 'unavailable',
      loaded: 0,
      blocked: 0,
      truncated: 0,
      supportedSources: WORKSPACE_PROJECT_CONTEXT_SOURCES,
      targetAware: true,
      catalogRoute: 'context action:"files"',
      inspectRoute: 'context action:"file"',
      next: 'Project context discovery failed; use context action:"files" for a focused diagnostic.',
    };
  }
}

function summarizePromptContextReceipt(receipt: PromptContextReceipt): AgentWorkspacePromptContextReceiptSummary {
  const outcomeStatus = receipt.turnOutcome?.status ?? 'pending';
  return {
    receiptId: receipt.receiptId,
    turnId: receipt.turnId,
    source: receipt.source,
    provider: receipt.provider,
    model: receipt.model,
    createdAt: receipt.createdAt,
    activeRecords: receipt.activeRecords,
    suppressedRecords: receipt.suppressedRecords,
    segmentCount: receipt.segments.length,
    approxPromptTokens: receipt.approxPromptTokens,
    outcomeStatus,
    stopReason: receipt.turnOutcome?.stopReason ?? null,
    completedAt: receipt.turnOutcome?.completedAt ?? null,
    detail: receipt.turnOutcome?.detail ?? null,
    inspectRoute: promptReceiptInspectRoute(receipt.receiptId),
    outcomeFilterRoute: promptReceiptOutcomeRoute(outcomeStatus),
  };
}

export function buildPromptContextReceiptTimeline(context: CommandContext): AgentWorkspacePromptContextReceiptTimeline {
  const store = context.clients?.promptContextReceipts;
  if (!store) {
    return {
      status: 'unavailable',
      count: 0,
      latestReceiptId: null,
      latestTurnId: null,
      completedCount: 0,
      errorCount: 0,
      cancelledCount: 0,
      pendingCount: 0,
      inspectRoute: WORKSPACE_PROMPT_CONTEXT_INSPECT_ROUTE,
      filterRoutes: {
        completed: promptReceiptOutcomeRoute('completed'),
        error: promptReceiptOutcomeRoute('error'),
        cancelled: promptReceiptOutcomeRoute('cancelled'),
        pending: promptReceiptOutcomeRoute('pending'),
      },
      next: 'Open a normal Agent workspace before relying on prompt-context receipt history.',
      items: [],
    };
  }
  try {
    const count = store.count();
    const recent = store.list(20);
    const completedCount = recent.filter((receipt) => receipt.turnOutcome?.status === 'completed').length;
    const errorCount = recent.filter((receipt) => receipt.turnOutcome?.status === 'error').length;
    const cancelledCount = recent.filter((receipt) => receipt.turnOutcome?.status === 'cancelled').length;
    const pendingCount = recent.filter((receipt) => !receipt.turnOutcome).length;
    const latest = recent[0] ?? null;
    return {
      status: count > 0 ? 'ready' : 'empty',
      count,
      latestReceiptId: latest?.receiptId ?? null,
      latestTurnId: latest?.turnId ?? null,
      completedCount,
      errorCount,
      cancelledCount,
      pendingCount,
      inspectRoute: WORKSPACE_PROMPT_CONTEXT_INSPECT_ROUTE,
      filterRoutes: {
        completed: promptReceiptOutcomeRoute('completed'),
        error: promptReceiptOutcomeRoute('error'),
        cancelled: promptReceiptOutcomeRoute('cancelled'),
        pending: promptReceiptOutcomeRoute('pending'),
      },
      next: count > 0
        ? 'Use Prompt context to inspect recent applied/suppressed context and terminal outcomes without raw prompt text.'
        : 'Run a normal Agent turn, then use Prompt context to review what local context was applied.',
      items: recent.slice(0, 5).map(summarizePromptContextReceipt),
    };
  } catch {
    return {
      status: 'unavailable',
      count: 0,
      latestReceiptId: null,
      latestTurnId: null,
      completedCount: 0,
      errorCount: 0,
      cancelledCount: 0,
      pendingCount: 0,
      inspectRoute: WORKSPACE_PROMPT_CONTEXT_INSPECT_ROUTE,
      filterRoutes: {
        completed: promptReceiptOutcomeRoute('completed'),
        error: promptReceiptOutcomeRoute('error'),
        cancelled: promptReceiptOutcomeRoute('cancelled'),
        pending: promptReceiptOutcomeRoute('pending'),
      },
      next: 'Prompt-context receipt history could not be read; use context action:"prompt" for a focused diagnostic.',
      items: [],
    };
  }
}

type WorkspaceProcessEntry = {
  readonly id?: string;
  readonly done?: boolean;
};

type WorkspaceProcessManager = {
  readonly list?: () => readonly WorkspaceProcessEntry[];
  readonly getStatus?: (processId: string) => WorkspaceProcessEntry | undefined;
};

const WORKSPACE_STDIN_METHOD_NAMES = ['write', 'writeInput', 'sendInput', 'writeStdin', 'sendStdin', 'stdinWrite'] as const;
const WORKSPACE_PTY_METHOD_NAMES = ['spawnPty', 'openPty', 'createPty', 'pty'] as const;

function processManagerMethodNames(manager: WorkspaceProcessManager | undefined): readonly string[] {
  if (!manager) return [];
  const record = manager as unknown as Record<string, unknown>;
  const own = Object.keys(record);
  const prototype = Object.getPrototypeOf(manager) as Record<string, unknown> | null;
  const protoNames = prototype ? Object.getOwnPropertyNames(prototype) : [];
  return [...new Set([...own, ...protoNames])]
    .filter((name) => name !== 'constructor' && typeof record[name] === 'function')
    .sort((left, right) => left.localeCompare(right));
}

export function buildProcessSupervisionSummary(context: CommandContext): AgentWorkspaceProcessSupervisionSummary {
  const manager = context.workspace?.processManager as WorkspaceProcessManager | undefined;
  const methodNames = processManagerMethodNames(manager);
  const stdinMethod = WORKSPACE_STDIN_METHOD_NAMES.find((name) => methodNames.includes(name)) ?? null;
  const ptyMethod = WORKSPACE_PTY_METHOD_NAMES.find((name) => methodNames.includes(name)) ?? null;
  const listed = (() => {
    try {
      return manager?.list?.() ?? [];
    } catch {
      return [];
    }
  })();
  const entries = listed.map((entry) => {
    try {
      return entry.id && manager?.getStatus ? manager.getStatus(entry.id) ?? entry : entry;
    } catch {
      return entry;
    }
  });
  return {
    status: manager ? 'available' : 'unavailable',
    tracked: entries.length,
    running: entries.filter((entry) => entry.done !== true).length,
    completed: entries.filter((entry) => entry.done === true).length,
    stdinWriteStatus: stdinMethod ? 'supported-with-confirmation' : 'not-yet-supported',
    stdinMethod,
    ptyStatus: ptyMethod ? 'contract-discovered' : 'not-yet-supported',
    ptyMethod,
    sudoStatus: 'foreground-only',
    processRoute: 'execution action:"processes"',
    capabilitiesRoute: 'process action:"capabilities"',
    visibleMonitorRoute: 'workspace action:"open" surfaceId:"process-monitor"',
    liveTailRoute: 'workspace action:"open" surfaceId:"live-tail"',
  };
}
