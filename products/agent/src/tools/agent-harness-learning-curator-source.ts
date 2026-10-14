import fs from 'node:fs';
import { types as nodeTypes } from 'node:util';
import { prepareLearningNativeTransition, type LearningTransitionIntent, type LearningSourceTransition } from './agent-harness-learning-curator-transitions.ts';
import { AgentNoteRegistry } from '../agent/note-registry.ts';
import { AgentPersonaRegistry } from '../agent/persona-registry.ts';
import { AgentSkillRegistry } from '../agent/skill-registry.ts';
import { AgentRoutineRegistry } from '../agent/routine-registry.ts';
import { AgentResearchRunRegistry } from '../agent/research-run-registry.ts';
import { summarizeMemoryItem, summarizeNoteItem, summarizePersonaItem, summarizeSkillItem, summarizeSkillBundleItem, summarizeRoutineItem } from '../input/agent-workspace-local-library-snapshot.ts';
import type { AgentWorkspaceLocalLibraryItem } from '../input/agent-workspace-types.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { MemoryApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogData, captureCatalogMethods, captureCatalogSnapshotGuard, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { modelReadingServicePath, captureModelReadingSnapshotGuard } from './agent-harness-model-reading-source.ts';
import { discoverVibeFiles } from '../agent/vibe-file.ts';
import type { LocalLearningCandidateDomain, LearningCandidate } from './agent-harness-learning-curator-types.ts';

export interface LearningRecord {
  readonly item: AgentWorkspaceLocalLibraryItem;
  readonly record: unknown;
}

export interface LearningCuratorNativeContext {
  readonly workspace?: Pick<CommandContext['workspace'], 'shellPaths'> & { readonly workPlanStore?: Pick<NonNullable<CommandContext['workspace']['workPlanStore']>, 'listItems'> };
  readonly clients?: { readonly agentKnowledgeApi?: { readonly memory?: Pick<MemoryApi, 'getAll'> } };
  readonly session?: {
    readonly sessionManager?: Pick<NonNullable<CommandContext['session']['sessionManager']>, 'list' | 'load'>;
    readonly runtime?: Pick<CommandContext['session']['runtime'], 'sessionId'>;
  };
}

export function acquireLearningCuratorSource(context: LearningCuratorNativeContext, options: CatalogRankingOptions) {
  const callerFields = captureCatalogMethods(options, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent', 'requirePreservedSource']);
  const signal = options.signal, callerCurrent = options.assertCurrent, retainCurrent = options.retainCurrent;
  const signalMethods = signal ? captureCatalogMethods(signal, ['throwIfAborted']) : () => {};
  const synchronous = (value: unknown) => {
    if (value === undefined) return;
    if (nodeTypes.isPromise(value)) Promise.prototype.then.call(value, undefined, () => {});
    throw new ToolInputProjectionError('held');
  };
  let calling = false;
  const assertCaller = () => {
    if (calling) throw new ToolInputProjectionError('held');
    callerFields(); signalMethods(); signal?.throwIfAborted();
    if (callerCurrent) {
      calling = true;
      try { const result: unknown = callerCurrent(); synchronous(result); } finally { calling = false; }
    }
    callerFields(); signalMethods(); signal?.throwIfAborted();
  };
  assertCaller();
  const paths = [
    ['workspace', 'shellPaths'], ['workspace', 'workPlanStore'], ['clients', 'agentKnowledgeApi', 'memory'],
    ['session', 'sessionManager'], ['session', 'runtime'],
  ];
  const guards: (() => void)[] = [captureCatalogMethods(fs, ['readFileSync', 'existsSync'])];
  const identities = paths.map(keys => {
    let parent: unknown = context;
    for (const key of keys) {
      if (parent !== null && typeof parent === 'object') guards.push(captureCatalogMethods(parent, [key]));
      parent = modelReadingServicePath(parent, [key]);
    }
    return { keys, value: parent };
  });
  const memory = context.clients?.agentKnowledgeApi?.memory;
  const work = context.workspace?.workPlanStore;
  const manager = context.session?.sessionManager;
  const runtime = context.session?.runtime;
  const sessionId = runtime?.sessionId;
  const shellPaths = context.workspace?.shellPaths;
  if (runtime) guards.push(captureCatalogMethods(runtime, ['sessionId']));
  if (memory) guards.push(captureCatalogMethods(memory, ['getAll']));
  if (work) guards.push(captureCatalogMethods(work, ['listItems', 'getActivePlan', 'readPlan', 'options', 'filePath', 'homeDirectory']));
  if (manager) guards.push(captureCatalogMethods(manager, ['list', 'load', 'sessionsDir', 'sanitizeName']));
  if (shellPaths) guards.push(captureCatalogMethods(shellPaths, ['resolveProjectPath', 'resolveUserPath', 'homeDirectory', 'workingDirectory']));
  const notes = shellPaths ? AgentNoteRegistry.fromShellPaths(shellPaths) : undefined;
  const personas = shellPaths ? AgentPersonaRegistry.fromShellPaths(shellPaths) : undefined;
  const skills = shellPaths ? AgentSkillRegistry.fromShellPaths(shellPaths) : undefined;
  const routines = shellPaths ? AgentRoutineRegistry.fromShellPaths(shellPaths) : undefined;
  const research = shellPaths ? AgentResearchRunRegistry.fromShellPaths(shellPaths) : undefined;
  for (const registry of [notes, personas, skills, routines, research]) {
    if (registry) guards.push(captureCatalogMethods(registry, ['snapshot', 'readStore', 'storePath']));
  }
  for (const registry of [AgentNoteRegistry, AgentPersonaRegistry, AgentSkillRegistry, AgentRoutineRegistry, AgentResearchRunRegistry])
    guards.push(captureCatalogMethods(registry, ['fromShellPaths']));
  const capturedAt = Date.now();
  if (!Number.isSafeInteger(capturedAt) || Math.abs(capturedAt) > 8_640_000_000_000_000) throw new ToolInputProjectionError('invalid');
  // This clock is generated by this native owner, never discovered by a field name.
  const capturedAtForReading = new Date(capturedAt).toISOString();
  const retained = new Set<() => void>();
  // This guard never invokes the caller whose publication map retains it.
  const assertNative = () => {
    callerFields(); signalMethods(); signal?.throwIfAborted();
    for (const guard of guards) guard();
    for (const identity of identities) if (modelReadingServicePath(context, identity.keys) !== identity.value) throw new ToolInputProjectionError('stale');
    if (runtime?.sessionId !== sessionId) throw new ToolInputProjectionError('stale');
  };
  const assertReadingBackends = () => { assertNative(); for (const guard of retained) guard(); assertNative(); };
  const read = () => {
    assertNative();
    const memoryRecords = captureCatalogData(memory?.getAll() ?? []);
    const noteSnapshot = captureCatalogData(notes?.snapshot());
    const personaSnapshot = captureCatalogData(personas?.snapshot());
    const skillSnapshot = captureCatalogData(skills?.snapshot());
    const routineSnapshot = captureCatalogData(routines?.snapshot());
    const researchSnapshot = captureCatalogData(research?.snapshot());
    const registryFiles = [
      { domain: 'note', path: noteSnapshot?.path }, { domain: 'persona', path: personaSnapshot?.path },
      { domain: 'skill', path: skillSnapshot?.path }, { domain: 'routine', path: routineSnapshot?.path },
      { domain: 'research', path: researchSnapshot?.path },
    ].filter((file): file is { domain: string; path: string } => typeof file.path === 'string').map(file => {
      const exists = fs.existsSync(file.path);
      return { ...file, exists, bytes: exists ? fs.readFileSync(file.path, 'utf8') : undefined };
    });
    const workItems = captureCatalogData(work?.listItems({ readOnly: true }) ?? []);
    const sessionList = captureCatalogData(manager?.list() ?? []);
    const sessions = sessionList.filter(session => session.name !== sessionId).map(session => ({ session, loaded: captureCatalogData(manager?.load(session.name)) }));
    const vibe = shellPaths ? captureCatalogData(discoverVibeFiles(shellPaths)) : undefined;
    const vibeEvidence = vibe ? [...vibe.files, ...vibe.blocked].map(file => ({ ...file, body: fs.readFileSync(file.path, 'utf8') })) : [];
    assertNative();
    return captureCatalogData({ capturedAt, memoryRecords, noteSnapshot, personaSnapshot, skillSnapshot, routineSnapshot, researchSnapshot, registryFiles, workItems, sessionList, sessions, vibe, vibeEvidence });
  };
  assertCaller();
  const source = read();
  assertCaller();
  // Keep the complete raw source for native currentness and exact self-write proofs.
  // These columns belong to records acquired through the retained Memory API.
  // Preserve every other slot, including hidden and nested producer evidence.
  const projectMemoryRecord = (record: unknown): unknown => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new ToolInputProjectionError('invalid');
    const projected: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(record))) {
      let value: unknown = descriptor.value;
      if (['createdAt', 'updatedAt', 'reviewedAt', 'validFrom', 'validUntil'].includes(key) && typeof value === 'number') {
        if (!Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000) throw new ToolInputProjectionError('invalid');
        value = new Date(value).toISOString();
      }
      Object.defineProperty(projected, key, { ...descriptor, value });
    }
    return projected;
  };
  const memoryReadingRecords: unknown[] = new Array(source.memoryRecords.length);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(source.memoryRecords))) {
    if (key === 'length') continue;
    const index = Number(key);
    const indexed = Number.isSafeInteger(index) && index >= 0 && String(index) === key && index < source.memoryRecords.length;
    Object.defineProperty(memoryReadingRecords, key, { ...descriptor, value: indexed ? projectMemoryRecord(descriptor.value) : descriptor.value });
  }
  const replaceSlots = <T extends object, R extends Record<string, unknown>>(record: T, replacements: R): Omit<T, keyof R> & R => {
    const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(record);
    for (const [key, value] of Object.entries(replacements)) descriptors[key] = { ...descriptors[key], value };
    return Object.create(Object.getPrototypeOf(record), descriptors) as Omit<T, keyof R> & R;
  };
  const nativeClock = (value: unknown): string => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000) throw new ToolInputProjectionError('invalid');
    return new Date(value).toISOString();
  };
  const projectSessionMeta = <T extends { readonly timestamp?: number }>(record: T): Omit<T, 'timestamp'> & { readonly timestamp?: string | undefined } => {
    const descriptor = Object.getOwnPropertyDescriptor(record, 'timestamp');
    if (!descriptor || descriptor.value === undefined) return record as Omit<T, 'timestamp'>;
    const value: unknown = descriptor.value;
    return replaceSlots(record, { timestamp: nativeClock(value) });
  };
  const projectCollection = <T, R>(records: readonly T[], project: (record: T) => R): readonly R[] => {
    const projected: R[] = new Array(records.length);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(records))) {
      if (key === 'length') continue;
      const index = Number(key), indexed = Number.isSafeInteger(index) && index >= 0 && String(index) === key && index < records.length;
      Object.defineProperty(projected, key, { ...descriptor, value: indexed ? project(descriptor.value) : descriptor.value });
    }
    return projected;
  };
  // Only metadata acquired from this retained SessionManager owns these clock
  // slots. Keep hidden collection/record evidence and every original byte locally.
  const sessionList = projectCollection(source.sessionList, projectSessionMeta);
  const sessions = projectCollection(source.sessions, record => replaceSlots(record, {
    session: projectSessionMeta(record.session),
    loaded: record.loaded ? replaceSlots(record.loaded, { meta: projectSessionMeta(record.loaded.meta) }) : record.loaded,
  }));
  const workItems = projectCollection(source.workItems, record => replaceSlots(record, {
    createdAt: nativeClock(record.createdAt), updatedAt: nativeClock(record.updatedAt),
    ...(Object.hasOwn(record, 'completedAt') ? { completedAt: record.completedAt === undefined ? undefined : nativeClock(record.completedAt) } : {}),
  }));
  const readingSource = captureCatalogData({ ...source, workItems, capturedAt: capturedAtForReading, memoryRecords: memoryReadingRecords, sessionList, sessions });
  const assertReadingSnapshot = captureModelReadingSnapshotGuard(readingSource);
  let expected = source;
  let assertSnapshot = captureModelReadingSnapshotGuard(expected);
  let active: object | undefined;
  const assertEvidence = () => { assertReadingBackends(); assertSnapshot(read()); assertReadingSnapshot(readingSource); assertNative(); };
  const assertCurrent = () => {
    assertCaller(); assertEvidence(); assertCaller(); assertEvidence();
  };
  assertCurrent();
  const originalRecord = (state: typeof source, domain: LocalLearningCandidateDomain, id: string): unknown => {
    const records = domain === 'memory' ? state.memoryRecords : domain === 'note' ? state.noteSnapshot?.notes
      : domain === 'persona' ? state.personaSnapshot?.personas : domain === 'skill' ? state.skillSnapshot?.skills
        : domain === 'skill_bundle' ? state.skillSnapshot?.bundles : state.routineSnapshot?.routines;
    return records?.find(record => record.id === id);
  };
  const assertOriginalRecords = (domain: LocalLearningCandidateDomain, ids: readonly string[]) => {
    assertCurrent();
    for (const id of ids) {
      const original = originalRecord(source, domain, id), current = originalRecord(expected, domain, id);
      if (!original || !current) throw new ToolInputProjectionError('held');
      captureCatalogSnapshotGuard(original)(current);
    }
    assertCurrent();
  };
  const prepareTransition = (originalIntent: LearningTransitionIntent): LearningSourceTransition => {
    assertCurrent();
    if (active) throw new ToolInputProjectionError('held');
    const intent = captureCatalogData(originalIntent);
    const assertIntent = captureModelReadingSnapshotGuard(intent);
    const accept = prepareLearningNativeTransition(expected, intent);
    const lease = {};
    active = lease;
    let phase: 'unpublished' | 'published' | 'finished' = 'unpublished';
    const assertLease = () => {
      assertCaller(); assertReadingBackends(); assertIntent(originalIntent);
      if (active !== lease || phase === 'finished') throw new ToolInputProjectionError('held');
    };
    const effects = Object.freeze({
      assertCurrent: () => { assertLease(); if (phase !== 'unpublished') throw new ToolInputProjectionError('held'); assertCurrent(); },
      onEffect: (published?: boolean) => {
        assertLease();
        if (published !== true) { if (phase !== 'unpublished') throw new ToolInputProjectionError('held'); assertCurrent(); return; }
        if (phase !== 'unpublished') throw new ToolInputProjectionError('held');
        phase = 'published';
      },
    });
    return Object.freeze({ effects,
      commit: (record: unknown) => {
        assertLease();
        if (phase !== 'published') throw new ToolInputProjectionError('held');
        const delta = accept(record);
        const current = read();
        let planned: typeof expected;
        if (delta.domain === 'memory') {
          planned = captureCatalogData({ ...expected, memoryRecords: delta.memoryRecords });
        } else {
          const file = current.registryFiles.find(file => file.domain === delta.domain);
          const previous = expected.registryFiles.find(file => file.domain === delta.domain);
          if (!file || !previous || file.path !== previous.path || !file.exists || file.bytes !== delta.bytes) throw new ToolInputProjectionError('held');
          // Only the exact predicted target bytes authorize its native derived views.
          const registryFiles = expected.registryFiles.map(file => file.domain === delta.domain ? { ...file, exists: true, bytes: delta.bytes } : file);
          planned = delta.domain === 'persona' ? captureCatalogData({ ...expected, registryFiles, personaSnapshot: current.personaSnapshot })
            : delta.domain === 'skill' ? captureCatalogData({ ...expected, registryFiles, skillSnapshot: current.skillSnapshot })
              : captureCatalogData({ ...expected, registryFiles, routineSnapshot: current.routineSnapshot });
        }
        captureModelReadingSnapshotGuard(planned)(current);
        assertLease();
        captureModelReadingSnapshotGuard(planned)(read()); assertNative();
        const nextGuard = captureModelReadingSnapshotGuard(planned);
        expected = planned; assertSnapshot = nextGuard; phase = 'finished'; active = undefined;
        assertCurrent();
      },
      abort: () => {
        if (phase === 'finished') return;
        if (active !== lease) throw new ToolInputProjectionError('held');
        phase = 'finished'; active = undefined;
      },
    });
  };
  if (retainCurrent) {
    callerFields(); const result: unknown = retainCurrent(assertEvidence, 'agent.learning.curator.native-source'); synchronous(result); assertCaller();
  }
  const libraries: Readonly<Record<LocalLearningCandidateDomain, readonly LearningRecord[]>> = {
    memory: source.memoryRecords.map((record, index) => ({ item: summarizeMemoryItem(record), record: readingSource.memoryRecords[index] })),
    note: (source.noteSnapshot?.notes ?? []).map(record => ({ item: summarizeNoteItem(record), record })),
    persona: (source.personaSnapshot?.personas ?? []).map(record => ({ item: summarizePersonaItem(record, source.personaSnapshot?.activePersonaId ?? null), record })),
    skill: (source.skillSnapshot?.skills ?? []).map(record => ({ item: summarizeSkillItem(record), record })),
    skill_bundle: (source.skillSnapshot?.bundles ?? []).map(record => ({ item: summarizeSkillBundleItem(record, source.skillSnapshot?.skills ?? []), record })),
    routine: (source.routineSnapshot?.routines ?? []).map(record => ({ item: summarizeRoutineItem(record), record })),
  };
  for (const records of Object.values(libraries)) {
    const ids = records.map(record => record.item.id);
    if (new Set(ids).size !== ids.length) throw new ToolInputProjectionError('held');
  }
  const retainReadingCurrent = (guard: () => void, key?: string) => {
    assertCurrent();
    retained.add(guard);
    if (retainCurrent) { const result: unknown = retainCurrent(guard, key); synchronous(result); }
    assertCurrent();
  };
  const scoped = Object.freeze({ ...options, assertCurrent, retainCurrent: retainReadingCurrent, requirePreservedSource: true });
  return { source: readingSource, libraries, assertCurrent, assertOriginalRecords, prepareTransition, options: scoped };
}

export type LearningCuratorSource = ReturnType<typeof acquireLearningCuratorSource>;
export interface LearningCandidateCollection {
  readonly candidates: readonly LearningCandidate[];
  readonly promptRecords: readonly { readonly domain: LocalLearningCandidateDomain; readonly item: AgentWorkspaceLocalLibraryItem; readonly priority: number; readonly scores: LearningCandidate['scores'] }[];
  readonly assertCurrent: () => void;
  readonly options: CatalogRankingOptions;
  readonly assertCandidateCurrent: (candidate: LearningCandidate) => void;
  readonly prepareTransition: (intent: LearningTransitionIntent) => LearningSourceTransition;
}
