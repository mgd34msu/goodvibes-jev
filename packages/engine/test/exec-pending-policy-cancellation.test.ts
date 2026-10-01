/** Cancellation must reach the real exec policy reads before any process starts. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createExecTool, OverflowHandler, ProcessManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { AGENT_OWNER_TERMINAL_GUARD } from '@goodvibes-jev/engine/sdk/platform/gate/policy';
import { isRetryableExecResult } from '../sdk/src/platform/tools/exec/runtime.ts';
const makeProjectTempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

let previous: ReturnType<typeof installJudgmentPort>;
let installed = false;
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; });

for (const scenario of [
  { battery: 'engine.gate.boundary', allowLate: false },
  { battery: 'engine.tools.owner-terminal', allowLate: false },
  { battery: 'engine.tools.owner-terminal', allowLate: true },
]) {
  const { battery, allowLate } = scenario;
  test(`abort settles a pending ${battery} read without launch after late ${allowLate ? 'allow' : 'deny'}`, async () => {
    const root = makeProjectTempDir('exec-pending-policy');
    const controller = new AbortController();
    const command = `printf fixture-${battery}`;
    let begin!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let readingSignal: AbortSignal | undefined;
    const answers = fakePort((name, _question, state) => {
      if (name === 'catastrophic') {
        expect(state).toMatchObject({ tool: 'exec', arguments: { command } });
        // Launch below is intercepted at the actual injected ProcessManager.
        return noulAnswer(battery === 'engine.gate.boundary' ? 0.999 : 0.001);
      }
      expect(state).toMatchObject({ command });
      if (name === 'acts_on_session') return noulAnswer(0.999);
      if (name === 'owned_targets') return noulAnswer(allowLate ? 0.999 : 0.001);
      throw new Error(`Unscripted exec cancellation question: ${name}`);
    }).port;
    previous = installJudgmentPort({ model: answers.model, async ask(request) {
      if (request.context?.battery === battery) {
        readingSignal = request.signal;
        begin();
        await held; // Deliberately unresponsive reader: the caller must race it.
      }
      return answers.ask(request);
    } });
    installed = true;
    const manager = new ProcessManager();
    const launches = spyOn(manager, 'spawn').mockImplementation(async (cmd) => ({ cmd, exit_code: null, stdout: '', stderr: '', success: true, process_id: 'synthetic-launch' }));
    const tool = createExecTool(manager, { overflowHandler: new OverflowHandler({ baseDir: root }), defaultWorkingDirectory: root, ownerTerminal: AGENT_OWNER_TERMINAL_GUARD });
    let settled = false;
    let cancelled = false;
    let serializedCancelled = false;
    const options = { signal: controller.signal };
    const pending = Promise.resolve(tool.execute({ commands: [{ cmd: command, background: true }] }, options))
      .then((result) => {
        settled = true;
        cancelled = result.cancelled === true;
        serializedCancelled = JSON.parse(result.output ?? '{}').cancelled === true;
      }, () => { settled = true; });
    try {
      await Promise.race([started, Bun.sleep(500).then(() => { throw new Error('Policy reading did not start'); })]);
      controller.abort(new Error('fixture cancelled'));
      options.signal = new AbortController().signal;
      await Promise.race([pending, Bun.sleep(50)]);
      const observed = { settled, forwarded: readingSignal === controller.signal };
      release();
      await pending;
      expect({ ...observed, cancelled, serializedCancelled, launches: launches.mock.calls.length })
        .toEqual({ settled: true, forwarded: true, cancelled: true, serializedCancelled: true, launches: 0 });
    } finally {
      release();
      await pending;
      launches.mockRestore();
      await manager.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('abort during detached-launch credential reading cannot reach Bun.spawn', async () => {
  const root = makeProjectTempDir('exec-pending-credential');
  const controller = new AbortController();
  const environmentName = `JEV_TEST_PENDING_CREDENTIAL_${randomUUID().replaceAll('-', '_')}`;
  process.env[environmentName] = 'synthetic fixture';
  let begin!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { begin = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const answers = fakePort((name) => {
    if (name === 'catastrophic' || name === 'acts_on_session') return noulAnswer(0.001);
    if (name === 'owned_targets' || name === 'credential') return noulAnswer(0.999);
    throw new Error(`Unscripted detached-launch question: ${name}`);
  }).port;
  previous = installJudgmentPort({ model: answers.model, async ask(request) {
    if (request.context?.battery === 'engine.tools.credential-env'
      && (request.state as { name?: string }).name === environmentName) {
      begin();
      await held;
    }
    return answers.ask(request);
  } });
  installed = true;
  const manager = new ProcessManager();
  const launches = spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('Intercepted synthetic process launch'); });
  const tool = createExecTool(manager, { overflowHandler: new OverflowHandler({ baseDir: root }), defaultWorkingDirectory: root, ownerTerminal: AGENT_OWNER_TERMINAL_GUARD });
  let settled = false;
  const pending = Promise.resolve(tool.execute({ commands: [{ cmd: 'printf synthetic-credential-wait', background: true }] }, { signal: controller.signal }))
    .then(() => { settled = true; }, () => { settled = true; });
  try {
    await Promise.race([started, Bun.sleep(500).then(() => { throw new Error('Credential reading did not start'); })]);
    controller.abort(new Error('fixture cancelled'));
    await Promise.race([pending, Bun.sleep(50)]);
    const settledOnAbort = settled;
    release();
    await pending;
    expect({ settledOnAbort, launches: launches.mock.calls.length }).toEqual({ settledOnAbort: true, launches: 0 });
  } finally {
    release();
    await pending;
    launches.mockRestore();
    await manager.close();
    delete process.env[environmentName];
    rmSync(root, { recursive: true, force: true });
  }
});

test('a pending retry reading receives cancellation and cannot return a late retry permission', async () => {
  const controller = new AbortController();
  let begin!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { begin = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const answers = fakePort((name, question) => {
    expect(name).toBe('category');
    return choiceAnswer(question, 'network', 0.99);
  }).port;
  previous = installJudgmentPort({ model: answers.model, async ask(request) {
    expect(request.context?.battery).toBe('engine.tools.exec-retry');
    expect(request.signal).toBe(controller.signal);
    begin(); await held;
    return answers.ask(request);
  } });
  installed = true;
  const pending = isRetryableExecResult({ cmd: 'synthetic retry', exit_code: 1, stdout: '', stderr: 'synthetic failure', success: false }, ['network'], controller.signal);
  const caught = pending.catch((error: unknown) => error);
  try {
    await Promise.race([started, Bun.sleep(500).then(() => { throw new Error('Retry reading did not start'); })]);
    controller.abort(new Error('retry cancelled'));
    expect(await Promise.race([caught, Bun.sleep(500).then(() => { throw new Error('Retry cancellation did not settle'); })])).toBe(controller.signal.reason);
    release();
    await Bun.sleep(0);
  } finally { release(); await caught; }
});

test('pre-aborted exec never performs its file operations or reads policy', async () => {
  const root = makeProjectTempDir('exec-pre-aborted-files');
  const source = join(root, 'source.txt');
  const destination = join(root, 'destination.txt');
  writeFileSync(source, 'synthetic fixture');
  const manager = new ProcessManager();
  const controller = new AbortController(); controller.abort(new Error('already cancelled'));
  previous = installJudgmentPort({ model: 'offline-no-reading', ask() { throw new Error('Pre-abort must not disclose a policy request'); } });
  installed = true;
  const tool = createExecTool(manager, { defaultWorkingDirectory: root, overflowHandler: new OverflowHandler({ baseDir: root }) });
  try {
    const result = await tool.execute({ file_ops: [{ op: 'copy', source, destination }], commands: [{ cmd: 'synthetic command' }] }, { signal: controller.signal });
    expect(result).toMatchObject({ success: false, cancelled: true });
    expect(JSON.parse(result.output ?? '{}')).toEqual({ cancelled: true });
    expect(existsSync(destination)).toBe(false);
    expect(manager.list()).toEqual([]);
  } finally { await manager.close(); rmSync(root, { recursive: true, force: true }); }
});

test('replacing execution options during the first await cannot discard the original cancellation', async () => {
  const root = makeProjectTempDir('exec-options-mutation');
  const manager = new ProcessManager();
  const controller = new AbortController();
  const options = { signal: controller.signal };
  let requests = 0;
  previous = installJudgmentPort({ model: 'offline-no-reading', ask() {
    requests++;
    throw new Error('Cancelled execution must not reach policy');
  } });
  installed = true;
  const tool = createExecTool(manager, { defaultWorkingDirectory: root, overflowHandler: new OverflowHandler({ baseDir: root }) });
  try {
    const pending = tool.execute({ commands: [{ cmd: 'synthetic command' }] }, options);
    controller.abort(new Error('cancelled during initial await'));
    options.signal = new AbortController().signal;
    const result = await pending;
    expect(result).toMatchObject({ success: false, cancelled: true });
    expect(JSON.parse(result.output ?? '{}')).toEqual({ cancelled: true });
    expect(requests).toBe(0);
    expect(manager.list()).toEqual([]);
  } finally { await manager.close(); rmSync(root, { recursive: true, force: true }); }
});
