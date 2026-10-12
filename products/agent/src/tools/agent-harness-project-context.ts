import { lstatSync, statSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogMethods, captureCatalogSnapshot, rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { captureCatalogReadRequest, selectHarnessCatalog } from './agent-harness-catalog-selection.ts';
import { withModelReadingSource } from './agent-harness-model-reading-source.ts';
import type { CommandContext } from '../input/command-registry.ts';
type ProjectCatalogContext = { readonly workspace: Pick<CommandContext['workspace'], 'shellPaths'> };
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

function snapshotForArgs(context: ProjectCatalogContext, args: AgentHarnessProjectContextArgs): AgentProjectContextSnapshot | null {
  const shellPaths = context.workspace.shellPaths;
  if (!shellPaths) return null;
  const targetPath = readString(args.target);
  return discoverProjectContextFiles(shellPaths, targetPath ? { targetPath } : {});
}

function projectPathFacts(path: string) {
  try {
    const entry = lstatSync(path), target = statSync(path);
    return { path, realPath: realpathSync(path), entry: { dev: entry.dev, ino: entry.ino, mode: entry.mode,
      ...(entry.isDirectory() ? {} : { size: entry.size, mtime: entry.mtimeMs, ctime: entry.ctimeMs }) }, target: { dev: target.dev, ino: target.ino,
      mode: target.mode, ...(target.isDirectory() ? {} : { size: target.size, mtime: target.mtimeMs, ctime: target.ctimeMs }) } };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { path, absent: true };
    throw new ToolInputProjectionError('held');
  }
}

function captureProjectContext(context: ProjectCatalogContext, args: AgentHarnessProjectContextArgs, options: CatalogRankingOptions) {
  const request = captureCatalogReadRequest(args, options);
  const assertContext = captureCatalogMethods(context, ['workspace']);
  const workspace = context.workspace;
  const assertWorkspace = captureCatalogMethods(workspace, ['shellPaths']);
  const shellPaths = workspace.shellPaths;
  if (!shellPaths) { request.retain(() => { assertContext(); assertWorkspace(); }, 'read-catalog.project.owner');
    return { request, snapshot: null }; }
  const assertPaths = captureCatalogMethods(shellPaths, ['workingDirectory', 'homeDirectory', 'projectGoodVibesRoot', 'userGoodVibesRoot',
    'expandHomePath', 'resolveWorkspacePath']);
  const assertOwner = () => {
    assertContext(); assertWorkspace(); assertPaths();
    if (context.workspace !== workspace || workspace.shellPaths !== shellPaths) throw new ToolInputProjectionError('held');
  };
  // The first walk enumerates native read paths; the second acquires content
  // only after the original physical owners have been retained.
  const plan = snapshotForArgs(context, request.input);
  if (!plan) throw new ToolInputProjectionError('held');
  const planSnapshot = captureCatalogSnapshot(plan);
  const paths = new Set<string>();
  for (const entry of plan.searchedPaths) {
    let path = resolve(entry);
    while (!paths.has(path)) { paths.add(path); const parent = dirname(path); if (parent === path) break; path = parent; }
  }
  const original = [...paths].map(path => ({ path, snapshot: captureCatalogSnapshot(projectPathFacts(path)) }));
  const assertPhysical = () => { assertOwner(); for (const entry of original) entry.snapshot.assertCurrent(projectPathFacts(entry.path)); assertOwner(); };
  assertPhysical();
  const native = snapshotForArgs(context, request.input);
  if (!native) throw new ToolInputProjectionError('held');
  planSnapshot.assertCurrent(native);
  const snapshot = captureCatalogSnapshot(native);
  assertPhysical();
  // Every original owner and record is captured before retain invokes any
  // caller restriction. A changed first callback cannot become the baseline.
  request.retain(assertPhysical, 'read-catalog.project.physical');
  request.retain(() => { assertOwner(); snapshot.assertCurrent(snapshotForArgs(context, request.input)); assertOwner(); }, 'read-catalog.project.records');
  return { request, snapshot: snapshot.captured };
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

export function projectContextCatalogStatus(context: ProjectCatalogContext): Record<string, unknown> {
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

export async function projectContextSummary(context: ProjectCatalogContext, args: AgentHarnessProjectContextArgs,
  options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const { request, snapshot } = captureProjectContext(context, args, options);
  const includeParameters = request.input.includeParameters === true;
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
  return withModelReadingSource({ invocation: request.input, snapshot }, request.options, async (captured, current) => {
    const query = readString(captured.invocation.query);
    const selected = query ? await rankHarnessCatalog(records, query,
      record => ({ id: record.id, description: `Project context ${record.source}`, evidence: record }), 'agent.project-context.search',
      { ...current, requirePreservedSource: true }) : { matches: records.map(entry => ({ entry })), judgments: [] };
    current.assertCurrent?.();
    const filtered = selected.matches.map(({ entry }) => entry);
    return {
      status: snapshot.blocked.length > 0 ? 'attention' : snapshot.files.length > 0 ? 'ready' : 'needs-setup',
      files: filtered.map((record) => describeRecord(record, includeParameters)),
      returned: filtered.length,
      ...(query ? { judgments: selected.judgments } : {}),
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
  });
}

export async function describeProjectContextFile(context: ProjectCatalogContext, args: AgentHarnessProjectContextArgs,
  options: CatalogRankingOptions = {}): Promise<ProjectContextFileResolution> {
  const { request, snapshot } = captureProjectContext(context, args, options);
  const input = readString(request.input.contextFileId || request.input.target || request.input.query);
  if (!input) return { status: 'missing_lookup', usage: 'context action:"file" requires contextFileId, target, or query. Use context action:"files" to inspect available context files.' };
  if (!snapshot) return { status: 'missing_lookup', usage: 'Project context discovery requires workspace shell paths.' };
  return withModelReadingSource({ invocation: request.input, snapshot }, request.options, async (captured, current): Promise<ProjectContextFileResolution> => {
    const includeParameters = captured.invocation.includeParameters !== false;
    const records: readonly ProjectContextRecord[] = [...captured.snapshot.files, ...captured.snapshot.blocked];
    const exact = records.find(record => record.id === input || record.path === input);
    const selected = exact ?? await selectHarnessCatalog(records, input,
      record => ({ id: record.id, description: `Project context ${record.source}`, evidence: record }), current, 'agent.project-context.select');
    current.assertCurrent?.();
    if (selected) return { status: 'found', file: describeRecord(selected, includeParameters) };
    return { status: 'missing_lookup', usage: `No project context file was selected for ${input}. Use context action:"files" to inspect loaded and blocked files.` };
  });
}
