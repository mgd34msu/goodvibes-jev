// A scheduled workflow command gets the environment the exec path gives a
// command: variables read as credential-bearing are withheld, the rest and
// GV_SCHEDULE_NAME are passed.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScheduleManager, createWorkflowServices } from '../sdk/src/platform/tools/workflow/index.ts';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import { registerAllTools } from '../sdk/src/platform/tools/index.ts';
import { AgentMessageBus } from '../sdk/src/platform/agents/message-bus.ts';
import { AgentManager } from '../sdk/src/platform/tools/agent/manager.ts';
import { FileStateCache } from '../sdk/src/platform/state/file-cache.ts';
import { FileUndoManager } from '../sdk/src/platform/state/file-undo.ts';
import { ModeManager } from '../sdk/src/platform/state/mode-manager.ts';
import { ProcessManager } from '../sdk/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../sdk/src/platform/tools/shared/overflow.ts';
import { SandboxSessionRegistry } from '../sdk/src/platform/runtime/sandbox/session-registry.ts';
import { CrossSessionTaskRegistry } from '../sdk/src/platform/sessions/orchestration/registry.ts';
import type { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

useToolReadings([['GV_SCHEDULE_TEST_TOKEN', { credential: true }]]);

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-schedule-env-'));
  process.env.GV_SCHEDULE_TEST_TOKEN = 'tok-should-not-leak';
  process.env.GV_SCHEDULE_TEST_PLAIN = 'plain-visible';
});
afterEach(() => {
  delete process.env.GV_SCHEDULE_TEST_TOKEN;
  delete process.env.GV_SCHEDULE_TEST_PLAIN;
  rmSync(dir, { recursive: true, force: true });
});

describe('scheduled workflow command environment', () => {
  test('credential-bearing variables are withheld; the rest and GV_SCHEDULE_NAME are passed', async () => {
    const env = await runOnce(new ScheduleManager());
    expect(env).toContain('GV_SCHEDULE_NAME=nightly');
    expect(env).toContain('GV_SCHEDULE_TEST_PLAIN=plain-visible');
    expect(env).not.toContain('tok-should-not-leak');
  });

  async function runOnce(manager: ScheduleManager, body = 'env > "$1"\n'): Promise<string> {
    const out = join(dir, 'env.txt');
    const script = join(dir, 'dump.sh');
    writeFileSync(script, body);
    const spawn = Bun.spawn;
    const interval = globalThis.setInterval;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let complete!: (child: ReturnType<typeof Bun.spawn>) => void;
    const started = new Promise<ReturnType<typeof Bun.spawn>>((resolve) => { complete = resolve; });
    // Observe the real process without replacing its arguments or scrubbed env.
    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((...args: unknown[]) => {
      const proc = Reflect.apply(spawn, Bun, args) as ReturnType<typeof Bun.spawn>;
      if (Array.isArray(args[0]) && args[0].includes(script)) {
        child = proc;
        complete(proc);
      }
      return proc;
    }) as typeof Bun.spawn);
    // These tests exercise env propagation. Admit one actual timer tick, then
    // stop repetition before a later command can truncate the output again.
    const timerSpy = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay: number) =>
      interval(() => {
        try { callback(); } finally { manager.remove('nightly'); }
      }, delay)) as typeof setInterval);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('scheduled fixture did not finish')), 5_000);
    });
    try {
      try { manager.add('nightly', '0.05s', `sh ${script} ${out}`); }
      finally { timerSpy.mockRestore(); }
      const proc = await Promise.race([started, timedOut]);
      expect(await Promise.race([proc.exited, timedOut])).toBe(0);
      return readFileSync(out, 'utf-8');
    } finally {
      clearTimeout(deadline);
      manager.remove('nightly');
      try {
        if (child && child.exitCode === null) child.kill();
        if (child) await child.exited;
      } finally { spawnSpy.mockRestore(); }
    }
  }

  test('the output file can exist empty before the real child has completed', async () => {
    const ready = join(dir, 'ready');
    const release = join(dir, 'release');
    let settled = false;
    const result = runOnce(new ScheduleManager(), [
      'exec 3>"$1"',
      `: > "${ready}"`,
      `while [ ! -e "${release}" ]; do sleep 0.01; done`,
      'env >&3',
      '',
    ].join('\n')).then((env) => { settled = true; return env; });
    let env = '';
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(ready)).toBe(true);
      // The original existence-based read sees this empty, truncated file.
      expect(readFileSync(join(dir, 'env.txt'), 'utf-8')).toBe('');
      expect(settled).toBe(false);
    } finally {
      writeFileSync(release, '');
      env = await result;
    }
    expect(env).toContain('GV_SCHEDULE_NAME=nightly');
    expect(env).toContain('GV_SCHEDULE_TEST_PLAIN=plain-visible');
    expect(env).not.toContain('tok-should-not-leak');
  });

  test('a name on the configured allowlist is kept, as the exec path keeps it', async () => {
    const manager = new ScheduleManager();
    manager.setCredentialEnvScrub({ allowlist: ['gv_schedule_test_token'] });
    expect(await runOnce(manager)).toContain('GV_SCHEDULE_TEST_TOKEN=tok-should-not-leak');
  });

  test('registerAllTools gives the schedule manager the credentialEnvScrub it gives exec', async () => {
    const workflowServices = createWorkflowServices();
    const seen: unknown[] = [];
    const original = workflowServices.scheduleManager.setCredentialEnvScrub.bind(workflowServices.scheduleManager);
    workflowServices.scheduleManager.setCredentialEnvScrub = (config) => { seen.push(config); original(config); };
    const credentialEnvScrub = { allowlist: ['GV_SCHEDULE_TEST_TOKEN'] };
    const sessions = new CrossSessionTaskRegistry(join(dir, 'session-tasks.json'));
    registerAllTools(new ToolRegistry(), {
      fileCache: new FileStateCache(),
      fileUndoManager: new FileUndoManager(),
      modeManager: new ModeManager(),
      processManager: new ProcessManager(),
      agentMessageBus: new AgentMessageBus(),
      agentManager: new AgentManager({
        configManager: { get: ((_key: string): unknown => undefined) as ConfigManager['get'] },
        messageBus: { registerAgent() { /* no-op */ } },
        executor: { async runAgent() { /* never spawned */ } },
      } as never),
      contractRunner: { start: async () => { throw new Error('unused'); }, list: () => [], get: () => undefined } as never,
      projectRoot: dir,
      workflowServices,
      sandboxSessionRegistry: new SandboxSessionRegistry(dir),
      sessionOrchestration: sessions,
      overflowHandler: new OverflowHandler({ baseDir: dir }),
      workingDirectory: dir,
      surfaceRoot: 'test-surface',
      configManager: { get: () => undefined, getCategory: () => undefined, getHomeDirectory: () => dir, getWorkingDirectory: () => dir } as never,
      providerRegistry: {} as never,
      toolLLM: {} as never,
      credentialEnvScrub,
    } as never);
    sessions.dispose();
    expect(seen).toEqual([credentialEnvScrub]);
    expect(await runOnce(workflowServices.scheduleManager)).toContain('GV_SCHEDULE_TEST_TOKEN=tok-should-not-leak');
  });
});
