/** Exec cancellation and explicitly requested retry readings preserve their original owner. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createExecTool, OverflowHandler, ProcessManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { AGENT_OWNER_TERMINAL_GUARD } from '@goodvibes-jev/engine/sdk/platform/gate/policy';
import { isRetryableExecResult } from '../sdk/src/platform/tools/exec/runtime.ts';
const makeProjectTempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

let previous: ReturnType<typeof installJudgmentPort>;
let installed = false;
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; });

test('authorized exec does not wait for removed boundary or owner-terminal readings', async () => {
  const root = makeProjectTempDir('exec-without-secondary-gate');
  const manager = new ProcessManager();
  const launches = spyOn(manager, 'spawn').mockImplementation(async cmd => ({ cmd, exit_code: 0, stdout: 'fixture', stderr: '', success: true, process_id: 'synthetic-launch' }));
  let requests = 0;
  previous = installJudgmentPort({ model: 'offline-no-reading', ask() { requests++; throw new Error('Unexpected exec approval reading'); } }); installed = true;
  const tool = createExecTool(manager, { overflowHandler: new OverflowHandler({ baseDir: root }), defaultWorkingDirectory: root, ownerTerminal: AGENT_OWNER_TERMINAL_GUARD });
  try {
    const result = await tool.execute({ commands: [{ cmd: 'synthetic-fixture', background: true }] });
    expect(result.success).toBe(true);
    expect(launches).toHaveBeenCalledTimes(1);
    expect(requests).toBe(0);
  } finally { launches.mockRestore(); await manager.close(); rmSync(root, { recursive: true, force: true }); }
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
