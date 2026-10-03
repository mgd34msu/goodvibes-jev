/**
 * Agent-local memory domain handler (memory honesty).
 *
 * Split out of agent-local-registry-tool.ts to stay under the 800-line
 * architecture cap. Owns the `memory` domain of the agent_local_registry
 * tool: list/search/get/create/update/review/stale/delete.
 *
 * The `search` action defaults to semantic recall (registry.searchSemantic)
 * instead of the old literal LIKE-scan default, natural-language recall must
 * not depend on the query text appearing as a literal substring in the
 * stored summary/detail. Index health is checked before every semantic
 * search so an unavailable index degrades honestly (stated reason, literal
 * fallback) instead of silently returning zero matches that read as "nothing
 * was ever stored."
 *
 * MEMORY-SPINE WIRING (SDK 1.2.0 full-detach catalog). Every action below now
 * routes through `memorySpine`, local by default, or over the wire the moment
 * the agent has adopted a daemon (see services.ts's memorySpineClient).
 * get/create/review/stale/delete and the literal `search` path use the five
 * 1.1.0 core verbs (get/add/updateReview/updateReview/delete/honestSearch);
 * `list` and `update` use the 1.2.0 extended verbs of the same name
 * (list/update); the SEMANTIC search path uses the 1.2.0 `searchSemantic`
 * extended verb. Only the index-health check (`registry.vectorStats()`) stays
 * on the raw local `registry`, vector-index diagnostics are maintenance a
 * store performs on its OWN index, so reporting them honestly means reading
 * this process's own index, not a wire-forwarded view of the daemon's (see the
 * CLI's identical ruling in memory-command-wire.ts). That is a deliberate,
 * stated scope limit, not an oversight.
 */
import {
  HASHED_MEMORY_EMBEDDING_PROVIDER,
  MemoryRegistry,
  type MemoryClass,
  type MemoryRecord,
  type MemoryScope,
  type MemorySemanticSearchResult,
  type MemoryVectorStats,
} from '@goodvibes-jev/engine/sdk/platform/state';
import type { MemoryAccess } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
import { assertNoSecretLikeMemoryText } from '../agent/memory-safety.ts';
import { formatAgentRecordReference, formatAgentRecordReviewState } from '../agent/record-labels.ts';
import {
  AGENT_TOOL_PROVENANCE,
  type AgentLocalRegistryToolArgs,
  readOptionalConfidence,
  readString,
  readStringList,
  requireConfirmedDelete,
  requireId,
  requireSummary,
} from './agent-local-registry-args.ts';
// `import type` is erased at compile time, so this does not create a runtime
// circular dependency even though agent-local-registry-tool.ts imports
// handleMemory (below) from this module.
import type { AgentLocalRegistryAction } from './agent-local-registry-tool.ts';

export const MEMORY_CLASSES: readonly MemoryClass[] = ['decision', 'constraint', 'incident', 'pattern', 'fact', 'risk', 'runbook', 'architecture', 'ownership'];
export const MEMORY_SCOPES: readonly MemoryScope[] = ['session', 'project', 'team'];

function isMemoryClass(value: unknown): value is MemoryClass {
  return typeof value === 'string' && MEMORY_CLASSES.includes(value as MemoryClass);
}

function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === 'string' && MEMORY_SCOPES.includes(value as MemoryScope);
}

function requireMemoryClass(args: AgentLocalRegistryToolArgs): MemoryClass {
  const cls = args.cls || 'fact';
  if (!isMemoryClass(cls)) throw new Error(`Invalid memory class. Valid values ${MEMORY_CLASSES.join(', ')}.`);
  return cls;
}

function readMemoryScope(args: AgentLocalRegistryToolArgs): MemoryScope {
  const scope = args.scope || 'project';
  if (!isMemoryScope(scope)) throw new Error(`Invalid memory scope. Valid values ${MEMORY_SCOPES.join(', ')}.`);
  return scope;
}

export function formatMemory(record: MemoryRecord): string {
  const tags = record.tags.length > 0 ? ` tags ${record.tags.join(', ')}` : '';
  return `${record.id}  ${record.scope}/${record.cls}  ${formatAgentRecordReviewState(record.reviewState)}  ${record.confidence}%${tags}  ${record.summary}`;
}

function formatMemoryMatch(entry: MemorySemanticSearchResult): string {
  const matchLabel = entry.similarity > 0 ? `  match ${Math.round(entry.similarity * 100)}% (score ${Math.round(entry.score)})` : '';
  return `${formatMemory(entry.record)}${matchLabel}`;
}

/**
 * A HARD unavailable reason: the semantic index cannot be consulted at all, so the
 * search action must fall back to a literal LIKE-scan and say so, never a silent
 * empty result that reads as "no memory matches" when the index was never asked.
 */
function describeMemoryIndexUnavailable(stats: MemoryVectorStats): string | null {
  if (!stats.enabled) return 'the semantic memory index is disabled for this store';
  if (!stats.available) return `the semantic memory index is unavailable${stats.error ? `: ${stats.error}` : ''}`;
  if (stats.indexedRecords === 0) return 'the semantic memory index has no indexed records yet';
  return null;
}

/**
 * A SOFT caveat: the index is up and consulted, but it is running on the built-in
 * hashed-only fallback embedding provider (bag-of-words/token hashing) rather than a
 * real embedding model. That still ranks real matches meaningfully better than a
 * literal substring scan, but it is not a modeled semantic understanding, say so
 * rather than presenting it as equivalent to a configured semantic provider.
 */
function describeMemoryIndexCaveat(stats: MemoryVectorStats): string | null {
  if (stats.embeddingProviderId === HASHED_MEMORY_EMBEDDING_PROVIDER.id) {
    return 'running on the hashed-only fallback embedding provider (no dedicated semantic model configured), ranking is approximate, not modeled semantic understanding';
  }
  return null;
}

function renderMemorySearch(mode: string, query: string, lines: readonly string[]): string {
  if (lines.length === 0) {
    return `Agent-local memory search (${mode})\nNo Agent-local memory records matched "${query}".`;
  }
  return [`Agent-local memory search (${mode})`, `query ${query || '(all)'}`, ...lines].join('\n');
}

export async function handleMemory(
  registry: MemoryRegistry,
  memorySpine: MemoryAccess,
  action: AgentLocalRegistryAction,
  args: AgentLocalRegistryToolArgs,
): Promise<string> {
  if (action === 'list') {
    // list() is a 1.2.0 extended verb, routes through the spine (no filter =
    // getAll semantics, matching the previous registry.getAll() call exactly).
    const records = await memorySpine.list();
    return records.length === 0
      ? 'Agent-local memory\nNo Agent-local memory records.'
      : ['Agent-local memory', ...records.map(formatMemory)].join('\n');
  }
  if (action === 'search') {
    const query = readString(args.query);
    const wantsLiteral = args.semantic === false;
    if (wantsLiteral) {
      // Literal search IS wire-covered, routes through the spine (honestSearch
      // with no `semantic` flag is exactly a literal scan; see
      // runHonestMemorySearch in the SDK).
      const { records } = await memorySpine.honestSearch({ query, limit: 10 });
      return renderMemorySearch('literal, explicitly requested', query, records.map(formatMemory));
    }
    // SEMANTIC BY DEFAULT: natural-language recall must not depend on the query text
    // appearing as a literal substring in the stored summary/detail. Check index
    // health FIRST so an unavailable index degrades honestly instead of silently
    // returning zero matches that read as "nothing was ever stored." The health
    // check itself stays on the raw local registry (vector-index diagnostics are
    // this process's own, see the file-header note); the actual search, once the
    // index is known healthy, is the 1.2.0 searchSemantic extended verb and
    // routes through the spine.
    const stats = registry.vectorStats();
    const unavailable = describeMemoryIndexUnavailable(stats);
    if (unavailable) {
      const records = await registry.search({ query, limit: 10 });
      return renderMemorySearch(`literal fallback, ${unavailable}`, query, records.map(formatMemory));
    }
    const results = await memorySpine.searchSemantic({ query, limit: 10 });
    const consultedSemanticIndex = query.length > 0 && results.some((entry) => entry.similarity > 0);
    const caveat = describeMemoryIndexCaveat(stats);
    const mode = !consultedSemanticIndex && query.length > 0
      ? 'semantic, no vector match for this query, ranked by stored confidence instead'
      : caveat
        ? `semantic, ${caveat}`
        : 'semantic';
    return renderMemorySearch(mode, query, results.map(formatMemoryMatch));
  }
  if (action === 'get') {
    const record = await memorySpine.get(requireId(args));
    if (!record) return `Unknown Agent-local memory ${readString(args.id)}`;
    return [
      formatMemory(record),
      `created ${new Date(record.createdAt).toISOString()}`,
      `updated ${new Date(record.updatedAt).toISOString()}`,
      `origin ${record.provenance.map((entry) => formatAgentRecordReference({ kind: String(entry.kind), ref: String(entry.ref) })).join(', ') || '(none)'}`,
      `provenance: ${record.provenance.map((entry) => `${String(entry.kind)}:${String(entry.ref)}`).join(',') || '(none)'}`,
      '',
      record.detail || '(no detail)',
    ].join('\n');
  }
  if (action === 'create') {
    const summary = requireSummary(args);
    const detail = readString(args.detail || args.body);
    const tags = readStringList(args.tags);
    const confidence = readOptionalConfidence(args.confidence);
    assertNoSecretLikeMemoryText([summary, detail, ...tags]);
    const record = await memorySpine.add({
      scope: readMemoryScope(args),
      cls: requireMemoryClass(args),
      summary,
      detail,
      tags: [...tags],
      ...(confidence === undefined ? {} : { review: { state: 'fresh' as const, confidence } }),
      provenance: [{ kind: 'event', ref: readString(args.provenance) || AGENT_TOOL_PROVENANCE }],
    });
    return [
      'Created Agent-local memory',
      `  id ${record.id}`,
      `  summary ${record.summary}`,
    ].join('\n');
  }
  if (action === 'update') {
    // update() is a 1.2.0 extended verb (summary/detail/tags/scope patch), routes
    // through the spine.
    const summary = readString(args.summary || args.description);
    const detail = readString(args.detail || args.body);
    const tags = args.tags === undefined ? undefined : [...readStringList(args.tags)];
    assertNoSecretLikeMemoryText([summary, detail, ...(tags ?? [])]);
    const record = await memorySpine.update(requireId(args), {
      summary: summary || undefined,
      detail: detail || undefined,
      tags,
      scope: args.scope === undefined ? undefined : readMemoryScope(args),
    });
    if (!record) return `Unknown Agent-local memory ${readString(args.id)}`;
    return [
      'Updated Agent-local memory',
      `  id ${record.id}`,
      `  summary ${record.summary}`,
    ].join('\n');
  }
  if (action === 'review') {
    const record = await memorySpine.updateReview(requireId(args), {
      state: 'reviewed',
      confidence: readOptionalConfidence(args.confidence),
      reviewedBy: 'agent',
    });
    if (!record) return `Unknown Agent-local memory ${readString(args.id)}`;
    return [
      'Reviewed Agent-local memory',
      `  id ${record.id}`,
    ].join('\n');
  }
  if (action === 'stale') {
    const record = await memorySpine.updateReview(requireId(args), {
      state: 'stale',
      staleReason: readString(args.reason) || 'Marked stale by Agent.',
    });
    if (!record) return `Unknown Agent-local memory ${readString(args.id)}`;
    return [
      'Marked Agent-local memory stale',
      `  id ${record.id}`,
    ].join('\n');
  }
  if (action === 'delete') {
    const id = requireId(args);
    requireConfirmedDelete(args, 'Agent-local memory');
    if (!(await memorySpine.delete(id))) return `Unknown Agent-local memory ${id}`;
    return [
      'Deleted Agent-local memory',
      `  id ${id}`,
    ].join('\n');
  }
  throw new Error(`Action ${action} is not valid for memory.`);
}
