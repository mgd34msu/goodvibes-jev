import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  MemoryEmbeddingProviderRegistry,
  MemoryRegistry,
  MemoryStore,
  resolveCanonicalMemoryDbPath,
  type MemoryBundle,
  type MemoryClass,
  type MemoryLink,
  type MemoryRecord,
  type MemoryReviewState,
  type MemoryScope,
  type MemorySearchFilter,
  type MemorySemanticSearchResult,
  type ProvenanceLink,
  type ProvenanceLinkKind,
} from '@goodvibes-jev/engine/sdk/platform/state';
import { assertNoSecretLikeMemoryText } from '../agent/memory-safety.ts';
import { formatAgentRecordReference, formatAgentRecordReviewState } from '../agent/record-labels.ts';
import type { CliCommandOutput } from './types.ts';
import type { CliCommandRuntime } from './management.ts';
// Split out to stay under the architecture line cap; see its file header for the
// CLI ruling on when a memory subcommand goes over the wire vs local-direct.
import { tryWireMemoryCommand } from './memory-command-wire.ts';
import { appendTemporalLabel } from './temporal-label.ts';

const VALID_CLASSES: readonly MemoryClass[] = ['decision', 'constraint', 'incident', 'pattern', 'fact', 'risk', 'runbook', 'architecture', 'ownership'];
const VALID_SCOPES: readonly MemoryScope[] = ['session', 'project', 'team'];
export const VALID_REVIEW_STATES: readonly MemoryReviewState[] = ['fresh', 'reviewed', 'stale', 'contradicted'];
const VALID_PROVENANCE_KINDS: readonly ProvenanceLinkKind[] = ['session', 'turn', 'task', 'event', 'file'];
const VALUE_OPTIONS = new Set([
  'by',
  'cls',
  'confidence',
  'detail',
  'file',
  'label',
  'limit',
  'reason',
  'review-state',
  'scope',
  'session',
  'tags',
  'task',
  'turn',
]);
interface CommandSuccess<TData> {
  readonly ok: true;
  readonly kind: string;
  readonly data: TData;
}

interface CommandFailure {
  readonly ok: false;
  readonly kind: string;
  readonly error: string;
}

export interface ParsedOptions {
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
  readonly positionals: readonly string[];
}

interface MemoryContext {
  readonly registry: MemoryRegistry;
  readonly store: MemoryStore;
  readonly path: string;
}

export interface MemoryListData {
  readonly path: string;
  readonly records: readonly MemoryRecord[];
  readonly filter: MemorySearchFilter;
}

export interface MemorySearchData extends MemoryListData {
  readonly semantic: boolean;
  readonly semanticResults: readonly MemorySemanticSearchResult[];
}

function jsonOrText(runtime: CliCommandRuntime, value: unknown, text: string): string {
  return runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(value, null, 2) : text;
}

export function success<TData>(runtime: CliCommandRuntime, kind: string, data: TData, text: string): CliCommandOutput {
  const value: CommandSuccess<TData> = { ok: true, kind, data };
  return { output: jsonOrText(runtime, value, text), exitCode: 0 };
}

export function failure(runtime: CliCommandRuntime, kind: string, error: string, exitCode: number): CliCommandOutput {
  const value: CommandFailure = { ok: false, kind, error };
  return {
    output: runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(value, null, 2) : error,
    exitCode,
  };
}

export function parseOptions(args: readonly string[]): ParsedOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const equalIndex = arg.indexOf('=');
    const rawName = equalIndex >= 0 ? arg.slice(2, equalIndex) : arg.slice(2);
    const name = rawName.trim();
    if (!name) continue;
    if (equalIndex >= 0) {
      values.set(name, arg.slice(equalIndex + 1));
      continue;
    }
    if (VALUE_OPTIONS.has(name)) {
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        values.set(name, next);
        index += 1;
        continue;
      }
    }
    flags.add(name);
  }
  return { values, flags, positionals };
}

export function optionValue(options: ParsedOptions, name: string): string | undefined {
  const value = options.values.get(name);
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function hasFlag(options: ParsedOptions, name: string): boolean {
  return options.flags.has(name);
}

export function csvOption(options: ParsedOptions, name: string): readonly string[] | undefined {
  const value = optionValue(options, name);
  if (value === undefined) return undefined;
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function parseLimit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('--limit must be a positive integer.');
  return Math.min(parsed, 200);
}

export function parseConfidence(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) throw new Error('--confidence must be an integer from 0 to 100.');
  return parsed;
}

function isMemoryClass(value: string): value is MemoryClass {
  return VALID_CLASSES.includes(value as MemoryClass);
}

function isMemoryScope(value: string): value is MemoryScope {
  return VALID_SCOPES.includes(value as MemoryScope);
}

export function isReviewState(value: string): value is MemoryReviewState {
  return VALID_REVIEW_STATES.includes(value as MemoryReviewState);
}

function isProvenanceKind(value: string): value is ProvenanceLinkKind {
  return VALID_PROVENANCE_KINDS.includes(value as ProvenanceLinkKind);
}

export function requireClass(value: string | undefined): MemoryClass {
  if (!value || !isMemoryClass(value)) throw new Error(`Invalid memory class "${value ?? ''}". Valid values ${VALID_CLASSES.join(', ')}`);
  return value;
}

export function requireScope(value: string | undefined): MemoryScope {
  if (!value || !isMemoryScope(value)) throw new Error(`Invalid memory scope "${value ?? ''}". Valid values ${VALID_SCOPES.join(', ')}`);
  return value;
}

export function optionalScope(value: string | undefined): MemoryScope | undefined {
  if (value === undefined) return undefined;
  return requireScope(value);
}

function optionalClass(value: string | undefined): MemoryClass | undefined {
  if (value === undefined) return undefined;
  return requireClass(value);
}

function timestamp(value: number): string {
  return new Date(value).toISOString().slice(0, 19).replace('T', ' ');
}

// The CLI no longer opens a private per-surface agent/memory.sqlite. It opens the
// ONE canonical cross-surface store (~/.goodvibes/shared/memory.sqlite) so a memory
// added via `goodvibes-agent memory add` is visible to the runtime, the TUI, and the
// SDK, and vice-versa. The old CLI-written store is folded into the canonical store
// (loss-free, idempotent) by the runtime's foldAgentLegacyMemory at boot, since that
// fold already sources shellPaths.resolveUserPath('agent', 'memory.sqlite'), the exact
// path this function used to write to.
function memoryDbPath(runtime: CliCommandRuntime): string {
  return resolveCanonicalMemoryDbPath(runtime.homeDirectory);
}

async function withMemory<T>(runtime: CliCommandRuntime, fn: (context: MemoryContext) => Promise<T> | T): Promise<T> {
  const path = memoryDbPath(runtime);
  const embeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager: runtime.configManager });
  const store = new MemoryStore(path, { embeddingRegistry });
  await store.init();
  const registry = new MemoryRegistry(store);
  try {
    return await fn({ registry, store, path });
  } finally {
    await store.save();
    store.close();
  }
}

function renderRecordLine(record: MemoryRecord, semanticEntry?: MemorySemanticSearchResult): string {
  const tags = record.tags.length > 0 ? `  tags ${record.tags.join(', ')}` : '';
  const score = semanticEntry ? `  similarity ${Math.round(semanticEntry.similarity * 100)}%` : '';
  return `  ${record.id}  ${record.scope}/${record.cls}  ${formatAgentRecordReviewState(record.reviewState)}  ${record.confidence}%${score}${tags}  ${record.summary}`;
}

export function renderRecordList(title: string, path: string, records: readonly MemoryRecord[], semanticResults: readonly MemorySemanticSearchResult[] = []): string {
  if (records.length === 0) {
    return [
      title,
      `  store ${path}`,
      '  No Agent memory records found.',
      '  Add one with: goodvibes-agent memory add fact "Useful durable fact" --scope project',
    ].join('\n');
  }
  return [
    `${title} (${records.length})`,
    `  store ${path}`,
    ...records.map((record) => renderRecordLine(record, semanticResults.find((entry) => entry.record.id === record.id))),
  ].join('\n');
}

export function renderRecord(record: MemoryRecord, links: readonly MemoryLink[]): string {
  return [
    `Memory ${record.id}`,
    `  scope: ${record.scope}`,
    `  class: ${record.cls}`,
    `  review: ${formatAgentRecordReviewState(record.reviewState)}`,
    `  confidence: ${record.confidence}`,
    `  tags: ${record.tags.join(', ') || '(none)'}`,
    `  created: ${appendTemporalLabel(timestamp(record.createdAt), record.createdAt)}`,
    `  updated: ${appendTemporalLabel(timestamp(record.updatedAt), record.updatedAt)}`,
    record.reviewedAt ? `  reviewed: ${appendTemporalLabel(timestamp(record.reviewedAt), record.reviewedAt)}${record.reviewedBy ? ` by ${record.reviewedBy}` : ''}` : '',
    record.staleReason ? `  stale reason: ${record.staleReason}` : '',
    '',
    record.summary,
    record.detail ? `\n${record.detail}` : '',
    record.provenance.length > 0 ? '\nProvenance' : '',
    ...record.provenance.map((entry) => `  ${formatAgentRecordReference(entry)}`),
    links.length > 0 ? '\nLinks' : '',
    ...links.map((link) => `  ${link.fromId} -> ${link.toId} [${link.relation}]`),
  ].filter((line): line is string => Boolean(line)).join('\n');
}

export function filterFromOptions(options: ParsedOptions, defaultLimit: number): MemorySearchFilter {
  const filter: MemorySearchFilter = {
    limit: parseLimit(optionValue(options, 'limit'), defaultLimit),
  };
  const scope = optionalScope(optionValue(options, 'scope'));
  const cls = optionalClass(optionValue(options, 'cls'));
  const tags = csvOption(options, 'tags');
  if (scope !== undefined) filter.scope = scope;
  if (cls !== undefined) filter.cls = cls;
  if (tags !== undefined) filter.tags = [...tags];
  return filter;
}

function addProvenance(provenance: ProvenanceLink[], kind: ProvenanceLinkKind, ref: string | undefined): void {
  if (ref !== undefined && ref.trim().length > 0) provenance.push({ kind, ref: ref.trim() });
}

export function provenanceFromOptions(options: ParsedOptions): readonly ProvenanceLink[] {
  const provenance: ProvenanceLink[] = [];
  addProvenance(provenance, 'session', optionValue(options, 'session'));
  addProvenance(provenance, 'turn', optionValue(options, 'turn'));
  addProvenance(provenance, 'task', optionValue(options, 'task'));
  addProvenance(provenance, 'file', optionValue(options, 'file'));
  if (provenance.length === 0) provenance.push({ kind: 'event', ref: 'Command' });
  return provenance;
}

function usage(): string {
  return [
    'Usage: goodvibes-agent memory <subcommand>',
    '  list [class] [--scope <session|project|team>] [--limit <n>]',
    '  search <query> [--semantic] [--cls <class>] [--scope <scope>] [--limit <n>]',
    '  add <class> <summary> [--scope <scope>] [--detail <text>] [--tags a,b] [--confidence <0-100>]',
    '  show <id>',
    '  queue [limit]',
    '  review <id> <fresh|reviewed|stale|contradicted> [--confidence <0-100>] [--by <name>] [--reason <text>]',
    '  stale <id> <reason>',
    '  contradict <id> <reason>',
    '  promote <id> <session|project|team> --yes',
    '  link <fromId> <toId> <relation> --yes',
    '  delete <id> --yes',
    '  export <path> [--scope <scope>] [--cls <class>] --yes',
    '  import <path> --yes',
    '  handoff-inspect <path>',
    '  vector [status|doctor|rebuild]',
    '',
    'Agent memory is local to GoodVibes Agent and never falls back to default knowledge or non-Agent knowledge segments.',
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isProvenanceLink(value: unknown): value is ProvenanceLink {
  if (!isRecord(value)) return false;
  return typeof value.ref === 'string' && typeof value.kind === 'string' && isProvenanceKind(value.kind);
}

function isMemoryRecord(value: unknown): value is MemoryRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string'
    && typeof value.scope === 'string'
    && isMemoryScope(value.scope)
    && typeof value.cls === 'string'
    && isMemoryClass(value.cls)
    && typeof value.summary === 'string'
    && (value.detail === undefined || typeof value.detail === 'string')
    && isStringArray(value.tags)
    && Array.isArray(value.provenance)
    && value.provenance.every(isProvenanceLink)
    && typeof value.reviewState === 'string'
    && isReviewState(value.reviewState)
    && typeof value.confidence === 'number'
    && typeof value.createdAt === 'number'
    && typeof value.updatedAt === 'number'
  );
}

function isMemoryLink(value: unknown): value is MemoryLink {
  if (!isRecord(value)) return false;
  return typeof value.fromId === 'string'
    && typeof value.toId === 'string'
    && typeof value.relation === 'string'
    && typeof value.createdAt === 'number';
}

function isMemoryBundle(value: unknown): value is MemoryBundle {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 'v1'
    && typeof value.exportedAt === 'number'
    && (value.scope === 'all' || (typeof value.scope === 'string' && isMemoryScope(value.scope)))
    && typeof value.recordCount === 'number'
    && typeof value.linkCount === 'number'
    && Array.isArray(value.records)
    && value.records.every(isMemoryRecord)
    && Array.isArray(value.links)
    && value.links.every(isMemoryLink);
}

export function readBundle(path: string): MemoryBundle {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  if (!isMemoryBundle(parsed)) throw new Error('Invalid Agent memory bundle.');
  for (const record of parsed.records) {
    assertNoSecretLikeMemoryText([
      record.summary,
      record.detail ?? '',
      ...record.tags,
      ...record.provenance.map((entry) => `${entry.kind}:${entry.ref} ${entry.label ?? ''}`),
    ]);
  }
  return parsed;
}

export function resolvePath(runtime: CliCommandRuntime, path: string): string {
  return resolve(runtime.workingDirectory, path);
}

export function writeBundle(path: string, bundle: MemoryBundle): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`);
}

function renderBundleInspection(path: string, bundle: MemoryBundle): string {
  return [
    'Agent memory handoff bundle',
    `  path ${path}`,
    `  scope ${bundle.scope}`,
    `  records ${bundle.recordCount}`,
    `  links ${bundle.linkCount}`,
    ...bundle.records.slice(0, 20).map((record) => `  ${record.id} ${record.scope}/${record.cls} ${formatAgentRecordReviewState(record.reviewState)} ${record.summary}`),
    bundle.records.length > 20 ? `  ... ${bundle.records.length - 20} more` : '',
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function errorOutput(runtime: CliCommandRuntime, error: unknown): CliCommandOutput {
  const message = error instanceof Error ? error.message : String(error);
  const exitCode = message.startsWith('Usage:') || message.startsWith('Invalid ') || message.startsWith('--') ? 2 : 1;
  return failure(runtime, 'agent.memory.error', message, exitCode);
}

async function handleList(runtime: CliCommandRuntime, context: MemoryContext, args: readonly string[]): Promise<CliCommandOutput> {
  const options = parseOptions(args);
  const positionalClass = options.positionals[0];
  const filter = filterFromOptions(options, 50);
  if (positionalClass !== undefined) filter.cls = requireClass(positionalClass);
  const records = await context.registry.search(filter);
  const data: MemoryListData = { path: context.path, records, filter };
  return success(runtime, 'agent.memory.list', data, renderRecordList('Agent memory', context.path, records));
}

async function handleSearch(runtime: CliCommandRuntime, context: MemoryContext, args: readonly string[]): Promise<CliCommandOutput> {
  const options = parseOptions(args);
  const query = options.positionals.join(' ').trim();
  if (!query) return failure(runtime, 'invalid_memory_command', 'Usage: goodvibes-agent memory search <query> [--semantic] [--cls <class>] [--scope <scope>] [--limit <n>]', 2);
  const filter = filterFromOptions(options, 20);
  filter.query = query;
  const semantic = hasFlag(options, 'semantic') || hasFlag(options, 'vector');
  if (semantic) filter.semantic = true;
  const semanticResults = semantic ? await context.registry.searchSemantic(filter) : [];
  const records = semantic ? semanticResults.map((entry) => entry.record) : await context.registry.search(filter);
  const data: MemorySearchData = { path: context.path, records, filter, semantic, semanticResults };
  return success(runtime, 'agent.memory.search', data, renderRecordList(`Agent memory matching "${query}"`, context.path, records, semanticResults));
}

async function handleAdd(runtime: CliCommandRuntime, context: MemoryContext, args: readonly string[]): Promise<CliCommandOutput> {
  const options = parseOptions(args);
  const [classRaw, ...summaryParts] = options.positionals;
  const cls = requireClass(classRaw);
  const summary = summaryParts.join(' ').trim();
  if (!summary) return failure(runtime, 'invalid_memory_command', 'Usage: goodvibes-agent memory add <class> <summary> [--scope <scope>] [--detail <text>] [--tags a,b]', 2);
  const detail = optionValue(options, 'detail');
  const tags = csvOption(options, 'tags');
  assertNoSecretLikeMemoryText([summary, detail ?? '', ...(tags ?? [])]);
  const reviewState = optionValue(options, 'review-state');
  if (reviewState !== undefined && !isReviewState(reviewState)) {
    return failure(runtime, 'invalid_memory_command', `Invalid review state "${reviewState}". Valid values ${VALID_REVIEW_STATES.join(', ')}`, 2);
  }
  const record = await context.registry.add({
    scope: optionalScope(optionValue(options, 'scope')) ?? 'project',
    cls,
    summary,
    detail,
    tags: tags === undefined ? undefined : [...tags],
    provenance: [...provenanceFromOptions(options)],
    review: {
      state: reviewState,
      confidence: parseConfidence(optionValue(options, 'confidence')),
      reviewedBy: optionValue(options, 'by'),
    },
  });
  return success(runtime, 'agent.memory.add', record, [
    'Agent memory added',
    `  id ${record.id}`,
  ].join('\n'));
}

async function handleShow(runtime: CliCommandRuntime, context: MemoryContext, args: readonly string[]): Promise<CliCommandOutput> {
  const id = args[0];
  if (!id) return failure(runtime, 'invalid_memory_command', 'Usage: goodvibes-agent memory show <id>', 2);
  const record = context.registry.get(id);
  if (!record) return failure(runtime, 'memory_not_found', `Memory record not found ${id}`, 1);
  return success(runtime, 'agent.memory.show', { record, links: context.registry.linksFor(id) }, renderRecord(record, context.registry.linksFor(id)));
}

async function handleQueue(runtime: CliCommandRuntime, context: MemoryContext, args: readonly string[]): Promise<CliCommandOutput> {
  const limit = parseLimit(args[0], 10);
  const records = await context.registry.reviewQueue(limit);
  return success(runtime, 'agent.memory.queue', { path: context.path, records, limit }, renderRecordList('Agent memory review queue', context.path, records));
}

async function handleReview(runtime: CliCommandRuntime, context: MemoryContext, args: readonly string[]): Promise<CliCommandOutput> {
  const options = parseOptions(args);
  const [id, stateRaw] = options.positionals;
  if (!id || !stateRaw || !isReviewState(stateRaw)) {
    return failure(runtime, 'invalid_memory_command', `Usage: goodvibes-agent memory review <id> <${VALID_REVIEW_STATES.join('|')}> [--confidence <0-100>]`, 2);
  }
  const record = context.registry.review(id, {
    state: stateRaw,
    confidence: parseConfidence(optionValue(options, 'confidence')),
    reviewedBy: optionValue(options, 'by') ?? 'operator',
    staleReason: optionValue(options, 'reason'),
  });
  if (!record) return failure(runtime, 'memory_not_found', `Memory record not found ${id}`, 1);
  return success(runtime, 'agent.memory.review', record, [
    'Agent memory reviewed',
    `  id ${record.id}`,
    `  review ${formatAgentRecordReviewState(record.reviewState)}`,
    `  confidence ${record.confidence}%`,
  ].join('\n'));
}

async function handleReviewShortcut(runtime: CliCommandRuntime, context: MemoryContext, state: Extract<MemoryReviewState, 'stale' | 'contradicted'>, args: readonly string[]): Promise<CliCommandOutput> {
  const [id, ...reasonParts] = args;
  if (!id || reasonParts.length === 0) {
    return failure(runtime, 'invalid_memory_command', `Usage: goodvibes-agent memory ${state === 'stale' ? 'stale' : 'contradict'} <id> <reason>`, 2);
  }
  const record = context.registry.review(id, {
    state,
    reviewedBy: 'operator',
    staleReason: reasonParts.join(' '),
  });
  if (!record) return failure(runtime, 'memory_not_found', `Memory record not found ${id}`, 1);
  return success(runtime, `agent.memory.${state}`, record, [
    `Agent memory marked ${state}`,
    `  id ${record.id}`,
  ].join('\n'));
}

async function handlePromote(runtime: CliCommandRuntime, context: MemoryContext, args: readonly string[]): Promise<CliCommandOutput> {
  const options = parseOptions(args);
  const [id, scopeRaw] = options.positionals;
  if (!id || !scopeRaw) return failure(runtime, 'invalid_memory_command', 'Usage: goodvibes-agent memory promote <id> <session|project|team> --yes', 2);
  if (!hasFlag(options, 'yes')) return failure(runtime, 'confirmation_required', `Refusing to promote memory record ${id} without --yes.`, 2);
  const record = context.registry.update(id, { scope: requireScope(scopeRaw) });
  if (!record) return failure(runtime, 'memory_not_found', `Memory record not found ${id}`, 1);
  return success(runtime, 'agent.memory.promote', record, [
    'Agent memory promoted',
    `  id ${record.id}`,
    `  scope ${record.scope}`,
  ].join('\n'));
}

async function handleLink(runtime: CliCommandRuntime, context: MemoryContext, args: readonly string[]): Promise<CliCommandOutput> {
  const options = parseOptions(args);
  const [fromId, toId, relation] = options.positionals;
  if (!fromId || !toId || !relation) return failure(runtime, 'invalid_memory_command', 'Usage: goodvibes-agent memory link <fromId> <toId> <relation> --yes', 2);
  if (!hasFlag(options, 'yes')) return failure(runtime, 'confirmation_required', `Refusing to link memory records ${fromId} and ${toId} without --yes.`, 2);
  const link = await context.registry.link(fromId, toId, relation);
  if (!link) return failure(runtime, 'memory_link_failed', 'Memory link failed; check that both records exist.', 1);
  return success(runtime, 'agent.memory.link', link, [
    'Agent memory linked',
    `  from ${fromId}`,
    `  to ${toId}`,
    `  relation ${relation}`,
  ].join('\n'));
}

async function handleDelete(runtime: CliCommandRuntime, context: MemoryContext, args: readonly string[]): Promise<CliCommandOutput> {
  const options = parseOptions(args);
  const id = options.positionals[0];
  if (!id) return failure(runtime, 'invalid_memory_command', 'Usage: goodvibes-agent memory delete <id> --yes', 2);
  if (!hasFlag(options, 'yes')) return failure(runtime, 'confirmation_required', `Refusing to delete memory record ${id} without --yes.`, 2);
  if (!context.registry.delete(id)) return failure(runtime, 'memory_not_found', `Memory record not found ${id}`, 1);
  return success(runtime, 'agent.memory.delete', { id }, [
    `Agent memory deleted: ${id}`,
    `  id ${id}`,
  ].join('\n'));
}

async function handleExport(runtime: CliCommandRuntime, context: MemoryContext, args: readonly string[]): Promise<CliCommandOutput> {
  const options = parseOptions(args);
  const pathArg = options.positionals[0];
  if (!pathArg) return failure(runtime, 'invalid_memory_command', 'Usage: goodvibes-agent memory export <path> [--scope <scope>] [--cls <class>] --yes', 2);
  if (!hasFlag(options, 'yes')) return failure(runtime, 'confirmation_required', `Refusing to export Agent memory bundle to ${pathArg} without --yes.`, 2);
  const filter = filterFromOptions(options, 200);
  const path = resolvePath(runtime, pathArg);
  const bundle = context.registry.exportBundle(filter);
  writeBundle(path, bundle);
  return success(runtime, 'agent.memory.export', { path, bundle }, [
    'Agent memory exported',
    `  records ${bundle.recordCount}`,
    `  links ${bundle.linkCount}`,
    `  path ${path}`,
  ].join('\n'));
}

async function handleImport(runtime: CliCommandRuntime, context: MemoryContext, args: readonly string[]): Promise<CliCommandOutput> {
  const options = parseOptions(args);
  const pathArg = options.positionals[0];
  if (!pathArg) return failure(runtime, 'invalid_memory_command', 'Usage: goodvibes-agent memory import <path> --yes', 2);
  if (!hasFlag(options, 'yes')) return failure(runtime, 'confirmation_required', `Refusing to import Agent memory bundle from ${pathArg} without --yes.`, 2);
  const path = resolvePath(runtime, pathArg);
  const bundle = readBundle(path);
  const result = await context.registry.importBundle(bundle);
  return success(runtime, 'agent.memory.import', { path, result }, [
    `Agent memory imported: ${result.importedRecords} record${result.importedRecords === 1 ? '' : 's'}`,
    `  records: ${result.importedRecords}`,
    `  links: ${result.importedLinks}`,
    `  skipped: ${result.skippedRecords}`,
  ].join('\n'));
}

async function handleInspect(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const pathArg = args[0];
  if (!pathArg) return failure(runtime, 'invalid_memory_command', 'Usage: goodvibes-agent memory handoff-inspect <path>', 2);
  const path = resolvePath(runtime, pathArg);
  const bundle = readBundle(path);
  return success(runtime, 'agent.memory.handoffInspect', { path, bundle }, renderBundleInspection(path, bundle));
}

async function handleVector(runtime: CliCommandRuntime, context: MemoryContext, args: readonly string[]): Promise<CliCommandOutput> {
  const sub = (args[0] ?? 'status').toLowerCase();
  if (sub === 'status') {
    const stats = context.registry.vectorStats();
    return success(runtime, 'agent.memory.vector.status', stats, [
      'Agent memory vector index',
      `  backend: ${stats.backend}`,
      `  enabled: ${stats.enabled ? 'yes' : 'no'}`,
      `  available: ${stats.available ? 'yes' : 'no'}`,
      `  dimensions: ${stats.dimensions}`,
      `  indexed records: ${stats.indexedRecords}`,
      ...(stats.path ? [`  path: ${stats.path}`] : []),
      ...(stats.error ? [`  error: ${stats.error}`] : []),
    ].join('\n'));
  }
  if (sub === 'doctor') {
    const report = await context.registry.doctor();
    return success(runtime, 'agent.memory.vector.doctor', report, [
      'Agent memory vector doctor',
      `  vector backend: ${report.vector.backend}`,
      `  vector available: ${report.vector.available ? 'yes' : 'no'}`,
      `  indexed records: ${report.vector.indexedRecords}`,
      `  active embedding provider: ${report.embeddings.activeProviderId || '(none)'}`,
      `  embedding providers: ${report.embeddings.providers.length}`,
      ...report.embeddings.warnings.map((warning) => `  warning: ${warning}`),
    ].join('\n'));
  }
  if (sub === 'rebuild') {
    const stats = await context.registry.rebuildVectorsAsync();
    return success(runtime, 'agent.memory.vector.rebuild', stats, [
      'Agent memory vector rebuild complete',
      `  backend: ${stats.backend}`,
      `  indexed records: ${stats.indexedRecords}`,
      ...(stats.error ? [`  error: ${stats.error}`] : []),
    ].join('\n'));
  }
  return failure(runtime, 'invalid_memory_command', 'Usage: goodvibes-agent memory vector [status|doctor|rebuild]', 2);
}

export async function handleMemoryCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  try {
    const [sub = 'list', ...rest] = runtime.cli.commandArgs;
    const normalized = sub.toLowerCase();
    if (normalized === 'handoff-inspect' || normalized === 'inspect') return handleInspect(runtime, rest);
    // Wire-first: try the memory spine when a daemon is reachable and the
    // subcommand has a wire-covered equivalent, see the CLI ruling in
    // memory-command-wire.ts. Falls through (null) to the unchanged local-direct
    // path below for everything else, or when no daemon answers.
    const wireResult = await tryWireMemoryCommand(runtime, normalized, rest);
    if (wireResult) return wireResult;
    return await withMemory(runtime, async (context) => {
      if (normalized === 'list' || normalized === 'ls') return handleList(runtime, context, rest);
      if (normalized === 'search' || normalized === 'find') return handleSearch(runtime, context, rest);
      if (normalized === 'add' || normalized === 'create') return handleAdd(runtime, context, rest);
      if (normalized === 'show' || normalized === 'get') return handleShow(runtime, context, rest);
      if (normalized === 'queue') return handleQueue(runtime, context, rest);
      if (normalized === 'review') return handleReview(runtime, context, rest);
      if (normalized === 'stale') return handleReviewShortcut(runtime, context, 'stale', rest);
      if (normalized === 'contradict' || normalized === 'contradicted') return handleReviewShortcut(runtime, context, 'contradicted', rest);
      if (normalized === 'promote') return handlePromote(runtime, context, rest);
      if (normalized === 'link') return handleLink(runtime, context, rest);
      if (normalized === 'delete' || normalized === 'remove' || normalized === 'rm') return handleDelete(runtime, context, rest);
      if (normalized === 'export' || normalized === 'handoff-export' || normalized === 'share') return handleExport(runtime, context, rest);
      if (normalized === 'import' || normalized === 'handoff-import') return handleImport(runtime, context, rest);
      if (normalized === 'vector' || normalized === 'vectors') return handleVector(runtime, context, rest);
      return failure(runtime, 'invalid_memory_command', usage(), 2);
    });
  } catch (error) {
    return errorOutput(runtime, error);
  }
}
