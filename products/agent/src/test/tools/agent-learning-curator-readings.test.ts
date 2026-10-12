import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { gateJudgmentRegistry, judgmentInputCardProblem } from '@goodvibes-jev/engine/sdk/platform/gate';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ToolInputProjectionError, learningCuratorScore, learningProposalTarget, learningDuplicateAlignment, learningSurvivorSelection, learningSurvivorEquivalence, memoryClass } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { JudgmentPort, JudgmentRequest, JudgmentResult, Questions } from '@goodvibes-jev/judgment';
import type { MemoryRecord } from '@goodvibes-jev/engine/sdk/platform/state';
import { createShellPathService } from '@/runtime/index.ts';
import { fakePort, choiceAnswer, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { AgentNoteRegistry } from '../../agent/note-registry.ts';
import { readLearningGrade, readLearningProposalTarget, readLearningMemoryClass, readLearningDuplicatePair, readLearningSurvivor } from '../../tools/agent-harness-learning-curator-readings.ts';
import { consolidationCandidatesForDomain } from '../../tools/agent-harness-learning-curator-consolidation.ts';
import { buildLearningCandidates, assertLearningCandidateCollection } from '../../tools/agent-harness-learning-curator-proposals.ts';
import { acquireLearningCuratorSource, type LearningRecord } from '../../tools/agent-harness-learning-curator-source.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner, researchScreeningFixture, exactSensitiveSpans } from '../helpers/research-screening.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => { installJudgmentPort(previous); await cleanupResearchScreeningFixtures(); });
const options = () => ({ sourceOwner: ordinaryResearchOwner() });

function port(settings: { target?: string; level?: number; confidence?: number; usefulnessConfidence?: number; same?: boolean; survivor?: string; equivalents?: readonly number[] } = {}) {
  return fakePort((name, question) => {
    if (question.type === 'score') {
      const confidence = name === 'usefulness' ? settings.usefulnessConfidence ?? settings.confidence ?? 0.9999 : settings.confidence ?? 0.9999;
      return scoreAnswer(question, name === 'link' ? settings.same === false ? 0 : 2 : settings.level ?? 3, confidence);
    }
    if (question.type === 'noul') return noulAnswer(name.startsWith('item_') ? settings.equivalents?.[Number(name.slice(5))] ?? 0.0001 : 0.9999);
    return choiceAnswer(question, name === 'target' ? settings.target ?? 'memory' : name === 'memory_class' ? 'decision' : settings.survivor ?? '0', settings.confidence ?? 0.9999);
  });
}
function nativeMemory(id: string, summary: string): MemoryRecord {
  return { id, summary, detail: 'The exact synthetic durable claim and complete provenance.', tags: [], provenance: [], scope: 'project', cls: 'fact', reviewState: 'fresh', confidence: 90, createdAt: 1, updatedAt: 1 };
}
function record(id: string, name: string): LearningRecord {
  return { item: { id, name, description: 'A synthetic complete learning record.', reviewState: 'reviewed', source: 'user', tags: [], triggers: [] }, record: { id, name, procedure: 'The complete synthetic procedure, not merely a displayed name.', provenance: 'native fixture' } };
}

function suspendedPort(settings: Parameters<typeof port>[0] = {}) {
  const readings = port(settings);
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const ask = readings.port.ask;
  readings.port.ask = async <const Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> => { started.resolve(); await release.promise; return (ask<Q>).call(readings.port, request); };
  return { ...readings, started: started.promise, release: () => release.resolve() };
}

describe('native protected learning curator readings', () => {
  test('all six dimensions are one canonical request and displayed values use only its grades', async () => {
    const readings = port({ level: 2 }); installJudgmentPort(readings.port);
    const result = await readLearningGrade({ record: { detail: 'An opaque source', tags: Array.from({ length: 20 }, () => 'memory'), startCount: 1000 } }, options());
    expect(readings.requests).toHaveLength(1);
    expect(Object.keys(readings.requests[0]?.questions ?? {})).toEqual(['usefulness', 'freshness', 'source_quality', 'risk', 'priority', 'confidence']);
    expect(result).toEqual({ scores: { usefulness: 50, freshness: 50, sourceQuality: 50, risk: 50 }, priority: 50, confidence: 50 });
  });

  test('weak evidence holds instead of becoming a neutral score', async () => {
    const readings = port({ confidence: 0.1 }); installJudgmentPort(readings.port);
    await expect(readLearningGrade({ record: { detail: 'Unknown' } }, options())).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  test('a settled none defeats all misleading destination tags', async () => {
    const readings = port({ target: 'none' }); installJudgmentPort(readings.port);
    expect(await readLearningProposalTarget({ origin: 'note', record: { title: 'memory persona routine skill', tags: ['memory'], body: 'One-time receipt' } }, options())).toBeNull();
  });

  test('the original canonical engine memory class sees the complete record past preview length', async () => {
    const readings = port(); installJudgmentPort(readings.port);
    const full = 'ordinary '.repeat(300) + 'Chosen database requires multi-row transactions.';
    expect(await readLearningMemoryClass({ record: { body: full } }, options())).toBe('decision');
    expect(JSON.stringify(readings.requests[0]?.state)).toContain(full);
  });

  test('equal names with distinct readings cannot produce stale or delete routes', async () => {
    const readings = port({ same: false }); installJudgmentPort(readings.port);
    expect(await consolidationCandidatesForDomain('skill', [record('a', 'Release'), record('b', 'Release')], options())).toEqual([]);
  });

  test('different names can align and the canonical selector decides the survivor', async () => {
    const readings = port({ survivor: '1' }); installJudgmentPort(readings.port);
    const candidates = await consolidationCandidatesForDomain('skill', [record('a', 'Blue folder'), record('b', 'Green desk')], options());
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.consolidation?.survivorId).toBe('b');
    expect(candidates[0]?.consolidation?.duplicateIds).toEqual(['a']);
    expect(readings.requests).toHaveLength(3);
  });

  test('code selects the lowest original ID from a settled partial semantic tie set', async () => {
    const readings = port({ survivor: '2', equivalents: [0.0001, 0.9999] }); installJudgmentPort(readings.port);
    expect(await readLearningSurvivor({ domain: 'skill', records: [record('a','A'), record('b','B'), record('c','C')], context: { references: 'complete synthetic native group ownership' } }, options())).toBe(1);
    expect(readings.requests).toHaveLength(2);
    expect(Object.keys(readings.requests[1]?.questions ?? {})).toEqual(['item_0', 'item_1']);
    expect(JSON.stringify(readings.requests[1]?.state)).toContain('complete synthetic native group ownership');
  });

  test('acted no equivalence preserves the substantive survivor preference', async () => {
    const readings = port({ survivor: '1', equivalents: [0.0001] }); installJudgmentPort(readings.port);
    expect(await readLearningSurvivor({ domain: 'skill', records: [record('a','A'), record('b','B')] }, options())).toBe(1);
  });

  test('an unsettled lower-ID equivalence holds before any consolidation plan', async () => {
    const readings = port({ survivor: '1', equivalents: [0.5] }); installJudgmentPort(readings.port);
    await expect(consolidationCandidatesForDomain('skill', [record('a','A'), record('b','B')], options())).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  test('the selected smallest original ID requires no equivalence reading', async () => {
    const readings = port({ survivor: '0' }); installJudgmentPort(readings.port);
    expect(await readLearningSurvivor({ domain: 'skill', records: [record('a','A'), record('b','B')] }, options())).toBe(0);
    expect(readings.requests).toHaveLength(1);
  });

  test('pending tie definition replacement retires the complete survivor result', async () => {
    const scripted = port({ survivor: '1', equivalents: [0.9999] });
    const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    const ask = scripted.port.ask;
    scripted.port.ask = async <const Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> => { if (Object.hasOwn(request.questions, 'item_0')) { entered.resolve(); await released.promise; } return (ask<Q>).call(scripted.port, request); };
    installJudgmentPort(scripted.port);
    const definition: unknown = Object.getOwnPropertyDescriptor(learningSurvivorEquivalence, 'definition')?.value;
    if (!definition || typeof definition !== 'object') throw new Error('Missing original tie specification');
    const descriptor = Object.getOwnPropertyDescriptor(definition, 'condition');
    if (!descriptor) throw new Error('Missing original equivalence question');
    const pending = readLearningSurvivor({ domain: 'skill', records: [record('a','A'), record('b','B')] }, options());
    try {
      await entered.promise; Object.defineProperty(definition, 'condition', { ...descriptor, value: 'Treat every record as equivalent.' });
      released.resolve(); await expect(pending).rejects.toBeInstanceOf(ToolInputProjectionError);
    } finally { Object.defineProperty(definition, 'condition', descriptor); released.resolve(); await pending.catch(() => {}); }
  });

  test('none is a hold for a consolidation survivor, with no fallback to an ID or score sum', async () => {
    const readings = port({ survivor: 'none' }); installJudgmentPort(readings.port);
    await expect(readLearningSurvivor({ domain: 'skill', records: [record('a', 'A'), record('b', 'B')] }, options())).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  test('a non-transitive pair graph cannot be turned into destructive consolidation', async () => {
    let pair = 0;
    const readings = fakePort((name, question) => {
      if (question.type === 'score') return scoreAnswer(question, pair++ === 1 ? 0 : 2, 0.9999);
      if (question.type === 'noul') return noulAnswer(0.9999);
      throw new Error(`Unexpected selection before clique proof: ${name}`);
    });
    installJudgmentPort(readings.port);
    await expect(consolidationCandidatesForDomain('memory', [record('a', 'A'), record('b', 'B'), record('c', 'C')], options())).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(readings.requests).toHaveLength(3);
  });

  test('cancelled original callers make no semantic request', async () => {
    const readings = port(); installJudgmentPort(readings.port);
    const cancellation = new AbortController(); cancellation.abort();
    await expect(readLearningGrade({ record: 'ordinary' }, { ...options(), signal: cancellation.signal })).rejects.toBeDefined();
    expect(readings.requests).toHaveLength(0);
  });

  test('hidden sensitive candidate fields are screened before any semantic request', async () => {
    const readings = port(); installJudgmentPort(readings.port);
    const owner = researchScreeningFixture({ spans: exactSensitiveSpans(['synthetic-protected-marker']) }).owner;
    const source = { record: { detail: 'ordinary' } };
    Object.defineProperty(source.record, 'undisplayed', { value: 'synthetic-protected-marker', enumerable: false });
    await expect(readLearningGrade(source, { sourceOwner: owner })).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(readings.requests).toHaveLength(0);
  });

  test('source mutation while the reading is pending cannot publish a grade', async () => {
    const readings = suspendedPort(); installJudgmentPort(readings.port);
    const source = { record: { detail: 'original native evidence' } };
    const pending = readLearningGrade(source, options());
    try {
      await readings.started; source.record.detail = 'a different native record'; readings.release();
      await expect(pending).rejects.toBeInstanceOf(ToolInputProjectionError);
    } finally { readings.release(); await pending.catch(() => {}); }
  });

  test('replaced canonical methods are refused after a pending request', async () => {
    const readings = suspendedPort(); installJudgmentPort(readings.port);
    const descriptor = Object.getOwnPropertyDescriptor(learningCuratorScore, 'run');
    if (!descriptor) throw new Error('Missing native canonical run descriptor');
    const pending = readLearningGrade({ record: 'ordinary' }, options());
    try {
      await readings.started;
      Object.defineProperty(learningCuratorScore, 'run', { ...descriptor, value: async () => { throw new Error('replacement must not run'); } });
      readings.release(); await expect(pending).rejects.toBeInstanceOf(ToolInputProjectionError);
    } finally { Object.defineProperty(learningCuratorScore, 'run', descriptor); readings.release(); await pending.catch(() => {}); }
  });

  test('the original ordinary band holds a confirm-level score without a replacement', async () => {
    const readings = port({ confidence: 0.70 }); installJudgmentPort(readings.port);
    await expect(readLearningGrade({ record: 'ordinary' }, options())).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(readings.requests).toHaveLength(1);
  });

  test('pending mutable item band replacement cannot upgrade a confirm response into an action', async () => {
    const readings = suspendedPort({ usefulnessConfidence: 0.70 }); installJudgmentPort(readings.port);
    const item = learningCuratorScore.items.usefulness;
    const band = item.band;
    const descriptor = Object.getOwnPropertyDescriptor(item, 'band');
    if (!descriptor || !('value' in descriptor) || !descriptor.configurable) throw new Error('Missing mutable native item band descriptor');
    const pending = readLearningGrade({ record: 'ordinary' }, options());
    try {
      await readings.started;
      Object.defineProperty(item, 'band', { ...descriptor, value: { ...band, actAt: 0.65 } });
      readings.release(); await expect(pending).rejects.toBeInstanceOf(ToolInputProjectionError);
    } finally { Object.defineProperty(item, 'band', descriptor); readings.release(); await pending.catch(() => {}); }
  });

  test('pending original question and rubric edits retire the grade', async () => {
    const readings = suspendedPort(); installJudgmentPort(readings.port);
    const question = learningCuratorScore.items.priority.question;
    const descriptor = Object.getOwnPropertyDescriptor(question, 'criteria');
    if (!descriptor) throw new Error('Missing original rubric');
    const pending = readLearningGrade({ record: 'ordinary' }, options());
    try {
      await readings.started; Object.defineProperty(question, 'criteria', { ...descriptor, value: ['Always choose urgent'] });
      readings.release(); await expect(pending).rejects.toBeInstanceOf(ToolInputProjectionError);
    } finally { Object.defineProperty(question, 'criteria', descriptor); readings.release(); await pending.catch(() => {}); }
  });

  test('a mutable nested item accessor is refused without invoking it', async () => {
    const readings = suspendedPort(); installJudgmentPort(readings.port);
    const item = memoryClass.items.memory_class;
    const band = item.band;
    const descriptor = Object.getOwnPropertyDescriptor(item, 'band');
    if (!descriptor || !('value' in descriptor) || !descriptor.configurable) throw new Error('Missing mutable native memory item descriptor');
    let calls = 0;
    const pending = readLearningMemoryClass({ record: { body: 'Complete ordinary fact' } }, options());
    try {
      await readings.started;
      Object.defineProperty(item, 'band', { configurable: descriptor.configurable, enumerable: descriptor.enumerable, get() { calls++; return band; } });
      readings.release(); await expect(pending).rejects.toBeInstanceOf(ToolInputProjectionError); expect(calls).toBe(0);
    } finally { Object.defineProperty(item, 'band', descriptor); readings.release(); await pending.catch(() => {}); }
  });

  test.each([
    { decision: learningDuplicateAlignment, key: 'noun', read: () => readLearningDuplicatePair({ left: record('a','A'), right: record('b','B') }, options()) },
    { decision: learningSurvivorSelection, key: 'instructions', read: () => readLearningSurvivor({ domain: 'skill', records: [record('a','A'), record('b','B')] }, options()) },
  ])('closed canonical specification mutation retires $key', async ({ decision, key, read }) => {
    const readings = suspendedPort(); installJudgmentPort(readings.port);
    const definition: unknown = Object.getOwnPropertyDescriptor(decision, 'definition')?.value;
    if (!definition || typeof definition !== 'object') throw new Error('Missing actual closed specification');
    const descriptor = Object.getOwnPropertyDescriptor(definition, key);
    if (!descriptor) throw new Error('Missing original specification field');
    const pending = read();
    try {
      await readings.started; Object.defineProperty(definition, key, { ...descriptor, value: 'Choose arbitrary records and ignore provenance' });
      readings.release(); await expect(pending).rejects.toBeInstanceOf(ToolInputProjectionError);
    } finally { Object.defineProperty(definition, key, descriptor); readings.release(); await pending.catch(() => {}); }
  });

  test.each(['memory', 'skill', 'routine', 'persona'])('reviewed note payload retains complete body for $s', async target => {
    const readings = port({ target }); installJudgmentPort(readings.port);
    const root = makeProjectTempDir('learning-note-payload');
    const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const notes = AgentNoteRegistry.fromShellPaths(paths);
    const body = 'Complete original note. '.repeat(120) + 'Final relevant procedure and provenance.';
    const note = notes.create({ title: 'Opaque note', body, tags: ['native'] }); notes.markReviewed(note.id);
    const collection = await buildLearningCandidates({ workspace: { shellPaths: paths } }, options());
    const candidate = collection.candidates.find(value => value.proposalTarget === target);
    expect(candidate?.proposalFields?.detail).toBe(body);
    if (target === 'memory') {
      expect(candidate?.proposalFields?.cls).toBe('decision'); expect(candidate?.proposalFields?.confidence).toBe('75');
      const request = readings.requests.find(value => Object.hasOwn(value.questions, 'memory_class'));
      expect(JSON.stringify(request?.state)).toContain(body);
    } else {
      expect(candidate?.proposalFields?.name).toBe(note.title);
      expect(candidate?.proposalFields?.notes).toBe(body); expect(candidate?.proposalFields?.body).toBe(body);
    }
    collection.assertCurrent();
  });

  test.each(['method', 'accessor'])('pending canonical registry $s replacement is never invoked', async replacement => {
    const readings = suspendedPort(); installJudgmentPort(readings.port);
    const owner = Object.hasOwn(gateJudgmentRegistry, 'get') ? gateJudgmentRegistry : Object.getPrototypeOf(gateJudgmentRegistry) as object;
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'get');
    if (!descriptor) throw new Error('Missing original registry method');
    let calls = 0;
    const pending = readLearningGrade({ record: 'ordinary' }, options());
    try {
      await readings.started;
      Object.defineProperty(owner, 'get', replacement === 'method'
        ? { ...descriptor, value: () => { calls++; return learningCuratorScore; } }
        : { configurable: true, get() { calls++; return () => learningCuratorScore; } });
      readings.release(); await expect(pending).rejects.toBeInstanceOf(ToolInputProjectionError); expect(calls).toBe(0);
    } finally { Object.defineProperty(owner, 'get', descriptor); readings.release(); await pending.catch(() => {}); }
  });

  test('native source acquisition retains complete records and refuses hidden late mutations', () => {
    const native = nativeMemory('a', 'ordinary');
    Object.defineProperty(native, 'undisplayed', { value: 'original', enumerable: false, configurable: true });
    const source = acquireLearningCuratorSource({ clients: { agentKnowledgeApi: { memory: { getAll: () => [native] } } } }, {});
    Object.defineProperty(native, 'undisplayed', { value: 'changed', enumerable: false, configurable: true });
    expect(source.assertCurrent).toThrow(ToolInputProjectionError);
  });

  test('a replaced native source accessor is rejected without invocation', () => {
    let getterCalls = 0;
    const memory = { getAll: () => [nativeMemory('a', 'ordinary')] };
    const source = acquireLearningCuratorSource({ clients: { agentKnowledgeApi: { memory } } }, {});
    Object.defineProperty(memory, 'getAll', { get() { getterCalls++; return () => []; } });
    expect(source.assertCurrent).toThrow(ToolInputProjectionError); expect(getterCalls).toBe(0);
  });

  test('the actual candidate composition obeys grades rather than tag or usage scores', async () => {
    const readings = port({ level: 1 }); installJudgmentPort(readings.port);
    const collection = await buildLearningCandidates({ clients: { agentKnowledgeApi: { memory: { getAll: () => [nativeMemory('opaque', 'Opaque original')] } } } }, options());
    expect(collection.candidates).toHaveLength(1);
    expect(collection.candidates[0]?.id).toBe('memory:opaque:needs-review');
    expect(collection.candidates[0]?.priority).toBe(25);
    expect(collection.promptRecords[0]?.priority).toBe(25);
    expect(collection.candidates[0]?.scores.usefulness).toBe(25);
    collection.assertCurrent();
  });

  test('a reviewed note with a long opaque body uses that body for target selection and none produces no proposal', async () => {
    const readings = port({ target: 'none' }); installJudgmentPort(readings.port);
    const root = makeProjectTempDir('learning-curator-native-note');
    const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const notes = AgentNoteRegistry.fromShellPaths(paths);
    const full = 'ordinary '.repeat(300) + 'No reusable knowledge was established.';
    const note = notes.create({ title: 'memory routine persona', body: full }); notes.markReviewed(note.id);
    const collection = await buildLearningCandidates({ workspace: { shellPaths: paths } }, options());
    expect(collection.candidates.some(candidate => candidate.proposalTarget !== undefined)).toBe(false);
    const target = readings.requests.find(request => Object.hasOwn(request.questions, 'target'));
    expect(JSON.stringify(target?.state)).toContain(full);
  });
});


describe('planned native learning effects', () => {
  function local() {
    const root = makeProjectTempDir('learning-curator-planned-effects');
    const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const context = { workspace: { shellPaths: paths } };
    return { root, paths, context, source: acquireLearningCuratorSource(context, {}) };
  }
  const input = { name: ' Exact   recovery ', description: ' Verify the restore ', procedure: ' Restore the actual archive. ', tags: [' Recovery ', 'recovery'], triggers: [' restore '], enabled: false, source: 'agent' as const, provenance: 'curator-native-fixture' };

  test('the exact prepared native skill append advances only that source change', () => {
    const { source, paths } = local();
    const transition = source.prepareTransition({ kind: 'create', domain: 'skill', input });
    const created = AgentSkillRegistry.fromShellPaths(paths, transition.effects).create(input);
    expect(source.assertCurrent).toThrow(ToolInputProjectionError);
    transition.commit(created); source.assertCurrent(); transition.abort();
    expect(AgentSkillRegistry.fromShellPaths(paths).snapshot().skills.map(record => record.id)).toEqual([created.id]);
  });

  test('a simultaneous unrelated registry change cannot be adopted by successful self-write', () => {
    const { source, paths } = local();
    const transition = source.prepareTransition({ kind: 'create', domain: 'skill', input });
    const created = AgentSkillRegistry.fromShellPaths(paths, transition.effects).create(input);
    AgentPersonaRegistry.fromShellPaths(paths).create({ name: 'Other', description: 'An unrelated creation', body: 'Unrelated preferences.' });
    expect(() => transition.commit(created)).toThrow(ToolInputProjectionError);
    transition.abort(); expect(source.assertCurrent).toThrow(ToolInputProjectionError);
  });

  test('a byte change on the planned target cannot hide behind matching native records', () => {
    const { source, paths } = local();
    const transition = source.prepareTransition({ kind: 'create', domain: 'skill', input });
    const created = AgentSkillRegistry.fromShellPaths(paths, transition.effects).create(input);
    const path = AgentSkillRegistry.fromShellPaths(paths).snapshot().path;
    fs.appendFileSync(path, ' ');
    expect(() => transition.commit(created)).toThrow(ToolInputProjectionError);
    transition.abort(); expect(source.assertCurrent).toThrow(ToolInputProjectionError);
  });

  test('another candidate cannot reuse an original existing record after a planned update', async () => {
    const readings = port(); installJudgmentPort(readings.port);
    const root = makeProjectTempDir('learning-curator-original-record');
    const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const native = AgentSkillRegistry.fromShellPaths(paths).create(input);
    const context = { workspace: { shellPaths: paths } }, caller = options();
    const collection = await buildLearningCandidates(context, caller);
    const candidate = collection.candidates.find(candidate => candidate.recordId === native.id);
    if (!candidate) throw new Error('The actual original record candidate was not built');
    collection.assertCandidateCurrent(candidate);
    const update = { description: 'A changed native description.' };
    const transition = collection.prepareTransition({ kind: 'update', domain: 'skill', id: native.id, input: update });
    const updated = AgentSkillRegistry.fromShellPaths(paths, transition.effects).update(native.id, update);
    transition.commit(updated);
    assertLearningCandidateCollection(collection, context, caller);
    expect(() => collection.assertCandidateCurrent(candidate)).toThrow(ToolInputProjectionError);
  });

  test('caller callback identity changes are held before acquiring source', () => {
    const caller = { assertCurrent: () => {} };
    caller.assertCurrent = () => { caller.assertCurrent = () => {}; };
    expect(() => acquireLearningCuratorSource({}, caller)).toThrow(ToolInputProjectionError);
  });

  test('asynchronous caller guards hold and their native rejection is observed', () => {
    const caller = { assertCurrent: async () => { throw new Error('synthetic unsupported async guard'); } };
    expect(() => acquireLearningCuratorSource({}, caller)).toThrow(ToolInputProjectionError);
  });

  test('cancellation inside the original caller callback is checked after it returns', () => {
    const controller = new AbortController();
    expect(() => acquireLearningCuratorSource({}, { signal: controller.signal, assertCurrent: () => controller.abort() })).toThrow();
  });

  test('a changed judgment installation after settled composition retires the collection before effects', async () => {
    const readings = port(); installJudgmentPort(readings.port);
    const collection = await buildLearningCandidates({}, options());
    installJudgmentPort(port().port);
    expect(collection.assertCurrent).toThrow();
  });

  test('a retained native evidence guard does not call back into the original publication map', () => {
    const retained = new Map<string | (() => void), () => void>();
    let visits = 0;
    const caller = { assertCurrent: () => { visits++; for (const guard of retained.values()) guard(); }, retainCurrent: (guard: () => void, key?: string) => { retained.set(key ?? guard, guard); } };
    const source = acquireLearningCuratorSource({}, caller);
    source.assertCurrent(); expect(visits).toBeGreaterThan(0); expect(visits).toBeLessThan(20);
  });

  test('a forged collection or another original options object cannot authorize effects', async () => {
    const readings = port(); installJudgmentPort(readings.port);
    const context = {}, caller = options();
    const collection = await buildLearningCandidates(context, caller);
    assertLearningCandidateCollection(collection, context, caller);
    expect(() => assertLearningCandidateCollection({ ...collection, assertCurrent: () => {} }, context, caller)).toThrow(ToolInputProjectionError);
    expect(() => assertLearningCandidateCollection(collection, context, { ...caller })).toThrow(ToolInputProjectionError);
  });
});


describe('native learning capture clock representation', () => {
  const epoch = 1_760_000_000_008;
  const instant = '2025-10-09T08:53:20.008Z';

  test('a generated capture clock with card-shaped digits reaches the actual canonical composition', async () => {
    expect(judgmentInputCardProblem({ capturedAt: epoch })).toBe('card-material');
    const root = makeProjectTempDir('learning-capture-clock');
    const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const notes = AgentNoteRegistry.fromShellPaths(paths);
    const body = 'Restore in isolation, verify every original row, then switch traffic.';
    const note = notes.create({ title: 'Native restore clock control', body }); notes.markReviewed(note.id);
    const scripted = port({ target: 'skill' });
    const canonicalQuestions = new Map(Object.entries(learningCuratorScore.items).map(([name, item]) => [name, item.question]));
    const exact: JudgmentPort = { model: scripted.port.model, ask(request) {
      const entries = Object.entries(request.questions);
      const exactQuestion = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
      if (request.context?.battery === learningProposalTarget.name) {
        if (entries.length !== 1 || !exactQuestion(request.questions.target, learningProposalTarget.items.target.question)) throw new Error('Unexpected capture-clock target schema');
      } else if (request.context?.battery === learningCuratorScore.name) {
        if (entries.length !== canonicalQuestions.size || entries.some(([name, question]) => !canonicalQuestions.has(name) || !exactQuestion(question, canonicalQuestions.get(name)))) throw new Error('Unexpected capture-clock grade schema');
      } else throw new Error('Unexpected capture-clock decision site');
      if (!JSON.stringify(request.state).includes(body)) throw new Error('Missing complete original note body');
      return scripted.port.ask(request);
    } };
    installJudgmentPort(exact);
    const pending = (() => {
      const clock = spyOn(Date, 'now').mockReturnValue(epoch);
      try { return buildLearningCandidates({ workspace: { shellPaths: paths } }, options()); }
      finally { clock.mockRestore(); }
    })();
    const collection = await pending;
    expect(collection.candidates.some(value => value.proposalTarget === 'skill' && value.recordId === note.id && value.proposalFields?.body === body)).toBe(true);
    const grades = scripted.requests.filter(request => request.context?.battery === learningCuratorScore.name);
    expect(grades).toHaveLength(1);
    for (const request of grades) {
      const state = request.state;
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Unexpected captured grade state');
      expect(state.capturedAt).toBe(instant);
    }
    collection.assertCurrent();
  });

  test.each(['number', 'string'] as const)('an unknown borrowed capture-clock $s still refuses before a reading', async shape => {
    const readings = port(); installJudgmentPort(readings.port);
    const original = { ...nativeMemory('opaque-clock', 'Unknown captured clock'), opaque: { capturedAt: shape === 'number' ? epoch : String(epoch) } };
    const pending = (() => {
      const clock = spyOn(Date, 'now').mockReturnValue(epoch);
      try { return buildLearningCandidates({ clients: { agentKnowledgeApi: { memory: { getAll: () => [original] } } } }, options()); }
      finally { clock.mockRestore(); }
    })();
    await expect(pending).rejects.toMatchObject({ problem: 'card-material' });
    expect(readings.requests).toHaveLength(0);
    expect(original.opaque.capturedAt).toBe(shape === 'number' ? epoch : String(epoch));
  });

  test('the immutable reading clock preserves native evidence retirement', () => {
    const original = nativeMemory('native-clock-custody', 'Original clock custody evidence');
    const clock = spyOn(Date, 'now').mockReturnValue(epoch);
    const source = (() => {
      try { return acquireLearningCuratorSource({ clients: { agentKnowledgeApi: { memory: { getAll: () => [original] } } } }, options()); }
      finally { clock.mockRestore(); }
    })();
    expect(source.source.capturedAt).toBe(instant);
    expect(Object.isFrozen(source.source)).toBe(true);
    expect(Reflect.set(source.source, 'capturedAt', '2025-10-09T08:53:20.009Z')).toBe(false);
    expect(source.source.capturedAt).toBe(instant);
    source.assertCurrent();
    original.detail = 'Unrelated replacement of the original durable evidence.';
    expect(source.assertCurrent).toThrow(ToolInputProjectionError);
  });
});
