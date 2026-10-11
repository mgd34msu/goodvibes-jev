import { expect, spyOn, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { join } from 'node:path';
import { ConfigManager, DEFAULT_CONFIG } from '../sdk/src/platform/config/index.js';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.js';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.js';
import { createAgentTool, type AgentRecord } from '../sdk/src/platform/tools/agent/index.js';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import { forgetGateReadings, gateReadingsPort } from './_helpers/gate-readings.js';
import { makeHarness } from './contract/runner-support.js';

const CHILD_FAILURE_SITE = 'tools.agent.child-failure-reason';

function barrier() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release() { if (!release) throw new Error('Barrier was not constructed'); release(); } };
}

async function within<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Cancellation observation did not settle')), 2_000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function holdUntilAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const finish = () => { signal.removeEventListener('abort', finish); resolve(); };
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

type ObservedResult<T> = { kind: 'published'; result: T } | { kind: 'refused'; error: unknown };

function resultOf<T>(work: Promise<T>): Promise<ObservedResult<T>> {
  return work.then<ObservedResult<T>, ObservedResult<T>>(
    result => ({ kind: 'published', result }), error => ({ kind: 'refused', error }));
}

function cancellationHarness(options: { readonly failChild?: boolean; readonly holdFailureReading?: boolean } = {}) {
  forgetGateReadings();
  const repositoryMap = barrier();
  const readEntered = barrier(), readReleased = barrier(), readExited = barrier();
  const executorTasks: string[] = [];
  const h = makeHarness({
    scripts: {},
    repositoryMap: async () => { await repositoryMap.promise; return 'README.md'; },
    async executeAgent(record, { manager }) {
      executorTasks.push(record.task);
      if (options.failChild) {
        record.status = 'failed';
        record.error = 'The synthetic worker stopped with an unexplained error.';
        record.completedAt = Date.now();
        return;
      }
      record.status = 'running';
      const signal = manager.getCancellationSignal(record.id);
      if (!signal) throw new Error('Actual manager execution has no cancellation signal');
      await holdUntilAbort(signal);
    },
  });
  const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: h.root, homeDir: h.root,
    configDir: join(h.root, '.goodvibes', 'cancellation-config') });
  const reader: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions: DEFAULT_CONFIG.permissions, autoApprove: false,
      directory: h.root, incarnation: 0 }),
    getSnapshot: () => ({ permissions: DEFAULT_CONFIG.permissions }),
    getWorkingDirectory: () => h.root,
    isAutoApproveEnabled: () => false,
  };
  const permission = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const registry = new ToolRegistry(permission);
  registry.register(createAgentTool({ manager: h.manager, messageBus: h.messageBus, configManager: config,
    archetypeLoader: { loadArchetype: () => null }, contractRunner: h.runner, projectRoot: h.root,
    resolveSessionId: () => 'cancellation-session' }));
  const log = new SqliteDecisionLog(':memory:');
  const gate = gateReadingsPort();
  const disposition = fakePort((_name, question) => choiceAnswer(question, 'act', 0.999));
  const reason = fakePort((_name, question) => choiceAnswer(question, 'api_error', 0.99));
  const port: JudgmentPort = {
    model: gate.port.model,
    async ask(request) {
      if (request.context?.site === CHILD_FAILURE_SITE) {
        readEntered.release();
        try {
          if (options.holdFailureReading) await readReleased.promise;
          // This adapter deliberately ignores the supplied signal and attempt
          // guards. The real captured port must interrupt and prevent retention.
          return await reason.port.ask({ state: request.state, questions: request.questions,
            ...(request.model === undefined ? {} : { model: request.model }) });
        } finally { readExited.release(); }
      }
      return ('disposition' in request.questions ? disposition.port : gate.port).ask(request);
    },
  };
  const recordingPort = withDecisionLog(port, log);
  let failureReading: Promise<unknown> | undefined;
  const trackedPort: JudgmentPort = {
    model: recordingPort.model,
    ...(recordingPort.recorder === undefined ? {} : { recorder: recordingPort.recorder }),
    ...(recordingPort.health === undefined ? {} : { health: recordingPort.health }),
    ask(request) {
      const reading = recordingPort.ask(request);
      if (request.context?.site === CHILD_FAILURE_SITE) failureReading = reading;
      return reading;
    },
  };
  const previous = installJudgmentPort(trackedPort);
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<unknown>>();
  let calls = 0, admissions = 0;
  function execute(args: Record<string, unknown>, controller: AbortController) {
    controllers.add(controller);
    const work = (async () => {
      const callId = `agent-cancellation-${++calls}`;
      const call = await registry.prepareCall(callId, 'agent', args);
      const admission = await permission.admitAutonomous(callId, 'agent', call.args, {
        sourceOf: () => ({ goal: 'Perform the supplied synthetic Agent operation', criteria: [] }),
        schemaRevision: call.schemaRevision, preparedCall: { registry, call },
      });
      expect(admission.result.approved).toBe(true);
      admissions++;
      return registry.executePrepared(call, admission, { signal: controller.signal });
    })();
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  }
  return {
    ...h, log, executorTasks, readEntered, readReleased, readExited, execute,
    admissions: () => admissions,
    async close() {
      for (const controller of controllers) controller.abort();
      const contracts = h.runner.list({ includeTerminal: true });
      h.runner.dispose();
      for (const record of h.manager.list()) h.manager.cancel(record.id);
      repositoryMap.release();
      readReleased.release();
      try {
        await Promise.allSettled([...pending, ...contracts.map(contract => h.runner.join(contract.id)),
          ...h.manager.list().map(record => h.manager.join(record.id)),
          ...(failureReading === undefined ? [] : [failureReading])]);
      } finally {
        installJudgmentPort(previous);
        h.dispose();
        log[Symbol.dispose]();
        forgetGateReadings();
      }
    },
  };
}

test.each([true, false])('an already-aborted admitted Agent invocation constructs no work, outsideContract=%s', async outsideContract => {
  const h = cancellationHarness();
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await resultOf(h.execute({ mode: 'spawn', task: 'Do the cancelled synthetic task', outsideContract }, controller));
    expect(result.kind).toBe('refused');
    expect(h.admissions()).toBe(1);
    expect(h.manager.list()).toHaveLength(0);
    expect(h.runner.list({ includeTerminal: true })).toHaveLength(0);
    expect(h.executorTasks).toHaveLength(0);
  } finally { await h.close(); }
});

test('abort during actual owned manager construction cancels that record without starting its executor or cancelling another run', async () => {
  const h = cancellationHarness();
  let restore = () => {};
  try {
    const unrelated = h.manager.spawn({ mode: 'spawn', task: 'Keep the unrelated worker running', outsideContract: true });
    const unrelatedSignal = h.manager.getCancellationSignal(unrelated.id);
    const controller = new AbortController();
    let constructed: AgentRecord | undefined;
    const registerAgent = h.messageBus.registerAgent.bind(h.messageBus);
    const registration = spyOn(h.messageBus, 'registerAgent').mockImplementation(participant => {
      const result = registerAgent(participant);
      const record = h.manager.getStatus(participant.agentId);
      if (record?.task === 'Construct the cancelled worker') {
        constructed = record;
        controller.abort();
      }
      return result;
    });
    restore = () => registration.mockRestore();
    const result = await resultOf(h.execute({ mode: 'spawn', task: 'Construct the cancelled worker', outsideContract: true }, controller));
    expect(controller.signal.aborted).toBe(true);
    expect(result.kind === 'refused' || result.result.success === false).toBe(true);
    expect(constructed?.status).toBe('cancelled');
    expect(h.executorTasks).toEqual(['Keep the unrelated worker running']);
    expect(unrelated.status).toBe('running');
    expect(unrelatedSignal?.aborted).toBe(false);
    if (!constructed) throw new Error('Actual manager construction was not observed');
    await h.manager.join(constructed.id);
  } finally { restore(); await h.close(); }
});

test('abort during actual contract owner construction cancels only the returned contract and settles its owner', async () => {
  const h = cancellationHarness();
  let restore = () => {};
  try {
    const unrelated = h.runner.start({ ask: 'Keep the unrelated contract active', sessionId: 'unrelated-session', origin: 'cli', projectRoot: h.root });
    const unrelatedSignal = h.manager.getCancellationSignal(unrelated.owner.id);
    const controller = new AbortController();
    let ownedId: string | undefined;
    const registerAgent = h.messageBus.registerAgent.bind(h.messageBus);
    const registration = spyOn(h.messageBus, 'registerAgent').mockImplementation(participant => {
      const result = registerAgent(participant);
      const record = h.manager.getStatus(participant.agentId);
      if (record?.task === 'Construct the cancelled contract') {
        ownedId = record.contractId;
        controller.abort();
      }
      return result;
    });
    restore = () => registration.mockRestore();
    const result = await resultOf(h.execute({ mode: 'spawn', task: 'Construct the cancelled contract' }, controller));
    expect(controller.signal.aborted).toBe(true);
    expect(result.kind === 'refused' || result.result.success === false).toBe(true);
    if (!ownedId) throw new Error('Actual contract owner construction was not observed');
    await h.runner.join(ownedId);
    const owned = h.runner.get(ownedId);
    expect(owned?.status).toBe('cancelled');
    expect(h.manager.getStatus(owned?.ownerAgentId ?? '')?.status).toBe('cancelled');
    expect(unrelated.contract.status).not.toBe('cancelled');
    expect(unrelated.owner.status).not.toBe('cancelled');
    expect(unrelatedSignal?.aborted).toBe(false);
    expect(h.executorTasks).toHaveLength(0);
  } finally { restore(); await h.close(); }
});

test('cancelling a wait removes its polling timer while the observed unrelated worker keeps running', async () => {
  const h = cancellationHarness();
  let restore = () => {};
  try {
    const target = h.manager.spawn({ mode: 'spawn', task: 'Keep the polled worker running', outsideContract: true });
    const targetSignal = h.manager.getCancellationSignal(target.id);
    const controller = new AbortController();
    const getStatus = h.manager.getStatus.bind(h.manager);
    let polls = 0;
    const status = spyOn(h.manager, 'getStatus').mockImplementation(id => {
      const record = getStatus(id);
      if (id === target.id && ++polls === 2) queueMicrotask(() => controller.abort());
      return record;
    });
    restore = () => status.mockRestore();
    const result = await within(resultOf(h.execute({ mode: 'wait', agentId: target.id, timeoutMs: 1_000 }, controller)));
    expect(result.kind).toBe('refused');
    expect(polls).toBe(2);
    await new Promise<void>(resolve => setTimeout(resolve, 75));
    expect(polls).toBe(2);
    expect(target.status).toBe('running');
    expect(targetSignal?.aborted).toBe(false);
  } finally { restore(); await h.close(); }
});

test('a terminal free-text reading that ignores cancellation cannot keep the wait alive or record a late result', async () => {
  const h = cancellationHarness({ failChild: true, holdFailureReading: true });
  try {
    const failed = h.manager.spawn({ mode: 'spawn', task: 'Fail the synthetic worker', outsideContract: true });
    await h.manager.join(failed.id);
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBeUndefined();
    const controller = new AbortController();
    const result = resultOf(h.execute({ mode: 'wait', agentId: failed.id }, controller));
    await within(h.readEntered.promise);
    controller.abort();
    expect((await within(result)).kind).toBe('refused');
    expect(h.log.query({ site: CHILD_FAILURE_SITE })).toHaveLength(0);
    expect(h.admissions()).toBe(1);
    expect(h.log.query().length).toBeGreaterThan(0);
    h.readReleased.release();
    await within(h.readExited.promise);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(h.log.query({ site: CHILD_FAILURE_SITE })).toHaveLength(0);
    expect(failed.status).toBe('failed');
  } finally { await h.close(); }
});
