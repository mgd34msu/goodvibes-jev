import fs from 'node:fs';
import { types as nodeTypes } from 'node:util';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { writeStoreJson } from '@/utils/store-file.ts';
import { captureCatalogMethods, type CatalogRankingOptions } from '../tools/agent-harness-catalog-ranking.ts';
import { captureModelReadingSnapshotGuard, modelReadingServicePath } from '../tools/agent-harness-model-reading-source.ts';
import { type LearningCandidateCollection, type LearningCuratorNativeContext } from '../tools/agent-harness-learning-curator-source.ts';
import { buildLearningCandidates, assertLearningCandidateCollection } from '../tools/agent-harness-learning-curator-proposals.ts';
import { AgentSkillRegistry } from './skill-registry.ts';
import { proposeSkillDrafts } from './skill-draft-proposer.ts';

// ---------------------------------------------------------------------------
// Ledger types
// ---------------------------------------------------------------------------

export interface SkillDraftLedgerEntry {
  /** Stable ledger entry id, matches the persisted skill id assigned by the registry. */
  readonly skillId: string;
  /** Kebab-slug name of the proposed skill. */
  readonly name: string;
  /** Learning candidate that originated this proposal. */
  readonly candidateId: string;
  /** ISO timestamp when the draft was proposed. */
  readonly proposedAt: string;
}

interface SkillDraftLedgerFile {
  readonly version: 1;
  readonly entries: readonly SkillDraftLedgerEntry[];
}

const LEDGER_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface SkillDraftRunResult {
  /** Number of new draft skills persisted this pass. */
  readonly proposed: number;
  /** Number of candidates that were eligible but skipped (dedup / secret). */
  readonly skipped: number;
  /** Entries written to the ledger this pass. */
  readonly entries: readonly SkillDraftLedgerEntry[];
  /** Skill ids created this pass. */
  readonly skillIds: readonly string[];
}

const issuedResults = new WeakMap<SkillDraftRunResult, {
  readonly context: LearningCuratorNativeContext;
  readonly options: CatalogRankingOptions;
  readonly assertOutput: (current: unknown) => void;
  readonly assertCurrent: () => void;
}>();

/** Refuse a copied result or a changed original caller, source, ledger or output. */
export function assertSkillDraftRunResultCurrent(
  result: SkillDraftRunResult,
  context: LearningCuratorNativeContext,
  options: CatalogRankingOptions,
): void {
  const issued = issuedResults.get(result);
  if (!issued || issued.context !== context || issued.options !== options)
    throw new ToolInputProjectionError('held');
  issued.assertOutput(result);
  issued.assertCurrent();
  issued.assertOutput(result);
}

// ---------------------------------------------------------------------------
// Ledger I/O
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLedger(bytes: string | undefined): SkillDraftLedgerFile {
  if (bytes === undefined) return { version: LEDGER_VERSION, entries: [] };
  try {
    const raw: unknown = JSON.parse(bytes);
    if (!isRecord(raw)) return { version: LEDGER_VERSION, entries: [] };
    const entries = Array.isArray(raw.entries)
      ? (raw.entries as unknown[])
          .filter(isRecord)
          .filter(
            (e): e is Record<string, string> =>
              typeof e.skillId === 'string' &&
              typeof e.name === 'string' &&
              typeof e.candidateId === 'string' &&
              typeof e.proposedAt === 'string',
          )
          .map((e) => ({
            skillId: e.skillId,
            name: e.name,
            candidateId: e.candidateId,
            proposedAt: e.proposedAt,
          } satisfies SkillDraftLedgerEntry))
      : [];
    return { version: LEDGER_VERSION, entries };
  } catch {
    return { version: LEDGER_VERSION, entries: [] };
  }
}

type LedgerFile = { readonly kind: 'missing' } | {
  readonly kind: 'file'; readonly bytes: string; readonly stat: fs.BigIntStats;
};

function sameLedgerIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.uid === right.uid && left.gid === right.gid
    && left.rdev === right.rdev && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function readLedgerFile(path: string): LedgerFile {
  if (!fs.existsSync(path)) return { kind: 'missing' };
  const before = fs.statSync(path, { bigint: true });
  const bytes = fs.readFileSync(path, 'utf8');
  const after = fs.statSync(path, { bigint: true });
  if (!sameLedgerIdentity(before, after)) throw new ToolInputProjectionError('stale');
  return { kind: 'file', bytes, stat: after };
}

function sameLedgerFile(expected: LedgerFile, actual: LedgerFile): boolean {
  return expected.kind === 'missing' ? actual.kind === 'missing'
    : actual.kind === 'file' && expected.bytes === actual.bytes
      && sameLedgerIdentity(expected.stat, actual.stat);
}

function readLedger(ledgerPath: string): SkillDraftLedgerFile {
  const file = readLedgerFile(ledgerPath);
  return parseLedger(file.kind === 'file' ? file.bytes : undefined);
}

// ---------------------------------------------------------------------------
// Ledger path resolution
// ---------------------------------------------------------------------------

/**
 * Derive the ledger path from the registry's skills store path, placing the
 * ledger file as a sibling: `.../skills/skill-draft-ledger.json`.
 */
function ledgerPathFromRegistry(registry: AgentSkillRegistry): string {
  // AgentSkillRegistry exposes the store path via snapshot().path
  const snapshot = registry.snapshot();
  return snapshot.path.replace(/skills\.json$/, 'skill-draft-ledger.json');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Create disabled drafts under the original caller and complete curator source. */
export async function runSkillDraftProposer(
  context: LearningCuratorNativeContext,
  registry: AgentSkillRegistry,
  options: CatalogRankingOptions,
  suppliedCollection?: LearningCandidateCollection,
): Promise<SkillDraftRunResult> {
  const assertOptions = captureCatalogMethods(options, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent', 'requirePreservedSource']);
  const signal = options.signal, caller = options.assertCurrent;
  const assertSignal = signal ? captureCatalogMethods(signal, ['throwIfAborted']) : () => {};
  if (typeof caller !== 'function') throw new ToolInputProjectionError('unavailable');
  const assertCaller = () => {
    assertOptions(); assertSignal(); signal?.throwIfAborted();
    const result: unknown = caller();
    if (result !== undefined) {
      if (nodeTypes.isPromise(result)) Promise.prototype.then.call(result, undefined, () => {});
      throw new ToolInputProjectionError('stale');
    }
    assertOptions(); assertSignal(); signal?.throwIfAborted();
  };
  assertCaller();
  const assertRegistry = captureCatalogMethods(registry, ['snapshot', 'list', 'create', 'storePath', 'effects']);
  const assertFactory = captureCatalogMethods(AgentSkillRegistry, ['prototype', 'fromShellPaths']);
  const assertNativeMethods = captureCatalogMethods(AgentSkillRegistry.prototype, ['constructor', 'snapshot', 'list', 'readStore', 'writeStore', 'nextId', 'validateRequired', 'create']);
  const assertFileMethods = captureCatalogMethods(fs, ['existsSync', 'readFileSync', 'statSync']);
  const assertNativeRegistry = () => {
    assertRegistry(); assertFactory(); assertNativeMethods();
    if (Object.getPrototypeOf(registry) !== AgentSkillRegistry.prototype
      || modelReadingServicePath(registry, ['snapshot']) !== AgentSkillRegistry.prototype.snapshot
      || modelReadingServicePath(registry, ['list']) !== AgentSkillRegistry.prototype.list
      || modelReadingServicePath(registry, ['create']) !== AgentSkillRegistry.prototype.create)
      throw new ToolInputProjectionError('held');
  };
  assertNativeRegistry(); assertFileMethods();
  const originalPath = registry.snapshot().path;
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) throw new ToolInputProjectionError('unavailable');
  if (AgentSkillRegistry.fromShellPaths(shellPaths).snapshot().path !== originalPath)
    throw new ToolInputProjectionError('stale');
  const ledgerPath = ledgerPathFromRegistry(registry);
  if (ledgerPath === originalPath) throw new ToolInputProjectionError('invalid');
  let ledgerFile = readLedgerFile(ledgerPath);
  const ledger = parseLedger(ledgerFile.kind === 'file' ? ledgerFile.bytes : undefined);
  const priorEffects = modelReadingServicePath(registry, ['effects']);
  if (priorEffects !== undefined && (priorEffects === null || typeof priorEffects !== 'object'))
    throw new ToolInputProjectionError('held');
  const assertPrior = priorEffects ? captureCatalogMethods(priorEffects, ['assertCurrent', 'onEffect']) : () => {};
  assertPrior();
  const priorCurrent = priorEffects ? modelReadingServicePath(priorEffects, ['assertCurrent']) : undefined;
  const priorEffect = priorEffects ? modelReadingServicePath(priorEffects, ['onEffect']) : undefined;
  if ((priorCurrent !== undefined && typeof priorCurrent !== 'function')
    || (priorEffect !== undefined && typeof priorEffect !== 'function')) throw new ToolInputProjectionError('held');
  const assertOwnership = () => {
    assertOptions(); assertSignal(); assertNativeRegistry(); assertFileMethods(); assertPrior();
    signal?.throwIfAborted();
    if (registry.snapshot().path !== originalPath || context.workspace?.shellPaths !== shellPaths)
      throw new ToolInputProjectionError('stale');
    if (!sameLedgerFile(ledgerFile, readLedgerFile(ledgerPath))) throw new ToolInputProjectionError('stale');
  };
  assertOwnership(); assertCaller(); assertOwnership();
  const collection = suppliedCollection ?? await buildLearningCandidates(context, options);
  assertLearningCandidateCollection(collection, context, options);
  const assertCurrent = () => {
    assertOwnership(); assertLearningCandidateCollection(collection, context, options); assertOwnership();
  };
  assertCurrent();
  const existingSkillNames = new Set(registry.list().map(skill => skill.name.trim().toLowerCase()));
  const previouslyProposedNames = new Set(ledger.entries.map(entry => entry.name.trim().toLowerCase()));
  const previouslyProposedCandidateIds = new Set(ledger.entries.map(entry => entry.candidateId));
  assertCurrent();
  const eligibleCount = collection.candidates.filter(candidate =>
    (candidate.status === 'proposal-ready' || candidate.status === 'ready-to-promote')
      && candidate.proposalTarget === 'skill').length;
  const drafts = proposeSkillDrafts({ candidates: collection.candidates, existingSkillNames, previouslyProposedNames, previouslyProposedCandidateIds });
  const newEntries: SkillDraftLedgerEntry[] = [];
  const skillIds: string[] = [];
  for (const draft of drafts) {
    assertCurrent();
    const candidate = collection.candidates.find(candidate => candidate.id === draft.candidateId);
    if (!candidate) throw new ToolInputProjectionError('held');
    collection.assertCandidateCurrent(candidate);
    assertCurrent();
    const input = {
      name: draft.name, description: draft.description, procedure: draft.procedure,
      triggers: draft.triggers, tags: draft.tags, requirements: draft.requirements,
      enabled: false, source: 'agent', provenance: draft.provenance,
    } satisfies Parameters<AgentSkillRegistry['create']>[0];
    const transition = collection.prepareTransition({ kind: 'create', domain: 'skill', input });
    let restrictionFailed = false;
    let returned = false;
    try {
      const writer = AgentSkillRegistry.fromShellPaths(shellPaths, {
        assertCurrent: () => {
          try {
            assertOwnership(); assertLearningCandidateCollection(collection, context, options); transition.effects.assertCurrent();
            if (typeof priorCurrent === 'function') {
              const result: unknown = priorCurrent.call(priorEffects);
              if (result !== undefined) {
                if (nodeTypes.isPromise(result)) Promise.prototype.then.call(result, undefined, () => {});
                throw new ToolInputProjectionError('stale');
              }
            }
            assertOwnership(); assertLearningCandidateCollection(collection, context, options); transition.effects.assertCurrent();
          } catch (error) { restrictionFailed = true; throw error; }
        },
        onEffect: published => {
          try {
            transition.effects.onEffect?.(published);
            if (typeof priorEffect === 'function') {
              const result: unknown = priorEffect.call(priorEffects, published);
              if (result !== undefined) {
                if (nodeTypes.isPromise(result)) Promise.prototype.then.call(result, undefined, () => {});
                throw new ToolInputProjectionError('stale');
              }
            }
            assertOptions(); assertSignal(); assertNativeRegistry(); assertFileMethods(); assertPrior();
            signal?.throwIfAborted();
          } catch (error) { restrictionFailed = true; throw error; }
        },
      });
      transition.effects.assertCurrent(); assertOwnership();
      const skill = writer.create(input);
      returned = true;
      transition.commit(skill); assertCurrent();
      const entry: SkillDraftLedgerEntry = {
        skillId: skill.id, name: skill.name, candidateId: draft.candidateId,
        proposedAt: new Date().toISOString(),
      };
      newEntries.push(entry); skillIds.push(skill.id);
    } catch (error) {
      transition.abort();
      if (returned || restrictionFailed || error instanceof ToolInputProjectionError || signal?.aborted) throw error;
      // Only an unchanged pre-publication validation failure may skip a draft.
      assertCurrent();
    }
  }
  if (newEntries.length > 0) {
    assertCurrent();
    const expected = { version: LEDGER_VERSION, entries: [...ledger.entries, ...newEntries] };
    const expectedBytes = `${JSON.stringify(expected, null, 2)}\n`;
    let published = false;
    writeStoreJson(ledgerPath, expected, {
      assertCurrent,
      onEffect: publication => {
        if (publication !== true) return;
        const actual = readLedgerFile(ledgerPath);
        if (actual.kind !== 'file' || actual.bytes !== expectedBytes) throw new ToolInputProjectionError('stale');
        ledgerFile = { ...actual, bytes: expectedBytes };
        published = true;
        assertCurrent();
      },
    });
    if (!published) throw new ToolInputProjectionError('stale');
  }
  assertCurrent();
  const result: SkillDraftRunResult = { proposed: newEntries.length, skipped: eligibleCount - newEntries.length,
    entries: newEntries, skillIds };
  issuedResults.set(result, { context, options, assertCurrent,
    assertOutput: captureModelReadingSnapshotGuard(result) });
  assertSkillDraftRunResultCurrent(result, context, options);
  return result;
}

// ---------------------------------------------------------------------------
// Ledger read helper, for harness tool inspection
// ---------------------------------------------------------------------------

/**
 * Read the current ledger for inspection without running a proposal pass.
 */
export function readSkillDraftLedger(registry: AgentSkillRegistry): readonly SkillDraftLedgerEntry[] {
  const ledgerPath = ledgerPathFromRegistry(registry);
  return readLedger(ledgerPath).entries;
}
