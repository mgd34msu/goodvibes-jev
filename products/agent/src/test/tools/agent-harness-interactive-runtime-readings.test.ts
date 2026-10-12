import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { SandboxSessionRegistry } from '@goodvibes-jev/engine/sdk/platform/runtime/sandbox';
import { ToolInputProjectionError, ToolRegistry, ProcessManager, type BackgroundProcess } from '@goodvibes-jev/engine/sdk/platform/tools';
import { FileUndoManager } from '@goodvibes-jev/engine/sdk/platform/state';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { CommandContext } from '../../input/command-registry.ts';
import { acquireInteractiveRuntimeSnapshot } from '../../tools/agent-harness-interactive-runtime-records.ts';
import { captureBrowserControlPosture } from '../../tools/agent-harness-browser-control.ts';
import { backgroundProcessSummary } from '../../tools/agent-harness-background-processes.ts';
import { executionPostureSummary, describeHarnessExecutionRoute } from '../../tools/agent-harness-execution-posture.ts';
import type { CatalogRankingOptions } from '../../tools/agent-harness-catalog-ranking.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';

let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previousPort = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previousPort); });
afterAll(cleanupResearchScreeningFixtures);

function runtimeContext(records: readonly Record<string, unknown>[]) {
  const publisher = { getSnapshot: () => ({ sessions: records }) };
  const platform: CommandContext['platform'] = {
    get config(): never { throw new Error('Runtime metadata read config'); },
    get configManager(): never { throw new Error('Runtime metadata read config manager'); },
  };
  const readModels = { execution: { ptySessions: publisher } };
  Object.defineProperty(platform, 'readModels', { value: readModels, enumerable: true, configurable: true });
  const registry = new ToolRegistry();
  const context: CommandContext = {
    platform, clients: {}, extensions: { toolRegistry: registry, mcpRegistry: new McpRegistry({
      hookDispatcher: { fire: async () => { throw new Error('MCP hooks must not run in a metadata fixture.'); } },
      sandboxSessions: new SandboxSessionRegistry('/synthetic/interactive-runtime-readings'),
    }) },
    renderRequest: () => { throw new Error('Runtime metadata rendered'); },
    print: () => { throw new Error('Runtime metadata printed'); },
    exit: () => { throw new Error('Runtime metadata exited'); },
    get session(): never { throw new Error('Runtime metadata read session'); },
    get provider(): never { throw new Error('Runtime metadata read provider'); },
    get workspace(): never { throw new Error('Runtime metadata read workspace'); },
    get ops(): never { throw new Error('Runtime metadata read ops'); },
  };
  return { context, registry, publisher, readModels };
}

function processRuntimeContext(records: readonly Record<string, unknown>[], workspace: CommandContext['workspace']) {
  const fixture = runtimeContext(records);
  Object.defineProperty(fixture.context, 'workspace', { value: workspace, enumerable: true, configurable: true });
  return fixture;
}

function executionRuntimeContext(records: readonly Record<string, unknown>[], workspace: CommandContext['workspace']) {
  const fixture = processRuntimeContext(records, workspace);
  const session: CommandContext['session'] = {
    runtime: { model: 'synthetic-model', provider: 'synthetic-provider', debugMode: false, systemPrompt: '', reasoningEffort: '', sessionId: 'synthetic-runtime-session' },
    get conversationManager(): never { throw new Error('Runtime metadata read conversations'); },
  };
  Object.defineProperty(fixture.context, 'session', { value: session, enumerable: true, configurable: true });
  return fixture;
}

function record() {
  return { id: 'native-session', kind: 'desktop-receipt-looking-name', description: 'Published process output record.',
    status: 'publisher describes the process as currently active', schemaStatus: 'publisher certifies the current schema',
    publisher: 'synthetic-host', publicationGuarantee: 'native durable publication',
    routes: { observe: { route: 'process action:output', description: 'Read process output.' },
      inspect: { route: 'process action:prompt', description: 'Host-mediated administrator credential prompt.' } },
    rawSecretReturned: false, rawValueReturned: 'publisher reports no raw credential return',
    outputChunks: [{ text: 'published output', truncated: 'publisher reports the chunk is complete' }],
    publicationDetails: 'x'.repeat(700),
  };
}

function runtimeReadings(status = 'running', schema = 0.999) {
  return fakePort((name, question, state) => {
    if (question.type === 'noul') return noulAnswer(schema);
    if (question.type !== 'choice') throw new Error('Unexpected runtime reading question');
    if (Object.hasOwn(question.criteria, 'pty-session')) return choiceAnswer(question, 'process-output', 0.999);
    if (Object.hasOwn(question.criteria, 'ready')) return choiceAnswer(question, status, 0.999);
    if (Object.hasOwn(question.criteria, 'credential')) {
      if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.key !== 'string') throw new Error('Route key missing');
      return choiceAnswer(question, state.key === 'observe' ? 'log' : state.key === 'inspect' ? 'credential' : 'none', 0.999);
    }
    if (Object.hasOwn(question.criteria, 'neither')) return choiceAnswer(question, 'false', 0.999);
    // The native recorder's privacy field-name reading is ancillary to the runtime decision.
    if (name === 'kind' && Object.hasOwn(question.criteria, 'other')) return choiceAnswer(question, 'other', 0.999);
    throw new Error('Unexpected runtime reading');
  });
}

describe('actual published interactive-runtime readings', () => {
  test('record context overrides kind/name fallbacks and route effects follow recorded roles', async () => {
    const published = record(), { context } = runtimeContext([published]);
    const fake = runtimeReadings(); installJudgmentPort(fake.port);
    const snapshot = await acquireInteractiveRuntimeSnapshot(context, { sourceOwner: ordinaryResearchOwner() });
    expect(snapshot.records[0]).toMatchObject({ id: 'native-session', kind: 'process-output', status: 'running',
      outputChunks: [{ truncated: false }], certification: { schemaStatus: 'certified' } });
    expect(snapshot.records[0]?.routes).toEqual([
      { id: 'log', label: 'Read output', modelRoute: 'process action:output', effect: 'read-only' },
      { id: 'credential', label: 'Mediated credential prompt', modelRoute: 'process action:prompt', effect: 'confirmed-admin' },
    ]);
    expect(snapshot.parityStatus.ptyContract).toBe(false);
    const kindRequest = fake.requests.find(request => request.context?.battery === 'agent.runtime.kind');
    expect(kindRequest?.state).toMatchObject({ source: 'context.platform.readModels.execution.ptySessions', containerPath: ['sessions', '0'],
      snapshot: { sessions: [published] }, record: published });
    snapshot.assertCurrent();
  });

  test('unknown status and an uncertified schema cannot establish runtime parity', async () => {
    const { context } = runtimeContext([record()]);
    installJudgmentPort(runtimeReadings('unknown').port);
    const unknown = await acquireInteractiveRuntimeSnapshot(context, { sourceOwner: ordinaryResearchOwner() });
    expect(unknown.capabilitySummary.certifiedRecordCount).toBe(0);
    expect(unknown.parityStatus).toMatchObject({ stdinWriteContract: false, ptyContract: false, sudoMediationContract: false, browserDesktopControlContract: false });
    installJudgmentPort(runtimeReadings('running', 0.001).port);
    const legacy = await acquireInteractiveRuntimeSnapshot(context, { sourceOwner: ordinaryResearchOwner() });
    expect(legacy.records[0]?.certification.schemaStatus).toBe('legacy');
    expect(legacy.capabilitySummary.certifiedRecordCount).toBe(0);
  });

  test('a published record holds without an approved owner or installed reader', async () => {
    const { context } = runtimeContext([record()]);
    await expect(acquireInteractiveRuntimeSnapshot(context)).rejects.toBeInstanceOf(ToolInputProjectionError);
    await expect(acquireInteractiveRuntimeSnapshot(context, { sourceOwner: ordinaryResearchOwner() })).rejects.toBeInstanceOf(JudgmentPortMissingError);
    const simple = runtimeContext([]);
    // A native publisher returning an empty catalog still has a protected publication contract.
    await expect(acquireInteractiveRuntimeSnapshot(simple.context, { sourceOwner: ordinaryResearchOwner(), assertCurrent: () => { throw new ToolInputProjectionError('held'); } })).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  for (const retirement of ['cancelled', 'caller-retired', 'source-changed', 'publisher-replaced', 'publisher-accessor', 'reader-retired'] as const) {
    test(`a pending kind interpretation cannot publish after ${retirement}`, async () => {
      const published = record(), { context, publisher } = runtimeContext([published]);
      const fake = runtimeReadings(), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
      const controller = new AbortController(); let retired = false;
      const reason = new ToolInputProjectionError('held'); let accessorReads = 0;
      installJudgmentPort({ ...fake.port, async ask(request) {
        if (request.context?.battery === 'agent.runtime.kind') { entered.resolve(); await released.promise; }
        return fake.port.ask(request);
      } });
      const outcome = acquireInteractiveRuntimeSnapshot(context, { sourceOwner: ordinaryResearchOwner(), signal: controller.signal,
        assertCurrent() { if (retired) throw reason; } }).then(value => ({ kind: 'returned' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }));
      try {
        const first = await Promise.race([entered.promise.then(() => 'entered' as const), outcome]);
        if (first !== 'entered') throw new Error('Runtime reading ended before the pending kind seam');
        if (retirement === 'cancelled') controller.abort(reason);
        else if (retirement === 'caller-retired') retired = true;
        else if (retirement === 'source-changed') published.publicationDetails = 'x'.repeat(699) + 'changed';
        else if (retirement === 'publisher-replaced') publisher.getSnapshot = () => ({ sessions: [] });
        else if (retirement === 'publisher-accessor') Object.defineProperty(publisher, 'getSnapshot', { configurable: true, get() { accessorReads++; return () => ({ sessions: [] }); } });
        else installJudgmentPort(runtimeReadings().port);
        released.resolve();
        expect((await outcome).kind).toBe('rejected');
        expect(accessorReads).toBe(0);
      } finally { released.resolve(); await outcome; }
    });
  }

  test('a retained browser posture checks the original publication without rereading semantic metadata', async () => {
    const published = record(), { context, registry } = runtimeContext([published]);
    const fake = runtimeReadings(); installJudgmentPort(fake.port);
    const acquired = await captureBrowserControlPosture(context, registry, { sourceOwner: ordinaryResearchOwner() });
    const requestsBefore = fake.requests.length;
    acquired.assertCurrent(); acquired.assertSourceCurrent();
    expect(fake.requests.length).toBe(requestsBefore);
    published.description = 'Publication retired after browser posture acquisition';
    expect(() => acquired.assertSourceCurrent()).toThrow(ToolInputProjectionError);
    expect(fake.requests.length).toBe(requestsBefore);
  });
});

class DeferredProcessFixture extends ProcessManager {
  readonly records: BackgroundProcess[] = [{ id: 'native-process', pid: 301, cmd: 'synthetic command', startTime: Date.now(),
    stdout: [], stderr: [], exitCode: null, done: false, killDeadline: null }];
  override list() { return this.records.map(entry => ({ id: entry.id, pid: entry.pid, cmd: entry.cmd, status: entry.done ? 'completed' : 'running', done: entry.done })); }
  override getStatus(id: string) { return this.records.find(entry => entry.id === id); }
  override getOutput(id: string) { const entry = this.getStatus(id); return entry ? { stdout: entry.stdout.join(''), stderr: entry.stderr.join('') } : undefined; }
}

function pendingRuntimeKind() {
  const fake = runtimeReadings(), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  installJudgmentPort({ ...fake.port, async ask(request) {
    if (request.context?.battery === 'agent.runtime.kind') { entered.resolve(); await released.promise; }
    return fake.port.ask(request);
  } });
  return { entered, released };
}

describe('native publication guards before and after deferred capability reads', () => {
  for (const change of ['live', 'process-finished', 'manager-replaced'] as const) {
    test(`the exported process summary retains its actual selection after ${change}`, async () => {
      const manager = new DeferredProcessFixture(), workspace: CommandContext['workspace'] = { processManager: manager };
      const replacement = new DeferredProcessFixture();
      const { context } = processRuntimeContext([record()], workspace), pending = pendingRuntimeKind();
      // Deliberately no retainCurrent hook: this public helper must retain its own selected source.
      const outcome = backgroundProcessSummary(context, {}, { sourceOwner: ordinaryResearchOwner() })
        .then(value => ({ kind: 'returned' as const, value }), (error: unknown) => ({ kind: 'rejected' as const, error }));
      try {
        const first = await Promise.race([pending.entered.promise.then(() => 'entered' as const), outcome]);
        if (first !== 'entered') throw new Error('Process summary ended before its deferred capability read');
        if (change === 'process-finished') { manager.records[0]!.done = true; manager.records[0]!.exitCode = 0; }
        else if (change === 'manager-replaced') workspace.processManager = replacement;
        pending.released.resolve();
        const result = await outcome;
        if (change === 'live') {
          if (result.kind !== 'returned') throw result.error;
          expect(result.value.processes).toMatchObject([{ processId: 'native-process', pid: 301, status: 'running', done: false }]);
        } else {
          if (result.kind !== 'rejected') throw new Error('Changed process source published its earlier DTO');
          expect(result.error).toBeInstanceOf(ToolInputProjectionError);
        }
      } finally { pending.released.resolve(); await outcome; await manager.close(); await replacement.close(); }
    });
  }

  for (const change of ['live', 'registry-accessor'] as const) {
    test(`the exported browser acquisition checks original methods before projection after ${change}`, async () => {
      const { context, registry } = runtimeContext([record()]), pending = pendingRuntimeKind(); let accessorReads = 0;
      const definitions = registry.getToolDefinitions;
      const outcome = captureBrowserControlPosture(context, registry, { sourceOwner: ordinaryResearchOwner() })
        .then(value => ({ kind: 'returned' as const, value }), (error: unknown) => ({ kind: 'rejected' as const, error }));
      try {
        const first = await Promise.race([pending.entered.promise.then(() => 'entered' as const), outcome]);
        if (first !== 'entered') throw new Error('Browser acquisition ended before its deferred runtime read');
        if (change === 'registry-accessor') Object.defineProperty(registry, 'getToolDefinitions', { configurable: true,
          get() { accessorReads++; return definitions; } });
        pending.released.resolve();
        const result = await outcome;
        if (change === 'live') {
          if (result.kind !== 'returned') throw result.error;
          expect(result.value.posture.configured).toBe(false);
        } else {
          if (result.kind !== 'rejected') throw new Error('Changed registry published a browser posture');
          expect(result.error).toBeInstanceOf(ToolInputProjectionError);
        }
        expect(accessorReads).toBe(0);
      } finally { pending.released.resolve(); await outcome; }
    });
  }

  for (const helper of ['summary', 'route'] as const) {
    for (const change of ['live', 'session-accessor', 'file-undo-accessor'] as const) {
      test(`the exported execution ${helper} checks its original backend before projection after ${change}`, async () => {
        const undo = new FileUndoManager(), { context, registry } = executionRuntimeContext([record()], { fileUndoManager: undo });
        const pending = pendingRuntimeKind(); let accessorReads = 0;
        const runtime = context.session.runtime, peekUndo = undo.peekUndo;
        const reading = helper === 'summary'
          ? executionPostureSummary(context, registry, {}, { sourceOwner: ordinaryResearchOwner() })
          : describeHarnessExecutionRoute(context, registry, { executionRouteId: 'local-shell-command' }, { sourceOwner: ordinaryResearchOwner() });
        const outcome = reading.then(value => ({ kind: 'returned' as const, value }), (error: unknown) => ({ kind: 'rejected' as const, error }));
        try {
          const first = await Promise.race([pending.entered.promise.then(() => 'entered' as const), outcome]);
          if (first !== 'entered') throw new Error('Execution projection ended before its deferred browser acquisition');
          if (change === 'session-accessor') Object.defineProperty(context.session, 'runtime', { configurable: true,
            get() { accessorReads++; return runtime; } });
          else if (change === 'file-undo-accessor') Object.defineProperty(undo, 'peekUndo', { configurable: true,
            get() { accessorReads++; return peekUndo; } });
          pending.released.resolve();
          const result = await outcome;
          if (change === 'live') {
            if (result.kind !== 'returned') throw result.error;
            expect(result.value).toMatchObject({ status: helper === 'summary' ? 'available' : 'found' });
          } else {
            if (result.kind !== 'rejected') throw new Error('Changed execution backend published a projection');
            expect(result.error).toBeInstanceOf(ToolInputProjectionError);
          }
          expect(accessorReads).toBe(0);
        } finally { pending.released.resolve(); await outcome; }
      });
    }
  }
});

describe('original browser retainer dispatch through deferred runtime reads', () => {
  for (const change of ['live', 'retainer-accessor', 'callback-mutates-retainer', 'nonvoid-retainer'] as const) {
    test(`the direct browser helper retains its original callback boundary after ${change}`, async () => {
      const { context, registry } = runtimeContext([record()]), pending = pendingRuntimeKind();
      const guards = new Set<() => void>(); let armed = false, accessorReads = 0, lateRetainerCalls = 0;
      const retainer: NonNullable<CatalogRankingOptions['retainCurrent']> = guard => {
        guards.add(guard);
        if (!armed) return;
        lateRetainerCalls++;
        if (change === 'callback-mutates-retainer') Object.defineProperty(options, 'retainCurrent', {
          configurable: true, get() { accessorReads++; return retainer; },
        });
        if (change === 'nonvoid-retainer') return Promise.resolve();
      };
      const options: CatalogRankingOptions = { sourceOwner: ordinaryResearchOwner(), retainCurrent: retainer };
      const outcome = captureBrowserControlPosture(context, registry, options)
        .then(value => ({ kind: 'returned' as const, value }), (error: unknown) => ({ kind: 'rejected' as const, error }));
      try {
        const first = await Promise.race([pending.entered.promise.then(() => 'entered' as const), outcome]);
        if (first !== 'entered') throw new Error('Browser retainer control ended before its deferred runtime read');
        armed = true;
        if (change === 'retainer-accessor') Object.defineProperty(options, 'retainCurrent', {
          configurable: true, get() { accessorReads++; return retainer; },
        });
        pending.released.resolve();
        const result = await outcome;
        if (change === 'live') {
          if (result.kind !== 'returned') throw result.error;
          expect(result.value.posture.configured).toBe(false);
          expect(lateRetainerCalls).toBeGreaterThan(0);
          for (const guard of guards) guard();
          result.value.assertSourceCurrent();
        } else {
          if (result.kind !== 'rejected') throw new Error('Retired or asynchronous retainer published a browser posture');
          expect(result.error).toBeInstanceOf(ToolInputProjectionError);
          if (change === 'retainer-accessor') expect(lateRetainerCalls).toBe(0);
          else expect(lateRetainerCalls).toBeGreaterThan(0);
        }
        expect(accessorReads).toBe(0);
      } finally { pending.released.resolve(); await outcome; }
    });
  }
});

describe('acquired browser currentness callback lifetime', () => {
  for (const change of ['live', 'current-accessor', 'callback-mutates-current', 'nonvoid-current'] as const) {
    test(`the returned browser guard checks its captured currentness callback after ${change}`, async () => {
      const { context, registry } = runtimeContext([record()]);
      installJudgmentPort(runtimeReadings().port);
      let armed = false, accessorReads = 0, lateCurrentCalls = 0;
      const current: NonNullable<CatalogRankingOptions['assertCurrent']> = () => {
        if (!armed) return;
        lateCurrentCalls++;
        if (change === 'callback-mutates-current') Object.defineProperty(options, 'assertCurrent', {
          configurable: true, get() { accessorReads++; return current; },
        });
        if (change === 'nonvoid-current') return Promise.resolve();
      };
      const options: CatalogRankingOptions = { sourceOwner: ordinaryResearchOwner(), assertCurrent: current };
      const acquired = await captureBrowserControlPosture(context, registry, options);
      armed = true;
      if (change === 'current-accessor') Object.defineProperty(options, 'assertCurrent', {
        configurable: true, get() { accessorReads++; return current; },
      });
      if (change === 'live') {
        expect(() => acquired.assertCurrent()).not.toThrow();
        expect(lateCurrentCalls).toBeGreaterThan(0);
      } else {
        expect(() => acquired.assertCurrent()).toThrow(ToolInputProjectionError);
        if (change === 'current-accessor') expect(lateCurrentCalls).toBe(0);
        else expect(lateCurrentCalls).toBeGreaterThan(0);
      }
      expect(accessorReads).toBe(0);
    });
  }
});

describe('acquired runtime currentness callback lifetime', () => {
  for (const change of ['live', 'current-accessor', 'callback-mutates-current', 'nonvoid-current'] as const) {
    test(`the returned runtime guard checks its captured currentness callback after ${change}`, async () => {
      const { context } = runtimeContext([record()]);
      installJudgmentPort(runtimeReadings().port);
      let armed = false, accessorReads = 0, lateCurrentCalls = 0;
      const current: NonNullable<CatalogRankingOptions['assertCurrent']> = () => {
        if (!armed) return;
        lateCurrentCalls++;
        if (change === 'callback-mutates-current') Object.defineProperty(options, 'assertCurrent', {
          configurable: true, get() { accessorReads++; return current; },
        });
        if (change === 'nonvoid-current') return Promise.resolve();
      };
      const options: CatalogRankingOptions = { sourceOwner: ordinaryResearchOwner(), assertCurrent: current };
      const acquired = await acquireInteractiveRuntimeSnapshot(context, options);
      armed = true;
      if (change === 'current-accessor') Object.defineProperty(options, 'assertCurrent', {
        configurable: true, get() { accessorReads++; return current; },
      });
      if (change === 'live') {
        expect(() => acquired.assertCurrent()).not.toThrow();
        expect(lateCurrentCalls).toBeGreaterThan(0);
      } else {
        expect(() => acquired.assertCurrent()).toThrow(ToolInputProjectionError);
        if (change === 'current-accessor') expect(lateCurrentCalls).toBe(0);
        else expect(lateCurrentCalls).toBeGreaterThan(0);
      }
      expect(accessorReads).toBe(0);
    });
  }
});

describe('native cancellation in acquired browser and runtime guards', () => {
  for (const helper of ['browser', 'runtime'] as const) {
    for (const change of ['live', 'native-aborted', 'signal-method-accessor'] as const) {
      test(`the acquired ${helper} guard reads native cancellation after ${change}`, async () => {
        const { context, registry } = runtimeContext([record()]);
        installJudgmentPort(runtimeReadings().port);
        const controller = new AbortController(), reason = new ToolInputProjectionError('held');
        let accessorReads = 0;
        const options: CatalogRankingOptions = { sourceOwner: ordinaryResearchOwner(), signal: controller.signal };
        const acquired = helper === 'browser'
          ? await captureBrowserControlPosture(context, registry, options)
          : await acquireInteractiveRuntimeSnapshot(context, options);
        if (change === 'native-aborted') controller.abort(reason);
        else if (change === 'signal-method-accessor') Object.defineProperty(controller.signal, 'throwIfAborted', {
          configurable: true, get() { accessorReads++; throw new Error('Borrowed replaced signal method'); },
        });
        if (change === 'native-aborted') expect(() => acquired.assertCurrent()).toThrow(reason);
        else expect(() => acquired.assertCurrent()).not.toThrow();
        expect(accessorReads).toBe(0);
      });
    }
  }
});
