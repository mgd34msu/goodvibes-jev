import type { CommandContext } from '../input/command-registry.ts';
import {
  discoverProjectContextFiles,
  type AgentProjectContextSnapshot,
  type AgentProjectContextFile,
  type BlockedAgentProjectContextFile,
} from '../agent/project-context-files.ts';
import { previewHarnessText } from './agent-harness-text.ts';

interface AgentHarnessProjectContextArgs {
  readonly contextFileId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
}

type ProjectContextRecord = AgentProjectContextFile | BlockedAgentProjectContextFile;

export type ProjectContextFileResolution =
  | { readonly status: 'found'; readonly file: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function snapshotForArgs(context: CommandContext, args: AgentHarnessProjectContextArgs): AgentProjectContextSnapshot | null {
  const shellPaths = context.workspace.shellPaths;
  if (!shellPaths) return null;
  const targetPath = readString(args.target);
  return discoverProjectContextFiles(shellPaths, targetPath ? { targetPath } : {});
}

function recordSearchText(record: ProjectContextRecord): string {
  return [
    record.id,
    record.path,
    record.kind,
    record.scope,
    record.source,
    'body' in record ? record.body : record.reason,
  ].join('\n').toLowerCase();
}

function describeRecord(record: ProjectContextRecord, includeParameters: boolean): Record<string, unknown> {
  const blocked = !('body' in record);
  return {
    id: record.id,
    path: record.path,
    kind: record.kind,
    scope: record.scope,
    source: record.source,
    status: blocked ? 'blocked' : record.truncated ? 'truncated' : 'loaded',
    summary: blocked
      ? previewHarnessText(record.reason, includeParameters ? 180 : 96)
      : previewHarnessText(record.body, includeParameters ? 240 : 96),
    modelRoute: 'context action:"file"',
    userRoute: 'Agent Workspace -> Local Context -> Inspect project context',
    ...(includeParameters && 'body' in record ? { body: record.body, truncated: record.truncated } : {}),
    ...(includeParameters && !('body' in record) ? { reason: record.reason } : {}),
  };
}

export function projectContextCatalogStatus(context: CommandContext): Record<string, unknown> {
  const shellPaths = context.workspace.shellPaths;
  if (!shellPaths) {
    return {
      modes: ['project_context', 'project_context_file'],
      status: 'unavailable',
      reason: 'Project context discovery requires workspace shell paths.',
      targetAware: true,
    };
  }
  const snapshot = discoverProjectContextFiles(shellPaths);
  return {
    modes: ['project_context', 'project_context_file'],
    status: snapshot.blocked.length > 0 ? 'attention' : snapshot.files.length > 0 ? 'ready' : 'needs-setup',
    loaded: snapshot.files.length,
    blocked: snapshot.blocked.length,
    truncated: snapshot.files.filter((file) => file.truncated).length,
    targetAware: true,
  };
}

export function projectContextSummary(context: CommandContext, args: AgentHarnessProjectContextArgs): Record<string, unknown> {
  const includeParameters = args.includeParameters === true;
  const snapshot = snapshotForArgs(context, args);
  if (!snapshot) {
    return {
      status: 'unavailable',
      files: [],
      returned: 0,
      total: 0,
      loaded: 0,
      blocked: 0,
      truncated: 0,
      policy: 'Project context discovery requires workspace shell paths.',
      nextActions: ['Open a normal Agent workspace before relying on project context files.'],
    };
  }
  const records: readonly ProjectContextRecord[] = [...snapshot.files, ...snapshot.blocked];
  const query = readString(args.query).toLowerCase();
  const filtered = query ? records.filter((record) => recordSearchText(record).includes(query)) : records;
  return {
    status: snapshot.blocked.length > 0 ? 'attention' : snapshot.files.length > 0 ? 'ready' : 'needs-setup',
    files: filtered.map((record) => describeRecord(record, includeParameters)),
    returned: filtered.length,
    total: records.length,
    loaded: snapshot.files.length,
    blocked: snapshot.blocked.length,
    truncated: snapshot.files.filter((file) => file.truncated).length,
    workingDirectory: snapshot.workingDirectory,
    targetDirectory: snapshot.targetDirectory,
    gitRoot: snapshot.gitRoot,
    searchedPaths: includeParameters ? snapshot.searchedPaths : snapshot.searchedPaths.slice(0, 12),
    policy: 'Project context files are read-only prompt instructions. Secret-looking files are blocked, loaded bodies are bounded, and explicit user instructions/tool safety override context files.',
    nextActions: snapshot.files.length > 0
      ? ['Inspect one context file before relying on subdirectory-specific instructions.', 'Edit context files in the workspace if the visible guidance is stale.']
      : ['Add AGENTS.md or VIBE.md when the project needs persistent instructions.'],
  };
}

export function describeProjectContextFile(context: CommandContext, args: AgentHarnessProjectContextArgs): ProjectContextFileResolution {
  const input = readString(args.contextFileId || args.target || args.query);
  if (!input) return { status: 'missing_lookup', usage: 'context action:"file" requires contextFileId, target, or query. Use context action:"files" to inspect available context files.' };
  const snapshot = snapshotForArgs(context, args);
  if (!snapshot) return { status: 'missing_lookup', usage: 'Project context discovery requires workspace shell paths.' };
  const includeParameters = args.includeParameters !== false;
  const records: readonly ProjectContextRecord[] = [...snapshot.files, ...snapshot.blocked];
  const exact = records.find((record) => record.id === input || record.path === input);
  if (exact) return { status: 'found', file: describeRecord(exact, includeParameters) };
  const normalized = input.toLowerCase();
  const matches = records.filter((record) => recordSearchText(record).includes(normalized));
  if (matches.length === 1) return { status: 'found', file: describeRecord(matches[0]!, includeParameters) };
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      input,
      candidates: matches.slice(0, 8).map((record) => describeRecord(record, false)),
    };
  }
  return { status: 'missing_lookup', usage: `Unknown project context file ${input}. Use context action:"files" to inspect loaded and blocked files.` };
}
