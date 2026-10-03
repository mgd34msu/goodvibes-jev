import { createHash } from 'node:crypto';
import type { LedgerWork, WorkReportedState } from './types.js';

/** Preparation only. This module has no store, host client, actor or command executor. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordValue = { [key: string]: Json };
export interface LegacyMigrationInput {
  /** Opaque selected-host binding supplied by composition, never a filesystem path. */
  readonly hostId: string;
  readonly projectId: string;
  readonly expectedLedgerRevision: number;
  readonly pendingLocalChanges: boolean;
  /** Complete persisted source images and host-issued complete-source generations. */
  readonly sources: readonly { readonly source: unknown; readonly generation: string }[];
  readonly occupiedWorkIds: readonly string[];
}
export interface LegacyMigrationEntity {
  readonly kind: 'work' | 'question' | 'decision' | 'artifact';
  readonly id: string;
  /** Each source-qualified representation is retained; one shape cannot overwrite another. */
  readonly fragments: readonly { readonly sourceId: string; readonly pointer: string; readonly original: RecordValue }[];
  readonly reportedState?: WorkReportedState;
  readonly verification: 'unverified';
}
export interface LegacyMigrationLink {
  readonly sourceId: string;
  readonly pointer: string;
  readonly from: string;
  readonly relation: string;
  readonly to: string;
}
export interface LegacyMigrationManifest {
  readonly version: 1;
  readonly hostId: string;
  readonly projectId: string;
  readonly expectedLedgerRevision: number;
  /** Stable preparation identity; NOT a receipt, permission or import request. */
  readonly digest: string;
  readonly sources: readonly { readonly source: RecordValue; readonly generation: string; readonly digest: string }[];
  readonly entities: readonly LegacyMigrationEntity[];
  readonly links: readonly LegacyMigrationLink[];
  readonly executionAuthority: 'none';
  readonly persistence: 'not-imported';
}
export type LegacyMigrationPreparation =
  | { readonly kind: 'prepared'; readonly manifest: LegacyMigrationManifest }
  | { readonly kind: 'blocked'; readonly code: 'cancelled' | 'pending-local-changes' | 'invalid-source' | 'limit' | 'identity-conflict' | 'target-conflict' | 'stale-preparation'; readonly reason: string };
type BlockCode = Extract<LegacyMigrationPreparation, { kind: 'blocked' }>['code'];
class PreparationError extends Error {
  constructor(readonly code: BlockCode, message: string) { super(message); }
}
export const LEGACY_IMPORT_MAX_BYTES = 262_144;
const MAX_BYTES = LEGACY_IMPORT_MAX_BYTES;
const MAX_SOURCES = 500;
const MAX_ENTITIES = 5_000;
const MAX_LINKS = 20_000;
function fail(code: BlockCode, reason: string): never { throw new PreparationError(code, reason); }
function object(value: Json | undefined, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-source', `${label} must be an object.`);
  return value;
}
function id(value: Json | undefined, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) fail('invalid-source', `${label} must be a nonempty ID of at most 200 characters.`);
  return value;
}
function array(value: Json | undefined, label: string): Json[] {
  if (!Array.isArray(value)) fail('invalid-source', `${label} must be an array.`);
  return value;
}
/** Reject lossy JSON (undefined, bigint, getters, sparse arrays, cycles, nonfinite numbers). */
function capture(value: unknown): Json {
  let bytes = 0;
  const active = new Set<object>();
  function visit(input: unknown, depth: number): Json {
    if (depth > 32) fail('limit', 'Source nesting exceeds 32 levels.');
    let result: Json;
    if (input === null || typeof input === 'boolean') result = input;
    else if (typeof input === 'string') result = input;
    else if (typeof input === 'number' && Number.isFinite(input) && !Object.is(input, -0)) result = input;
    else if (typeof input === 'object' && input !== null) {
      if (active.has(input)) fail('invalid-source', 'Cyclic source data cannot be preserved.');
      const proto: unknown = Object.getPrototypeOf(input);
      if (proto !== Object.prototype && proto !== null && proto !== Array.prototype) fail('invalid-source', 'Only plain JSON source records are accepted.');
      active.add(input);
      const descriptors = Object.getOwnPropertyDescriptors(input);
      if (Object.getOwnPropertySymbols(input).length) fail('invalid-source', 'Symbol fields cannot be preserved.');
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!('value' in descriptor) || (!descriptor.enumerable && !(Array.isArray(input) && key === 'length'))) fail('invalid-source', 'Non-JSON source properties cannot be preserved.');
      }
      if (Array.isArray(input)) {
        if (input.length > MAX_LINKS || Object.keys(input).length !== input.length) fail('limit', 'Sparse, extended or oversized source array.');
        result = Array.from({ length: input.length }, (_, index) => visit(descriptors[String(index)]?.value, depth + 1));
      } else {
        result = Object.create(null) as RecordValue;
        for (const key of Object.keys(descriptors).sort()) {
          bytes += Buffer.byteLength(JSON.stringify(key));
          result[key] = visit(descriptors[key]?.value, depth + 1);
        }
      }
      active.delete(input);
      bytes += 2 + Object.keys(input).length;
      if (bytes > MAX_BYTES) fail('limit', 'Source bundle exceeds the preparation byte limit.');
      return result;
    } else return fail('invalid-source', 'Source contains a value that JSON cannot preserve.');
    bytes += Buffer.byteLength(JSON.stringify(result));
    if (bytes > MAX_BYTES) fail('limit', 'Source bundle exceeds the preparation byte limit.');
    return result;
  }
  return visit(value, 0);
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function reported(status: Json | undefined, planning: boolean): WorkReportedState {
  switch (status) {
    case undefined: if (planning) return 'pending'; break;
    case 'pending': return 'pending';
    case 'deferred': if (planning) return 'pending'; break;
    case 'in-progress': if (planning) return 'in_progress'; break;
    case 'in_progress': if (!planning) return 'in_progress'; break;
    case 'blocked': return 'blocked';
    case 'failed': if (!planning) return 'blocked'; break;
    case 'completed': if (planning) return 'complete'; break;
    case 'done': if (!planning) return 'complete'; break;
    case 'cancelled': if (!planning) return 'cancelled'; break;
  }
  return fail('invalid-source', 'Unknown legacy task status; explicit reconciliation is required.');
}

export function prepareLegacyWorkLedgerMigration(input: LegacyMigrationInput, signal?: AbortSignal): LegacyMigrationPreparation {
  try {
    if (signal?.aborted) fail('cancelled', 'Preparation cancelled; no source or ledger was changed.');
    if (input.pendingLocalChanges !== false) fail('pending-local-changes', 'Save or discard local edits explicitly before capturing persisted sources.');
    const hostId = id(input.hostId, 'hostId'); const projectId = id(input.projectId, 'projectId');
    if (!Number.isSafeInteger(input.expectedLedgerRevision) || input.expectedLedgerRevision < 0) fail('invalid-source', 'Invalid target ledger revision.');
    if (!Array.isArray(input.sources) || input.sources.length === 0 || input.sources.length > MAX_SOURCES) fail('limit', 'Capture between 1 and 500 complete sources.');
    const captured = array(capture(input.sources), 'sources');
    const occupied = new Set(input.occupiedWorkIds.map(value => id(value, 'occupiedWorkId')));
    const sources = new Map<string, { source: RecordValue; generation: string; digest: string }>();
    for (const item of captured) {
      const entry = object(item, 'source capture'); const source = object(entry.source, 'source');
      const sourceId = id(source.id, 'source.id');
      if (typeof entry.generation !== 'string' || !/^[a-f0-9]{64}$/.test(entry.generation)) fail('invalid-source', 'Missing complete-source generation.');
      const digest = hash(source); const previous = sources.get(sourceId);
      if (previous && (previous.digest !== digest || previous.generation !== entry.generation)) fail('identity-conflict', `Conflicting images of source ${sourceId}.`);
      sources.set(sourceId, { source, generation: entry.generation, digest });
    }
    const entities = new Map<string, LegacyMigrationEntity>(); const links: LegacyMigrationLink[] = [];
    function add(kind: LegacyMigrationEntity['kind'], entityId: string, original: RecordValue, sourceId: string, pointer: string, state?: WorkReportedState): void {
      const key = JSON.stringify([kind, entityId]); const previous = entities.get(key);
      if (kind === 'work' && occupied.has(entityId)) fail('target-conflict', `Native work ID ${entityId} already exists; an authenticated import receipt is required to reconcile it.`);
      if (previous) {
        for (const fragment of previous.fragments) {
          if (kind === 'work') {
            // state.tasks and work-plan.tasks have different valid schemas. Only explicit
            // shared title/status claims conflict; absent fields do not choose a winner.
            if (String(fragment.original.title).trim() !== String(original.title).trim()) fail('identity-conflict', `Conflicting legacy work title for ${entityId}.`);
            if (fragment.original.status !== undefined && original.status !== undefined
              && reported(fragment.original.status, fragment.original.taskId === undefined) !== state) fail('identity-conflict', `Conflicting legacy work status for ${entityId}.`);
          } else {
            const fields = kind === 'decision' ? ['title', 'decision', 'text', 'status'] : kind === 'question' ? ['prompt', 'answer', 'status'] : [];
            if (kind === 'artifact' && hash(fragment.original) !== hash(original)) fail('identity-conflict', `Conflicting legacy artifact ${entityId}.`);
            for (const field of fields) {
              if (fragment.original[field] !== undefined && original[field] !== undefined && hash(fragment.original[field]) !== hash(original[field])) {
                fail('identity-conflict', `Conflicting legacy ${kind} ${field} for ${entityId}; no winner was selected.`);
              }
            }
          }
        }
      }
      const fragments = [...(previous?.fragments ?? []), { sourceId, pointer, original }];
      // An omitted planning status makes no claim against an explicit work-plan status.
      const explicit = fragments.find(fragment => fragment.original.status !== undefined);
      const workState = kind === 'work' && explicit
        ? reported(explicit.original.status, explicit.original.taskId === undefined) : state;
      entities.set(key, { kind, id: entityId, fragments, ...(workState ? { reportedState: workState } : {}), verification: 'unverified' });
      if (entities.size > MAX_ENTITIES) fail('limit', 'Too many legacy entities.');
    }
    function link(sourceId: string, pointer: string, from: string, relation: string, to: Json | undefined): void {
      links.push({ sourceId, pointer, from, relation, to: id(to, relation) });
      if (links.length > MAX_LINKS) fail('limit', 'Too many legacy links.');
    }
    for (const [sourceId, entry] of [...sources].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const meta = object(entry.source.metadata, 'source.metadata');
      if (entry.source.connectorId !== 'goodvibes-project-planning' || meta.projectPlanning !== true || meta.projectId !== projectId) fail('invalid-source', `Source ${sourceId} is not planning data for the selected project.`);
      const space = id(meta.knowledgeSpaceId, 'knowledgeSpaceId');
      const artifactId = id(meta.planningArtifactId, 'planningArtifactId');
      const kind = meta.planningArtifactKind; const value = object(meta.value, 'metadata.value');
      if (!['state', 'work-plan', 'decision', 'language'].includes(String(kind))) fail('invalid-source', 'Unknown planning artifact kind.');
      if (kind !== 'language' && value.id !== artifactId) fail('identity-conflict', 'Artifact envelope and value IDs disagree.');
      if (kind !== 'decision' && (value.projectId !== projectId || value.knowledgeSpaceId !== space)) fail('invalid-source', 'Artifact project or knowledge space disagrees with source.');
      // Source ID is the globally unique artifact identity; preserve the legacy artifact ID in original.
      add('artifact', sourceId, value, sourceId, '/metadata/value');
      if (kind === 'decision') add('decision', artifactId, value, sourceId, '/metadata/value');
      if (kind === 'state') {
        for (const field of ['openQuestions', 'answeredQuestions', 'decisions'] as const) {
          array(value[field], field).forEach((item, index) => {
            const record = object(item, field); add(field === 'decisions' ? 'decision' : 'question', id(record.id, field), record, sourceId, `/metadata/value/${field}/${index}`);
          });
        }
        array(value.dependencies, 'dependencies').forEach((item, index) => {
          const dependency = object(item, 'dependency');
          link(sourceId, `/metadata/value/dependencies/${index}`, id(dependency.fromTaskId, 'fromTaskId'), 'dependency', dependency.toTaskId);
        });
      }
      if (kind === 'state' || kind === 'work-plan') {
        array(value.tasks, 'tasks').forEach((item, index) => {
          const task = object(item, 'task'); const taskId = id(kind === 'state' ? task.id : task.taskId, 'task ID');
          if (typeof task.title !== 'string' || !task.title.trim()) fail('invalid-source', 'A task title is missing.');
          if (kind === 'work-plan' && (task.projectId !== projectId || task.knowledgeSpaceId !== space)) fail('invalid-source', 'Task project or knowledge space disagrees with source.');
          const pointer = `/metadata/value/tasks/${index}`;
          if (task.metadata !== undefined) {
            const metadata = object(task.metadata, 'task.metadata');
            // Actual ProjectPlanningService projection preserves both its generated work
            // ID and the originating planning task identity, rather than merging them.
            if (metadata.planningTaskId !== undefined) link(sourceId, `${pointer}/metadata/planningTaskId`, taskId, 'planningTaskId', metadata.planningTaskId);
            if (metadata.planningId !== undefined) link(sourceId, `${pointer}/metadata/planningId`, taskId, 'planningId', metadata.planningId);
            if (metadata.dependencies !== undefined) array(metadata.dependencies, 'metadata.dependencies').forEach((to, i) => link(sourceId, `${pointer}/metadata/dependencies/${i}`, taskId, 'dependencies', to));
          }
          add('work', taskId, task, sourceId, pointer, reported(task.status, kind === 'state'));
          for (const field of ['parentTaskId', 'contractId', 'phaseId', 'agentId', 'turnId', 'decisionId', 'sourceMessageId'] as const) {
            if (task[field] !== undefined) link(sourceId, `${pointer}/${field}`, taskId, field, task[field]);
          }
          for (const field of ['dependencies', 'linkedArtifactIds', 'linkedSourceIds', 'linkedNodeIds'] as const) {
            if (task[field] !== undefined) array(task[field], field).forEach((to, i) => link(sourceId, `${pointer}/${field}/${i}`, taskId, field, to));
          }
        });
      }
    }
    if (signal?.aborted) fail('cancelled', 'Preparation cancelled; no source or ledger was changed.');
    const body = { version: 1 as const, hostId, projectId, expectedLedgerRevision: input.expectedLedgerRevision,
      sources: [...sources.values()].sort((a, b) => String(a.source.id) < String(b.source.id) ? -1 : String(a.source.id) > String(b.source.id) ? 1 : 0),
      entities: [...entities.values()], links, executionAuthority: 'none' as const, persistence: 'not-imported' as const };
    const manifest = freeze({ ...body, digest: hash(body) });
    if (Buffer.byteLength(JSON.stringify(manifest)) > LEGACY_IMPORT_MAX_BYTES - 1024) fail('limit', 'Complete manifest exceeds 256 KiB; nothing was truncated.');
    capture(manifest); // Check complete-envelope nesting, including retained fragments.
    // A prepared manifest must already be representable by the native work schema.
    projectLegacyImportWorks(manifest, 0);
    return { kind: 'prepared', manifest };
  } catch (error) {
    return { kind: 'blocked', code: error instanceof PreparationError ? error.code : 'invalid-source', reason: error instanceof PreparationError ? error.message : 'Malformed source capture; nothing was changed.' };
  }
}

/** Recompute from fresh captures. This proves repeatable preparation, never durable import. */
export function replayLegacyWorkLedgerPreparation(previous: LegacyMigrationManifest, fresh: LegacyMigrationInput, signal?: AbortSignal): LegacyMigrationPreparation {
  const next = prepareLegacyWorkLedgerMigration(fresh, signal);
  if (next.kind === 'blocked') return next;
  if (previous.digest !== next.manifest.digest) return { kind: 'blocked', code: 'stale-preparation', reason: 'Selected host, ledger revision or complete source images changed. Capture and review a new preparation.' };
  return next;
}

/** Server and product use identical deterministic preparation, never client assertions. */
export function validateLegacyWorkLedgerManifest(input: unknown): LegacyMigrationManifest {
  const value = object(capture(input), 'manifest');
  const prepared = prepareLegacyWorkLedgerMigration({
    hostId: value.hostId as string, projectId: value.projectId as string,
    expectedLedgerRevision: value.expectedLedgerRevision as number,
    pendingLocalChanges: false, sources: value.sources as unknown as LegacyMigrationInput['sources'], occupiedWorkIds: [],
  });
  if (prepared.kind !== 'prepared' || JSON.stringify(capture(prepared.manifest)) !== JSON.stringify(value)) {
    throw new Error('Manifest does not match canonical complete-source preparation');
  }
  if (Buffer.byteLength(JSON.stringify(prepared.manifest)) > LEGACY_IMPORT_MAX_BYTES) throw new Error('Manifest exceeds import limit');
  return prepared.manifest;
}


/** Deterministic native projection. All source claims remain available in fragments. */
export function projectLegacyImportWorks(manifest: LegacyMigrationManifest, at: number): LedgerWork[] {
  if (!Number.isSafeInteger(at) || at < 0) fail('invalid-source', 'Invalid host import timestamp.');
  return manifest.entities.filter(entity => entity.kind === 'work').map(entity => {
    const title = String(entity.fragments[0]?.original.title ?? '').trim();
    if (!title || title.length > 20_000) fail('limit', 'Legacy title exceeds native work limits.');
    const criteria: string[] = [];
    for (const fragment of entity.fragments) {
      const original = fragment.original;
      const metadata = original.metadata === undefined ? undefined : object(original.metadata, 'task.metadata');
      for (const list of [original.verification, metadata?.verification]) {
        if (list === undefined) continue;
        for (const criterion of array(list, 'verification')) {
          if (typeof criterion !== 'string' || !criterion.trim() || criterion.trim().length > 20_000) fail('invalid-source', 'Unsupported legacy verification criterion; nothing was truncated.');
          if (!criteria.includes(criterion.trim())) criteria.push(criterion.trim());
        }
      }
    }
    if (criteria.length > 100) fail('limit', 'Legacy verification criteria exceed native work limits.');
    if (!criteria.length) criteria.push('Review and define acceptance criteria for this imported legacy work.');
    // Notes and planning rationale have no established precedence. Do not silently
    // pick one as the authoritative goal; the complete fragments retain both.
    return { id: entity.id, title, goal: title, criteria, revision: 1, criteriaRevision: 1,
      reportedState: entity.reportedState ?? 'pending', currentAttemptId: null, createdAt: at, updatedAt: at };
  });
}
