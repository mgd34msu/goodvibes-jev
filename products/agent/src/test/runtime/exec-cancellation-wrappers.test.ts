/**
 * The real registry -> Agent policy/safety wrappers -> engine exec path.
 * Only judgment answers are scripted; exec still launches and stops a real
 * foreground child. Engine dependencies use public package exports only.
 */
import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createExecTool, OverflowHandler, ProcessManager, ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { AGENT_OWNER_TERMINAL_GUARD } from '../../runtime/agent-exec-posture.ts';
import { installAgentToolPolicyGuard } from '../../tools/agent-tool-policy-guard.ts';
import { installAgentPlatformBoundaryGuard } from '../../tools/agent-platform-boundary-policy.ts';
import { installToolExecutionSafetyGuard } from '../../tools/tool-execution-safety.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`${label} was not observed`);
    await Bun.sleep(10);
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function pipeline(root: string) {
  const manager = new ProcessManager();
  const registry = new ToolRegistry();
  // The installer requires the orchestration tool to exist. This suite never
  // calls it; do not start the unrelated AgentManager/runtime graph here.
  registry.register({
    definition: { name: 'agent', description: 'Unused orchestration fixture', parameters: { type: 'object', properties: {} } },
    execute: async () => { throw new Error('This suite must execute the real exec tool only'); },
  });
  registry.register(createExecTool(manager, {
    defaultWorkingDirectory: root,
    overflowHandler: new OverflowHandler({ baseDir: root }),
    ownerTerminal: AGENT_OWNER_TERMINAL_GUARD,
  }));
  // Same installation order as composeAgentToolRegistry. The boundary guard
  // does not alter exec, but remains installed alongside its product peers.
  installAgentToolPolicyGuard(registry);
  installAgentPlatformBoundaryGuard(registry, () => 'Run the scratch fixture command');
  installToolExecutionSafetyGuard(registry);
  return { manager, registry };
}

function readings(denied: 'catastrophic' | 'owner-terminal' | null = null) {
  return fakePort((name, _question, state) => {
    switch (name) {
      case 'catastrophic': return noulAnswer(denied === 'catastrophic' ? 0.999 : 0.001);
      case 'acts_on_session': return noulAnswer(denied === 'owner-terminal' ? 0.999 : 0.001);
      case 'owned_targets': return noulAnswer(denied === 'owner-terminal' ? 0.001 : 0.999);
      // Keep environment hygiene enabled; the fixture needs no credentials.
      case 'credential': return noulAnswer(/key|token|secret|password|credential/i.test(String((state as { name?: string }).name)) ? 0.999 : 0.001);
      default: throw new Error(`Unscripted Agent exec judgment: ${name}`);
    }
  });
}

for (const progress of [false, true]) {
  test(`registry cancellation stops a real ${progress ? 'progress-streamed' : 'foreground'} child through Agent wrappers`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-exec-wrapper-cancel-'));
    const answers = readings();
    const previous = installJudgmentPort(answers.port);
    const { registry, manager } = pipeline(root);
    const controller = new AbortController();
    const ready = join(root, 'ready-pid');
    const sentinel = join(root, 'completed');
    const script = join(root, 'child.ts');
    // exec replaces the shell: the reported PID is the actual child owned by
    // exec, with no sleeping grandchildren that could escape test cleanup.
    writeFileSync(script, [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(ready)}, String(process.pid));`,
      `setTimeout(() => writeFileSync(${JSON.stringify(sentinel)}, 'completed'), 30_000);`,
    ].join('\n'));
    let pid: number | undefined;
    const pending = registry.execute('cancel-real-child', 'exec', {
      commands: [{ cmd: `exec ${quote(process.execPath)} ${quote(script)}`, timeout_ms: 20_000, progress }],
    }, { signal: controller.signal });
    try {
      await waitFor(() => existsSync(ready), 'real child startup');
      pid = Number(readFileSync(ready, 'utf8'));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      expect(alive(pid)).toBe(true);
      const abortAt = Date.now();
      controller.abort(new Error('cancel this Agent tool call'));
      const result = await within(pending, 'Agent exec cancellation');
      expect(Date.now() - abortAt).toBeLessThan(2_000);
      expect(result).toMatchObject({ callId: 'cancel-real-child', success: false });
      expect(JSON.parse(String(result.output))).toMatchObject({ cancelled: true });
      expect(JSON.parse(String(result.output)).timed_out).toBeUndefined();
      await waitFor(() => !alive(pid!), 'child termination');
      expect(existsSync(sentinel)).toBe(false);
      const boundary = answers.requests.find((request) => request.context?.battery === 'engine.gate.boundary');
      const terminal = answers.requests.find((request) => request.context?.battery === 'engine.tools.owner-terminal');
      expect(boundary?.signal).toBe(controller.signal);
      expect(terminal?.signal).toBe(controller.signal);
      // Cancellation is per call. The same wrapped registry remains usable.
      const next = await registry.execute('after-cancel', 'exec', {
        commands: [{ cmd: `printf recovered > ${quote(sentinel)}`, timeout_ms: 2_000 }],
      });
      expect(next.success).toBe(true);
      expect(readFileSync(sentinel, 'utf8')).toBe('recovered');
    } finally {
      controller.abort();
      if (pid === undefined && existsSync(ready)) pid = Number(readFileSync(ready, 'utf8'));
      if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
      await within(pending, 'child cleanup', 3_000).catch(() => undefined);
      await manager.close();
      installJudgmentPort(previous);
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
}

test('Agent-wrapped exec distinguishes a real timeout kill from cancellation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-exec-wrapper-timeout-'));
  const previous = installJudgmentPort(readings().port);
  const { registry, manager } = pipeline(root);
  const ready = join(root, 'ready-pid');
  const sentinel = join(root, 'completed');
  const script = join(root, 'child.ts');
  writeFileSync(script, [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(ready)}, String(process.pid));`,
    `setTimeout(() => writeFileSync(${JSON.stringify(sentinel)}, 'completed'), 30_000);`,
  ].join('\n'));
  let pid: number | undefined;
  const pending = registry.execute('timeout-child', 'exec', {
    commands: [{ cmd: `exec ${quote(process.execPath)} ${quote(script)}`, timeout_ms: 500 }],
  }, { signal: new AbortController().signal });
  try {
    await waitFor(() => existsSync(ready), 'timeout child startup');
    pid = Number(readFileSync(ready, 'utf8'));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(alive(pid)).toBe(true);
    const result = await within(pending, 'exec timeout');
    expect(result).toMatchObject({ callId: 'timeout-child', success: false });
    expect(JSON.parse(String(result.output))).toMatchObject({ timed_out: true });
    expect(JSON.parse(String(result.output)).cancelled).toBeUndefined();
    await waitFor(() => !alive(pid!), 'timed-out child termination');
    expect(existsSync(sentinel)).toBe(false);
  } finally {
    if (pid === undefined && existsSync(ready)) pid = Number(readFileSync(ready, 'utf8'));
    if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
    await within(pending, 'timeout child cleanup', 3_000).catch(() => undefined);
    await manager.close();
    installJudgmentPort(previous);
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

for (const battery of ['engine.gate.boundary', 'engine.tools.owner-terminal']) {
  for (const lateAllows of [true, false]) {
    test(`Agent wrappers cancel a pending ${battery} read before its late ${lateAllows ? 'allow' : 'deny'}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'agent-exec-wrapper-pending-'));
      const answers = readings(lateAllows ? null : battery === 'engine.gate.boundary' ? 'catastrophic' : 'owner-terminal');
      const started = deferred();
      const release = deferred();
      const readReturned = deferred();
      const controller = new AbortController();
      let readingSignal: AbortSignal | undefined;
      const previous = installJudgmentPort({
        model: answers.port.model,
        async ask(request) {
          if (request.context?.battery !== battery) return answers.port.ask(request);
          readingSignal = request.signal;
          started.resolve();
          await release.promise; // An uncooperative remote reader ignores abort.
          try { return await answers.port.ask(request); }
          finally { readReturned.resolve(); }
        },
      });
      const { registry, manager } = pipeline(root);
      const launches = spyOn(Bun, 'spawn');
      const marker = join(root, 'must-not-launch');
      const pending = registry.execute('cancel-pending-policy', 'exec', {
        commands: [{ cmd: `printf late > ${quote(marker)}`, timeout_ms: 2_000 }],
      }, { signal: controller.signal });
      try {
        await within(started.promise, 'policy reading startup');
        expect(readingSignal).toBe(controller.signal);
        controller.abort(new Error('cancel pending Agent admission'));
        // Must settle BEFORE the held reader is released.
        const result = await within(pending, 'pending policy cancellation');
        expect(result).toMatchObject({ callId: 'cancel-pending-policy', success: false, cancelled: true });
        expect(JSON.parse(String(result.output))).toEqual({ cancelled: true });
        expect(launches).not.toHaveBeenCalled();
        release.resolve();
        await within(readReturned.promise, 'late policy answer');
        await Bun.sleep(0);
        expect(launches).not.toHaveBeenCalled();
        expect(existsSync(marker)).toBe(false);
      } finally {
        release.resolve();
        controller.abort();
        await within(pending, 'pending policy cleanup').catch(() => undefined);
        launches.mockRestore();
        await manager.close();
        installJudgmentPort(previous);
        rmSync(root, { recursive: true, force: true });
      }
    }, 10_000);
  }
}

test('the cancellation-capable Agent chain still enforces foreground, catastrophic and owner-terminal gates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-exec-wrapper-gates-'));
  const answers = readings();
  const previous = installJudgmentPort(answers.port);
  const { registry, manager } = pipeline(root);
  const marker = join(root, 'allowed-control');
  const controller = new AbortController();
  try {
    const control = await registry.execute('allowed-control', 'exec', {
      commands: [{ cmd: `printf allowed > ${quote(marker)}`, timeout_ms: 2_000 }],
    }, { signal: controller.signal });
    expect(control.success).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('allowed');
    const launches = spyOn(Bun, 'spawn');
    try {
      const blocked = join(root, 'blocked');
      const command = { cmd: `printf blocked > ${quote(blocked)}`, timeout_ms: 2_000 };
      for (const args of [
        { commands: [{ ...command, background: true }] },
        { commands: [command], parallel: true },
        { commands: [command], file_ops: [{ op: 'copy', source: marker, destination: blocked }] },
      ]) {
        const denied = await registry.execute('product-denial', 'exec', args, { signal: controller.signal });
        expect(denied.success).toBe(false);
        expect(denied.error).toContain('foreground, serial');
      }
      for (const denial of ['catastrophic', 'owner-terminal'] as const) {
        installJudgmentPort(readings(denial).port);
        const result = await registry.execute(denial, 'exec', {
          // Distinct commands keep cached boundary readings separate.
          commands: [{ cmd: `${command.cmd}-${denial}`, timeout_ms: 2_000 }],
        }, { signal: controller.signal });
        expect(result.success).toBe(false);
        expect(JSON.parse(String(result.output))).toMatchObject({ denied: true });
        expect(String(result.output)).toContain(denial === 'catastrophic' ? 'safety block' : "owner's terminal is untouchable");
      }
      expect(launches).not.toHaveBeenCalled();
      expect(existsSync(blocked)).toBe(false);
    } finally { launches.mockRestore(); }
  } finally {
    await manager.close();
    installJudgmentPort(previous);
    rmSync(root, { recursive: true, force: true });
  }
});
