import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';

export interface AgentHarnessSessionArgs {
  readonly sessionId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type SessionResolution =
  | { readonly status: 'found'; readonly session: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

interface SessionSearchResult {
  readonly session: SessionInfoLike;
  readonly matchCount: number;
  readonly snippets: readonly string[];
}

interface SessionInfoLike {
  readonly name: string;
  readonly title: string;
  readonly model: string;
  readonly provider: string;
  readonly timestamp: number;
  readonly messageCount: number;
  readonly filePath: string;
  readonly returnContext?: {
    readonly activeTasks?: number;
    readonly blockedTasks?: number;
    readonly pendingApprovals?: number;
    readonly remoteRunners?: readonly unknown[];
    readonly worktreePaths?: readonly string[];
  } | undefined;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function readSessionLookup(args: AgentHarnessSessionArgs): { readonly source: 'sessionId' | 'target' | 'query'; readonly input: string } | null {
  const sessionId = readString(args.sessionId);
  if (sessionId) return { source: 'sessionId', input: sessionId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function safeIso(timestamp: number): string | null {
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : null;
}

function sessionSearchText(session: SessionInfoLike): string {
  return [
    session.name,
    session.title,
    session.model,
    session.provider,
    session.filePath,
  ].join('\n').toLowerCase();
}

function returnContextSummary(session: SessionInfoLike): Record<string, unknown> | undefined {
  const context = session.returnContext;
  if (!context) return undefined;
  return {
    activeTasks: context.activeTasks ?? 0,
    blockedTasks: context.blockedTasks ?? 0,
    pendingApprovals: context.pendingApprovals ?? 0,
    remoteRunners: context.remoteRunners?.length ?? 0,
    worktreePaths: context.worktreePaths?.length ?? 0,
  };
}

function describeSessionCandidate(session: SessionInfoLike, currentSessionId: string): Record<string, unknown> {
  return {
    sessionId: session.name,
    title: session.title || '(untitled)',
    messageCount: session.messageCount,
    active: session.name === currentSessionId,
    modelRoute: sessionModelRoute(),
  };
}

function sessionModelRoute(): string {
  return 'sessions action:"get" or workspace action:"run_command"';
}

function bookmarkModelRoute(): string {
  return 'agent_harness mode:"open_ui_surface" or agent_knowledge_ingest';
}

function describeSession(
  session: SessionInfoLike,
  options: {
    readonly currentSessionId: string;
    readonly includeParameters?: boolean;
    readonly search?: { readonly matchCount: number; readonly snippets: readonly string[] };
    readonly lookup?: Record<string, unknown>;
  },
): Record<string, unknown> {
  const posture = returnContextSummary(session);
  return {
    sessionId: session.name,
    title: session.title || '(untitled)',
    timestamp: safeIso(session.timestamp),
    messageCount: session.messageCount,
    model: session.model || null,
    provider: session.provider || null,
    active: session.name === options.currentSessionId,
    modelRoute: sessionModelRoute(),
    ...(options.includeParameters ? {} : { summary: previewHarnessText(session.title || session.name) }),
    ...(posture ? { returnContext: posture } : {}),
    ...(options.search ? {
      search: {
        matchCount: options.search.matchCount,
        ...(options.includeParameters ? { snippets: options.search.snippets.slice(0, 3) } : {}),
      },
    } : {}),
    ...(options.includeParameters ? {
      filePath: session.filePath,
      modelRoutes: {
        inspectSessions: 'sessions action:"list"',
        inspectSession: 'sessions action:"get"',
        resumeSession: '/session resume <session-id-or-name>',
        saveSession: '/session save [name]',
        exportSession: '/session export <session-id> markdown',
        deleteSession: '/session delete <session-id> --yes',
      },
    } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.includeParameters ? {
      policy: {
        effect: 'read-only',
        values: 'Session posture returns saved-session metadata, search counts, optional snippets, return-context counts, bookmark counts, and saved bookmark file counts.',
        mutation: 'Session save, rename, fork, resume, export, delete, bookmark toggles, and bookmark file writes remain visible workspace or slash-command flows with confirmation where mutating.',
      },
    } : {}),
  };
}

function currentSession(context: CommandContext): Record<string, unknown> {
  const runtime = context.session.runtime;
  const conversationManager = context.session.conversationManager;
  if (!runtime || !conversationManager) {
    return {
      status: 'unavailable',
      sessionId: null,
      title: '(unavailable)',
      messageCount: 0,
    };
  }
  const transcriptIndex = conversationManager.getTranscriptEventIndex();
  return {
    sessionId: runtime.sessionId,
    title: conversationManager.title || '(untitled)',
    messageCount: conversationManager.getMessageCount(),
    model: runtime.model,
    provider: runtime.provider,
    transcript: {
      events: transcriptIndex.events.length,
      groups: transcriptIndex.groups.length,
    },
  };
}

function bookmarkSummary(context: CommandContext, includeParameters = false): Record<string, unknown> {
  const manager = context.workspace.bookmarkManager;
  if (!manager) {
    return {
      status: 'unavailable',
      bookmarks: 0,
      savedFiles: 0,
      modelRoute: bookmarkModelRoute(),
    };
  }
  return {
    status: 'available',
    bookmarks: manager.list().length,
    savedFiles: manager.listSavedFiles().length,
    modelRoute: bookmarkModelRoute(),
    ...(includeParameters ? {
      modelRoutes: {
        visibleBookmarkPicker: 'agent_harness mode:"open_ui_surface" surfaceId:"bookmarks" confirm:true explicitUserRequest:"..."',
        command: '/bookmarks',
        importIntoKnowledge: 'agent_knowledge_ingest sourceKind:"bookmarks_file" confirm:true explicitUserRequest:"..."',
      },
    } : {}),
  };
}

export function sessionCatalogStatus(context: CommandContext): Record<string, unknown> {
  const manager = context.session.sessionManager;
  const runtime = context.session.runtime;
  return {
    modes: ['sessions', 'session'],
    savedSessions: manager?.list().length ?? 0,
    currentSessionId: runtime?.sessionId ?? null,
    readOnly: true,
  };
}

export function sessionSummary(context: CommandContext, args: AgentHarnessSessionArgs): Record<string, unknown> {
  const manager = context.session.sessionManager;
  const runtime = context.session.runtime;
  if (!manager || !runtime) {
    return {
      status: 'unavailable',
      sessions: [],
      returned: 0,
      total: 0,
      current: currentSession(context),
      bookmarks: bookmarkSummary(context, args.includeParameters === true),
      policy: 'Session runtime or session manager is unavailable in this Agent context.',
    };
  }
  const currentSessionId = runtime.sessionId;
  const query = readString(args.query);
  const searchResults: readonly SessionSearchResult[] = query ? manager.search(query) : [];
  const searchByName = new Map(searchResults.map((result) => [result.session.name, result]));
  const sessions = query
    ? searchResults.map((result) => result.session)
    : manager.list().filter((session) => !query || sessionSearchText(session).includes(query.toLowerCase()));
  const limited = sessions.slice(0, readLimit(args.limit, 100));
  return {
    status: 'available',
    current: currentSession(context),
    bookmarks: bookmarkSummary(context, args.includeParameters === true),
    sessions: limited.map((session) => {
      const search = searchByName.get(session.name);
      return describeSession(session, {
        currentSessionId,
        includeParameters: args.includeParameters === true,
        ...(search ? { search: { matchCount: search.matchCount, snippets: search.snippets } } : {}),
      });
    }),
    returned: limited.length,
    total: sessions.length,
    savedSessions: manager.list().length,
    policy: 'Read-only session and bookmark posture. Save, resume, rename, fork, export, delete, bookmark toggles, and bookmark file writes remain visible workspace or slash-command flows.',
  };
}

export function describeHarnessSession(context: CommandContext, args: AgentHarnessSessionArgs): SessionResolution {
  const manager = context.session.sessionManager;
  if (!manager) {
    return {
      status: 'missing_lookup',
      usage: 'Session manager is unavailable in this Agent context.',
    };
  }
  const lookup = readSessionLookup(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'session requires sessionId, target, or query. Use mode:"sessions" to inspect saved session ids.',
    };
  }
  const sessions = manager.list();
  const currentSessionId = context.session.runtime.sessionId;
  const exact = sessions.find((session) => session.name === lookup.input);
  if (exact) return { status: 'found', session: describeSession(exact, { currentSessionId, includeParameters: true, lookup: { ...lookup, resolvedBy: 'id' } }) };
  const normalized = lookup.input.toLowerCase();
  const insensitive = sessions.find((session) => session.name.toLowerCase() === normalized);
  if (insensitive) return { status: 'found', session: describeSession(insensitive, { currentSessionId, includeParameters: true, lookup: { ...lookup, resolvedBy: 'case-insensitive-id' } }) };
  const prefix = sessions.filter((session) => session.name.toLowerCase().startsWith(normalized));
  if (prefix.length === 1) return { status: 'found', session: describeSession(prefix[0]!, { currentSessionId, includeParameters: true, lookup: { ...lookup, resolvedBy: 'prefix' } }) };
  if (prefix.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: prefix.slice(0, 8).map((session) => describeSessionCandidate(session, currentSessionId)),
    };
  }
  const searched = sessions.filter((session) => sessionSearchText(session).includes(normalized));
  if (searched.length === 1) return { status: 'found', session: describeSession(searched[0]!, { currentSessionId, includeParameters: true, lookup: { ...lookup, resolvedBy: 'search' } }) };
  if (searched.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: searched.slice(0, 8).map((session) => describeSessionCandidate(session, currentSessionId)),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown session ${lookup.input}. Use mode:"sessions" to inspect saved session ids.`,
  };
}
