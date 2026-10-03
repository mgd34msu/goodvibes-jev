/**
 * memory-command-wire.ts
 *
 * Split out of memory-command.ts to stay under the 800-line architecture cap.
 * Owns the CLI's wire-first path onto the memory spine (SDK 1.2.0 full-detach
 * catalog), see the CLI ruling below for why this exists and what it
 * deliberately still does NOT cover.
 */
import type { MemoryReviewState } from '@goodvibes-jev/engine/sdk/platform/state';
import type { LocalMemoryStore, MemoryAccess } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
import { MemorySpineClient, createLocalMemoryAccess } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
import { assertNoSecretLikeMemoryText } from '../agent/memory-safety.ts';
import { formatAgentRecordReviewState } from '../agent/record-labels.ts';
import { createSpineConnectionResolver } from '../runtime/session-spine-rest-transport.ts';
import { createSessionSpineRestProbe as createSpineRestProbe } from '@goodvibes-jev/engine/sdk/platform/runtime/session-spine';
import { createMemorySpineRestTransport } from '../runtime/memory-spine-rest-transport.ts';
import type { CliCommandOutput } from './types.ts';
import type { CliCommandRuntime } from './management.ts';
import {
  VALID_REVIEW_STATES,
  csvOption,
  failure,
  filterFromOptions,
  hasFlag,
  isReviewState,
  optionValue,
  optionalScope,
  parseConfidence,
  parseOptions,
  provenanceFromOptions,
  readBundle,
  renderRecord,
  renderRecordList,
  requireClass,
  requireScope,
  resolvePath,
  success,
  writeBundle,
  type MemoryListData,
  type MemorySearchData,
} from './memory-command.ts';

/**
 * CLI RULING (memory-spine adoption, SDK 1.2.0 full-detach catalog).
 *
 * The CLI is a one-shot process invoked by `goodvibes-agent memory ...` with no
 * lasting daemon context, it doesn't get to sit through a boot-time reachability
 * probe like the interactive runtime does. But the daemon's canonical store is
 * single-writer: if a daemon IS running and owns that store, this process opening
 * the same sqlite file underneath it and calling `store.save()` at the end (see
 * `withMemory` in memory-command.ts, unconditional in its `finally`) would race the
 * daemon's own writes and silently drop whichever side saved last. Staying
 * "local-direct always" would be safe ONLY if no daemon could ever be running
 * concurrently, which is not true for this product (Connected Host is the normal
 * mode, not the exception).
 *
 * So the honest resolution: for every subcommand that has a wire-covered
 * equivalent on `MemoryAccess` (the five 1.1.0 core verbs plus the 1.2.0 extended
 * verbs list/update/link/linksFor/searchSemantic/exportBundle/importBundle, see
 * memory-spine-rest-transport.ts), the CLI probes for a reachable daemon FIRST and,
 * when one answers, runs the ENTIRE command over the wire and never opens the local
 * store file at all. Only when the probe finds no daemon does it fall back to the
 * existing direct-local path.
 *
 * 1.2.0 closes most of the prior gap: `show` (get + linksFor), `link`, `export`,
 * `import`, and the `search --semantic`/`--vector` path, plus `promote` (which is
 * not a distinct wire verb, it is `update({ scope })`, per the SDK's full-detach
 * ruling) now all run over the wire when a daemon is adopted.
 *
 * A real, stated gap remains: `queue` (reviewQueue) and `vector` (vectorStats /
 * doctor / rebuild) have no route on this CLI's wire transport by deliberate
 * choice, vector-index diagnostics are maintenance a store performs on its OWN
 * index, so they stay local-direct honestly rather than reporting a daemon's index
 * health as if it were this process's own. Those two subcommands still run
 * local-direct even while a daemon is adopted; that is a known, named scope limit,
 * not a silent oversight.
 */
const WIRE_STORE_LABEL = 'wire:connected-daemon';
const CLI_PROBE_TIMEOUT_MS = 800;

const WIRE_ELIGIBLE_SUBCOMMANDS = new Set([
  'list', 'ls',
  'add', 'create',
  'show', 'get',
  'review',
  'stale',
  'contradict', 'contradicted',
  'promote',
  'link',
  'delete', 'remove', 'rm',
  'export', 'handoff-export', 'share',
  'import', 'handoff-import',
]);

/** `search`/`find` covers both the literal path (honestSearch) and, since 1.2.0, the `--semantic`/`--vector` path (searchSemantic), both are wire-covered verbs. */
function isWireEligibleMemorySubcommand(normalized: string): boolean {
  return WIRE_ELIGIBLE_SUBCOMMANDS.has(normalized) || normalized === 'search' || normalized === 'find';
}

/**
 * A `LocalMemoryStore` stub that must never actually run. `MemorySpineClient`
 * routes EVERY op to the transport once constructed with one attached (mode is
 * 'client' immediately, see the SDK's one-writer enforcement ruling in
 * client.ts), so this stub exists only to satisfy the constructor's required
 * `local` argument without opening the CLI's own copy of the store file, the
 * exact single-writer race the whole wire-first path exists to avoid. A call
 * that somehow reached it would be a bug in that routing guarantee, so it fails
 * loudly rather than silently reading/writing a file this process must not touch.
 */
function neverReachedLocalMemoryStore(): LocalMemoryStore {
  const unreachable = (): never => {
    throw new Error('memory spine: CLI wire mode reached the local store stub, this must never happen while a transport is attached.');
  };
  return {
    add: unreachable,
    honestSearch: unreachable,
    get: unreachable,
    review: unreachable,
    delete: unreachable,
    search: unreachable,
    searchSemantic: unreachable,
    update: unreachable,
    link: unreachable,
    linksFor: unreachable,
    reviewQueue: unreachable,
    exportBundle: unreachable,
    importBundle: unreachable,
    vectorStats: unreachable,
    doctor: unreachable,
  };
}

/** Probes for a reachable connected daemon and, only when one answers, returns the wire MemoryAccess. Returns null (never throws) so the caller can fall back to local. */
async function resolveWireMemoryAccess(runtime: CliCommandRuntime): Promise<MemoryAccess | null> {
  const resolveConnection = createSpineConnectionResolver(runtime.configManager, runtime.homeDirectory);
  const probe = createSpineRestProbe({ resolveConnection, probeTimeoutMs: CLI_PROBE_TIMEOUT_MS });
  const reachable = await probe();
  if (!reachable) return null;
  const transport = createMemorySpineRestTransport({ resolveConnection });
  // MemorySpineClient (not the raw transport) is the MemoryAccess: the raw
  // REST transport's type permits missing extended verbs (MemoryTransport =
  // MemoryCoreAccess & Partial<MemoryExtendedAccess>) even though this specific
  // transport implements every one the CLI calls; routing through the client
  // gets full MemoryAccess typing plus its honest-rejection behavior for any
  // verb a future older daemon doesn't support.
  return new MemorySpineClient({ local: createLocalMemoryAccess(neverReachedLocalMemoryStore()), transport });
}

async function handleListWire(runtime: CliCommandRuntime, memorySpine: MemoryAccess, args: readonly string[]): Promise<CliCommandOutput> {
  const options = parseOptions(args);
  const positionalClass = options.positionals[0];
  const filter = filterFromOptions(options, 50);
  if (positionalClass !== undefined) filter.cls = requireClass(positionalClass);
  const { records } = await memorySpine.honestSearch(filter);
  const data: MemoryListData = { path: WIRE_STORE_LABEL, records, filter };
  return success(runtime, 'agent.memory.list', data, renderRecordList('Agent memory', WIRE_STORE_LABEL, records));
}

async function handleSearchWire(runtime: CliCommandRuntime, memorySpine: MemoryAccess, args: readonly string[]): Promise<CliCommandOutput> {
  const options = parseOptions(args);
  const query = options.positionals.join(' ').trim();
  if (!query) return failure(runtime, 'invalid_memory_command', 'Usage: goodvibes-agent memory search <query> [--semantic] [--cls <class>] [--scope <scope>] [--limit <n>]', 2);
  const filter = filterFromOptions(options, 20);
  filter.query = query;
  const semantic = hasFlag(options, 'semantic') || hasFlag(options, 'vector');
  if (semantic) filter.semantic = true;
  if (semantic) {
    // 1.2.0: searchSemantic is a wire-covered extended verb (memory.records.search-semantic).
    const semanticResults = await memorySpine.searchSemantic(filter);
    const records = semanticResults.map((entry) => entry.record);
    const data: MemorySearchData = { path: WIRE_STORE_LABEL, records, filter, semantic: true, semanticResults };
    return success(runtime, 'agent.memory.search', data, renderRecordList(`Agent memory matching "${query}"`, WIRE_STORE_LABEL, records, semanticResults));
  }
  const { records } = await memorySpine.honestSearch(filter);
  const data: MemorySearchData = { path: WIRE_STORE_LABEL, records, filter, semantic: false, semanticResults: [] };
  return success(runtime, 'agent.memory.search', data, renderRecordList(`Agent memory matching "${query}"`, WIRE_STORE_LABEL, records));
}

async function handleShowWire(runtime: CliCommandRuntime, memorySpine: MemoryAccess, args: readonly string[]): Promise<CliCommandOutput> {
  const id = args[0];
  if (!id) return failure(runtime, 'invalid_memory_command', 'Usage: goodvibes-agent memory show <id>', 2);
  const record = await memorySpine.get(id);
  if (!record) return failure(runtime, 'memory_not_found', `Memory record not found ${id}`, 1);
  const links = await memorySpine.linksFor(id);
  return success(runtime, 'agent.memory.show', { record, links }, renderRecord(record, links));
}

async function handlePromoteWire(runtime: CliCommandRuntime, memorySpine: MemoryAccess, args: readonly string[]): Promise<CliCommandOutput> {
  const options = parseOptions(args);
  const [id, scopeRaw] = options.positionals;
  if (!id || !scopeRaw) return failure(runtime, 'invalid_memory_command', 'Usage: goodvibes-agent memory promote <id> <session|project|team> --yes', 2);
  if (!hasFlag(options, 'yes')) return failure(runtime, 'confirmation_required', `Refusing to promote memory record ${id} without --yes.`, 2);
  // "Promote" is not a distinct wire verb, it is a scope edit, per the SDK's
  // full-detach ruling (a scope promotion is update({ scope })).
  //
  // `update` now returns null ONLY for a genuine record-miss (a
  // MEMORY_RECORD_NOT_FOUND 404); a daemon that does not serve the update verb
  // (an older daemon, a route-not-found 404) makes it THROW an honest
  // "verb unavailable" error that surfaces via handleMemoryCommand's errorOutput,
  // it is no longer folded to null here and mislabelled as "record not found".
  const record = await memorySpine.update(id, { scope: requireScope(scopeRaw) });
  if (!record) return failure(runtime, 'memory_not_found', `Memory record not found ${id}`, 1);
  return success(runtime, 'agent.memory.promote', record, [
    'Agent memory promoted',
    `  id ${record.id}`,
    `  scope ${record.scope}`,
  ].join('\n'));
}

async function handleLinkWire(runtime: CliCommandRuntime, memorySpine: MemoryAccess, args: readonly string[]): Promise<CliCommandOutput> {
  const options = parseOptions(args);
  const [fromId, toId, relation] = options.positionals;
  if (!fromId || !toId || !relation) return failure(runtime, 'invalid_memory_command', 'Usage: goodvibes-agent memory link <fromId> <toId> <relation> --yes', 2);
  if (!hasFlag(options, 'yes')) return failure(runtime, 'confirmation_required', `Refusing to link memory records ${fromId} and ${toId} without --yes.`, 2);
  const link = await memorySpine.link(fromId, toId, relation);
  if (!link) return failure(runtime, 'memory_link_failed', 'Memory link failed; check that both records exist.', 1);
  return success(runtime, 'agent.memory.link', link, [
    'Agent memory linked',
    `  from ${fromId}`,
    `  to ${toId}`,
    `  relation ${relation}`,
  ].join('\n'));
}

async function handleExportWire(runtime: CliCommandRuntime, memorySpine: MemoryAccess, args: readonly string[]): Promise<CliCommandOutput> {
  const options = parseOptions(args);
  const pathArg = options.positionals[0];
  if (!pathArg) return failure(runtime, 'invalid_memory_command', 'Usage: goodvibes-agent memory export <path> [--scope <scope>] [--cls <class>] --yes', 2);
  if (!hasFlag(options, 'yes')) return failure(runtime, 'confirmation_required', `Refusing to export Agent memory bundle to ${pathArg} without --yes.`, 2);
  const filter = filterFromOptions(options, 200);
  const path = resolvePath(runtime, pathArg);
  const bundle = await memorySpine.exportBundle(filter);
  writeBundle(path, bundle);
  return success(runtime, 'agent.memory.export', { path, bundle }, [
    'Agent memory exported',
    `  records ${bundle.recordCount}`,
    `  links ${bundle.linkCount}`,
    `  path ${path}`,
  ].join('\n'));
}

async function handleImportWire(runtime: CliCommandRuntime, memorySpine: MemoryAccess, args: readonly string[]): Promise<CliCommandOutput> {
  const options = parseOptions(args);
  const pathArg = options.positionals[0];
  if (!pathArg) return failure(runtime, 'invalid_memory_command', 'Usage: goodvibes-agent memory import <path> --yes', 2);
  if (!hasFlag(options, 'yes')) return failure(runtime, 'confirmation_required', `Refusing to import Agent memory bundle from ${pathArg} without --yes.`, 2);
  const path = resolvePath(runtime, pathArg);
  const bundle = readBundle(path);
  const result = await memorySpine.importBundle(bundle);
  return success(runtime, 'agent.memory.import', { path, result }, [
    `Agent memory imported: ${result.importedRecords} record${result.importedRecords === 1 ? '' : 's'}`,
    `  records: ${result.importedRecords}`,
    `  links: ${result.importedLinks}`,
    `  skipped: ${result.skippedRecords}`,
  ].join('\n'));
}

async function handleAddWire(runtime: CliCommandRuntime, memorySpine: MemoryAccess, args: readonly string[]): Promise<CliCommandOutput> {
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
  const record = await memorySpine.add({
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

async function handleReviewWire(runtime: CliCommandRuntime, memorySpine: MemoryAccess, args: readonly string[]): Promise<CliCommandOutput> {
  const options = parseOptions(args);
  const [id, stateRaw] = options.positionals;
  if (!id || !stateRaw || !isReviewState(stateRaw)) {
    return failure(runtime, 'invalid_memory_command', `Usage: goodvibes-agent memory review <id> <${VALID_REVIEW_STATES.join('|')}> [--confidence <0-100>]`, 2);
  }
  const record = await memorySpine.updateReview(id, {
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

async function handleReviewShortcutWire(
  runtime: CliCommandRuntime,
  memorySpine: MemoryAccess,
  state: Extract<MemoryReviewState, 'stale' | 'contradicted'>,
  args: readonly string[],
): Promise<CliCommandOutput> {
  const [id, ...reasonParts] = args;
  if (!id || reasonParts.length === 0) {
    return failure(runtime, 'invalid_memory_command', `Usage: goodvibes-agent memory ${state === 'stale' ? 'stale' : 'contradict'} <id> <reason>`, 2);
  }
  const record = await memorySpine.updateReview(id, {
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

async function handleDeleteWire(runtime: CliCommandRuntime, memorySpine: MemoryAccess, args: readonly string[]): Promise<CliCommandOutput> {
  const options = parseOptions(args);
  const id = options.positionals[0];
  if (!id) return failure(runtime, 'invalid_memory_command', 'Usage: goodvibes-agent memory delete <id> --yes', 2);
  if (!hasFlag(options, 'yes')) return failure(runtime, 'confirmation_required', `Refusing to delete memory record ${id} without --yes.`, 2);
  if (!(await memorySpine.delete(id))) return failure(runtime, 'memory_not_found', `Memory record not found ${id}`, 1);
  return success(runtime, 'agent.memory.delete', { id }, [
    `Agent memory deleted: ${id}`,
    `  id ${id}`,
  ].join('\n'));
}

/**
 * Runs a wire-eligible subcommand over the memory spine when a daemon is reachable.
 * Returns null (never a failure output) when the subcommand has no wire path, or
 * when the probe finds no daemon, either way the caller falls through to the
 * existing local-direct path unchanged. Once a wire call is actually in flight, a
 * failure surfaces honestly (thrown, caught by handleMemoryCommand's try/catch),
 * it never silently retries against the local file after starting a wire attempt.
 */
export async function tryWireMemoryCommand(
  runtime: CliCommandRuntime,
  normalized: string,
  rest: readonly string[],
): Promise<CliCommandOutput | null> {
  if (!isWireEligibleMemorySubcommand(normalized)) return null;
  const memorySpine = await resolveWireMemoryAccess(runtime);
  if (!memorySpine) return null;
  if (normalized === 'list' || normalized === 'ls') return handleListWire(runtime, memorySpine, rest);
  if (normalized === 'search' || normalized === 'find') return handleSearchWire(runtime, memorySpine, rest);
  if (normalized === 'add' || normalized === 'create') return handleAddWire(runtime, memorySpine, rest);
  if (normalized === 'show' || normalized === 'get') return handleShowWire(runtime, memorySpine, rest);
  if (normalized === 'review') return handleReviewWire(runtime, memorySpine, rest);
  if (normalized === 'stale') return handleReviewShortcutWire(runtime, memorySpine, 'stale', rest);
  if (normalized === 'contradict' || normalized === 'contradicted') return handleReviewShortcutWire(runtime, memorySpine, 'contradicted', rest);
  if (normalized === 'promote') return handlePromoteWire(runtime, memorySpine, rest);
  if (normalized === 'link') return handleLinkWire(runtime, memorySpine, rest);
  if (normalized === 'delete' || normalized === 'remove' || normalized === 'rm') return handleDeleteWire(runtime, memorySpine, rest);
  if (normalized === 'export' || normalized === 'handoff-export' || normalized === 'share') return handleExportWire(runtime, memorySpine, rest);
  if (normalized === 'import' || normalized === 'handoff-import') return handleImportWire(runtime, memorySpine, rest);
  return null;
}
