import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { ProcessManager, ToolRegistry, ToolInputProjectionError, type BackgroundProcess } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { MemoryRecord } from '@goodvibes-jev/engine/sdk/platform/state';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { createAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { autonomyQueueCatalogStatus, autonomyQueueSummary, describeAutonomyQueueItem } from '../../tools/agent-harness-autonomy-queue.ts';
import { learningCuratorSummary, describeLearningCandidate } from '../../tools/agent-harness-learning-curator.ts';
import { backgroundProcessSummary, describeBackgroundProcess, runBackgroundProcessAction } from '../../tools/agent-harness-background-processes.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner, researchScreeningFixture, exactSensitiveSpans } from '../helpers/research-screening.ts';

class CatalogProcessFixture extends ProcessManager {
  readonly records: BackgroundProcess[] = [
    { id: 'lexical-mail', pid: 101, cmd: 'mail', startTime: Date.now(), stdout: [], stderr: [], exitCode: null, done: false, killDeadline: null },
    { id: 'opaque-worker', pid: 102, cmd: 'unrelated-worker', startTime: Date.now(), stdout: [], stderr: [], exitCode: null, done: false, killDeadline: null },
  ];
  override list() { return this.records.map(entry => ({ id: entry.id, pid: entry.pid, cmd: entry.cmd, status: entry.done ? 'completed' : 'running', done: entry.done })); }
  override getStatus(id: string) { return this.records.find(entry => entry.id === id); }
  override getOutput(id: string) { const record = this.getStatus(id); return record ? { stdout: record.stdout.join(''), stderr: record.stderr.join('') } : undefined; }
}

function memory(id: string, summary: string): MemoryRecord {
  return { id, scope: 'project', cls: 'fact', summary, detail: 'A synthetic record used for catalog admission.', tags: [], provenance: [], reviewState: 'fresh', confidence: 92, createdAt: Date.now(), updatedAt: Date.now() };
}

function fixture() {
  const manager = new CatalogProcessFixture();
  const memories = [memory('lexical-mail', 'mail'), memory('opaque-lesson', 'A different subject')];
  const context = { extensions: {}, clients: { agentKnowledgeApi: { memory: { getAll: () => memories } } }, workspace: { processManager: manager }, platform: { config: {} }, ops: {}, session: { runtime: { sessionId: 'semantic-records' } } } as unknown as CommandContext;
  return { context, manager, memories };
}

function readings(fits: Readonly<Record<string, number>>) {
  return fakePort((name, _question, state) => {
    if (name !== 'match') throw new Error(`Unexpected catalog reading ${name}`);
    const candidate = (state as unknown as { candidate: { name: string } }).candidate;
    return noulAnswer(fits[candidate.name] ?? 0.01);
  });
}
const options = () => ({ sourceOwner: ordinaryResearchOwner() });
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
afterAll(cleanupResearchScreeningFixtures);

const cases = [
  { kind: 'autonomy', chosen: 'research-runs', field: 'queue', id: 'queueItemId', summary: autonomyQueueSummary, detail: describeAutonomyQueueItem },
  { kind: 'learning', chosen: 'memory:opaque-lesson:needs-review', field: 'candidates', id: 'candidateId', summary: learningCuratorSummary, detail: describeLearningCandidate },
  { kind: 'process', chosen: 'opaque-worker', field: 'processes', id: 'processId', summary: backgroundProcessSummary, detail: describeBackgroundProcess },
] as const;

describe('canonical semantic record catalogs', () => {
  test('watcher startup counts use native facts without reading producer prose', () => {
    const f = fixture(), baseline = autonomyQueueCatalogStatus(f.context);
    const watcher = { runId: 'fixture-run', status: 'running', outputPreview: 'Synthetic watcher output' };
    const context: CommandContext = { ...f.context, platform: { ...f.context.platform, readModels: { watchers: { runs: [watcher] } } } };
    expect(autonomyQueueCatalogStatus(context).active).toBe(Number(baseline.active) + 1);
    watcher.status = 'failed';
    expect(autonomyQueueCatalogStatus(context).attention).toBe(Number(baseline.attention) + 1);
    watcher.status = 'The watcher is currently running according to this prose.';
    expect(autonomyQueueCatalogStatus(context).active).toBe(baseline.active);
  });

  test('literal queue reads await complete watcher privacy and retain producer source through publication', async () => {
    const f = fixture(), watcher = { runId: 'fixture-run', status: 'running', outputPreview: 'Complete synthetic watcher output' };
    const context: CommandContext = { ...f.context, platform: { ...f.context.platform, readModels: { watchers: { runs: [watcher] } } } };
    const fake = fakePort((_name, question) => question.type === 'choice' ? choiceAnswer(question, 'other', 0.999) : noulAnswer(0.001));
    installJudgmentPort(fake.port);
    const guards: (() => void)[] = [];
    const result = await autonomyQueueSummary(context, {}, { retainCurrent(guard) { guards.push(guard); } });
    expect(result.queue).toContainEqual(expect.objectContaining({ queueItemId: 'automation-runs', status: 'active', liveRecords: expect.any(Array) }));
    expect(fake.requests.length).toBeGreaterThan(0);
    const questions = fake.requests.length;
    for (const guard of guards) guard();
    expect(fake.requests).toHaveLength(questions);
    watcher.outputPreview = 'A competing native update';
    expect(() => { for (const guard of guards) guard(); }).toThrow(ToolInputProjectionError);
  });

  test('a watcher changing during whole DTO privacy cannot publish an old literal queue', async () => {
    const f = fixture(), watcher = { runId: 'fixture-run', status: 'running', outputPreview: 'Initial synthetic watcher output' };
    const context: CommandContext = { ...f.context, platform: { ...f.context.platform, readModels: { watchers: { runs: [watcher] } } } };
    const fake = fakePort((_name, question) => question.type === 'choice' ? choiceAnswer(question, 'other', 0.999) : noulAnswer(0.001));
    installJudgmentPort({ ...fake.port, async ask(request) {
      const answer = await fake.port.ask(request);
      watcher.outputPreview = 'Changed while privacy was pending';
      return answer;
    } });
    await expect(autonomyQueueSummary(context, {})).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  for (const entry of cases) {
    test(`${entry.kind} reads every candidate before applying the limit and permits counter-lexical results`, async () => {
      const f = fixture(), fake = readings({ [entry.chosen]: 0.99 }); installJudgmentPort(fake.port);
      const all = await entry.summary(f.context, {});
      const expectedTotal = Number(all.total);
      const result = await entry.summary(f.context, { query: 'mail', limit: 1 }, options());
      expect(result[entry.field]).toMatchObject([{ [entry.id]: entry.chosen, judgment: { reading: { verdict: 'yes' } } }]);
      expect(result.total).toBe(expectedTotal);
      expect(fake.requests).toHaveLength(expectedTotal);
      expect(fake.requests.every(request => request.context?.battery === 'engine.tools.registry-rank')).toBe(true);
      expect(new Set(fake.requests.map(request => (request.state as unknown as { candidate: { name: string } }).candidate.name)).size).toBe(expectedTotal);
      const detail = await entry.detail(f.context, { query: 'mail' }, options());
      expect(detail.status).toBe('found');
    });

    test(`${entry.kind} keeps one uncertain candidate visible and ambiguous`, async () => {
      const f = fixture(); installJudgmentPort(readings({ [entry.chosen]: 0.5 }).port);
      const result = await entry.summary(f.context, { query: 'mail' }, options());
      expect(result[entry.field]).toMatchObject([{ [entry.id]: entry.chosen, judgment: { reading: { verdict: 'uncertain' } } }]);
      const detail = await entry.detail(f.context, { query: 'mail' }, options());
      expect(detail).toMatchObject({ status: 'ambiguous', candidates: [{ [entry.id]: entry.chosen }] });
    });

    test(`${entry.kind} holds a yes reading whose disposition is still unresolved`, async () => {
      const f = fixture(); installJudgmentPort(readings({ [entry.chosen]: 0.575 }).port);
      const result = await entry.summary(f.context, { query: 'mail' }, options());
      expect(result[entry.field]).toMatchObject([{ [entry.id]: entry.chosen, judgment: { reading: { verdict: 'yes', outcome: 'confirm' } } }]);
      expect(await entry.detail(f.context, { query: 'mail' }, options())).toMatchObject({ status: 'ambiguous', candidates: [{ [entry.id]: entry.chosen }] });
    });

    test(`${entry.kind} refuses an unavailable reader while exact IDs and no-query catalogs remain deterministic`, async () => {
      const f = fixture();
      await expect(entry.summary(f.context, { query: 'mail' }, options())).rejects.toBeInstanceOf(JudgmentPortMissingError);
      expect((await entry.summary(f.context, {})).total).toBeGreaterThan(0);
      expect((await entry.detail(f.context, { [entry.id]: entry.chosen })).status).toBe('found');
      expect((await entry.detail(f.context, { [entry.id]: 'unknown-id' })).status).toBe('missing_lookup');
    });

    test(`${entry.kind} does not fall back to a lexical match after negative readings`, async () => {
      const f = fixture(); installJudgmentPort(readings({}).port);
      const result = await entry.summary(f.context, { query: 'mail' }, options());
      expect(result[entry.field]).toEqual([]);
      expect(result.total).toBeGreaterThan(0);
      if (entry.kind === 'process') expect(result.summary).toMatchObject({ tracked: 2, running: 2 });
      expect((await entry.detail(f.context, { query: 'mail' }, options())).status).toBe('missing_lookup');
    });
  }

  test('the actual harness dispatch retains source guards through final catalog publication', async () => {
    const f = fixture(), registry = new ToolRegistry();
    bindAgentResearchSourceOwner(registry, ordinaryResearchOwner());
    const harness = createAgentHarnessTool({ commandContext: f.context, commandRegistry: new CommandRegistry(), toolRegistry: registry });
    for (const [mode, chosen, field, id] of [
      ['autonomy_queue', 'research-runs', 'queue', 'queueItemId'],
      ['learning_curator', 'memory:opaque-lesson:needs-review', 'candidates', 'candidateId'],
      ['background_processes', 'opaque-worker', 'processes', 'processId'],
    ] as const) {
      installJudgmentPort(readings({ [chosen]: 0.99 }).port);
      const result = await harness.execute({ mode, query: 'mail', limit: 1 });
      expect(result.success, result.error).toBe(true);
      const page = JSON.parse(String(result.output));
      expect(page[field]).toMatchObject([{ [id]: chosen }]);
    }
  });

  test('process read actions use the same semantic selection and preserve explicit-ID grammar', async () => {
    const f = fixture(); installJudgmentPort(readings({ 'opaque-worker': 0.99 }).port);
    expect(await runBackgroundProcessAction(f.context, { action: 'status', query: 'mail' }, options())).toMatchObject({ processId: 'opaque-worker' });
    expect(await runBackgroundProcessAction(f.context, { action: 'list', query: 'mail' }, options())).toMatchObject({ processes: [{ processId: 'opaque-worker' }] });
    expect(await describeBackgroundProcess(f.context, { processId: 'opaque' }, options())).toMatchObject({ status: 'missing_lookup' });
  });

  test('a process disappearing while its reading is pending cannot publish its stale detail', async () => {
    const f = fixture(), fake = readings({ 'opaque-worker': 0.99 });
    installJudgmentPort({ ...fake.port, ask: async request => {
      const result = await fake.port.ask(request);
      f.manager.records.splice(1, 1);
      return result;
    } });
    await expect(describeBackgroundProcess(f.context, { query: 'mail' }, options())).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  test('a changed learning collection invalidates the pending selection', async () => {
    const f = fixture(), fake = readings({ 'memory:opaque-lesson:needs-review': 0.99 });
    installJudgmentPort({ ...fake.port, ask: async request => {
      const result = await fake.port.ask(request);
      f.memories[1]!.reviewState = 'reviewed';
      return result;
    } });
    await expect(describeLearningCandidate(f.context, { query: 'mail' }, options())).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  test('cancellation after a reading does not publish a selected process', async () => {
    const f = fixture(), fake = readings({ 'opaque-worker': 0.99 }), controller = new AbortController();
    installJudgmentPort({ ...fake.port, ask: async request => { const result = await fake.port.ask(request); controller.abort(); return result; } });
    await expect(backgroundProcessSummary(f.context, { query: 'mail' }, { ...options(), signal: controller.signal })).rejects.toThrow();
  });

  test('literal process lists retain their source snapshot through the publication handoff without readings', async () => {
    const f = fixture(), guards: (() => void)[] = [];
    const result = await backgroundProcessSummary(f.context, {}, { retainCurrent: guard => { guards.push(guard); } });
    expect(result.returned).toBe(2);
    expect(guards.length).toBeGreaterThan(0);
    for (const guard of guards) guard();
    f.manager.records.splice(1, 1);
    expect(() => { for (const guard of guards) guard(); }).toThrow(ToolInputProjectionError);
  });

  test('an exact process detail retains its own record across publication without consulting judgment', async () => {
    const f = fixture(), guards: (() => void)[] = [];
    expect(await describeBackgroundProcess(f.context, { processId: 'opaque-worker' }, { retainCurrent: guard => { guards.push(guard); } })).toMatchObject({ status: 'found' });
    f.manager.records[1]!.done = true;
    expect(() => { for (const guard of guards) guard(); }).toThrow(ToolInputProjectionError);
  });

  test('redacted full process source holds before hosted selection or original-value publication', async () => {
    const f = fixture(), fake = readings({ 'opaque-worker': 0.99 });
    f.manager.records[1]!.cmd = 'synthetic-sensitive-record';
    const screening = researchScreeningFixture({ spans: exactSensitiveSpans(['synthetic-sensitive-record']) });
    installJudgmentPort(fake.port);
    await expect(backgroundProcessSummary(f.context, { query: 'mail' }, { sourceOwner: screening.owner })).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(fake.requests).toHaveLength(0);
  });
});
