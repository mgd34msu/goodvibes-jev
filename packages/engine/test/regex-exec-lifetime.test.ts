import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createExecTool } from '../sdk/src/platform/tools/exec/runtime.ts';
import { ProcessManager } from '../sdk/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../sdk/src/platform/tools/shared/overflow.ts';
import { toolReadingsPort } from './_helpers/tool-readings.ts';

let previous: ReturnType<typeof installJudgmentPort>;
const roots: string[] = [];
const managers: ProcessManager[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => {
  installJudgmentPort(previous);
  for (const manager of managers.splice(0)) await manager.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'regex-exec-owner-')); roots.push(root);
  const manager = new ProcessManager(); managers.push(manager);
  return createExecTool(manager, { defaultWorkingDirectory: root, credentialEnvScrub: { enabled: false }, overflowHandler: new OverflowHandler({ baseDir: root }) });
}
// exec replaces the shell; the test owns one direct child with no descendants.
const command = `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('READY'); setInterval(() => {}, 1000)")}`;

test('actual until command cancellation interrupts a held reading before spawning', async () => {
  const base = toolReadingsPort();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  installJudgmentPort({ ...base.port, async ask(request) {
    if (Object.hasOwn(request.questions, 'backtracking')) { entered.resolve(); await release.promise; }
    return base.port.ask(request);
  } });
  const controller = new AbortController();
  const tool = fixture();
  const original = Bun.spawn;
  let spawned = 0;
  const spy = spyOn(Bun, 'spawn').mockImplementation(((...args: Parameters<typeof Bun.spawn>) => { spawned++; return original(...args); }) as typeof Bun.spawn);
  const running = tool.execute({ commands: [{ cmd: command, timeout_ms: 5000, until: { pattern: 'READY', kill_after: true } }] }, { signal: controller.signal });
  try {
    await entered.promise; controller.abort();
    expect((await running).success).toBe(false);
    expect(spawned).toBe(0);
  } finally { release.resolve(); spy.mockRestore(); await running.catch(() => {}); }
}, 10000);

test('actual until match with kill_after=false still terminates at the command deadline', async () => {
  installJudgmentPort(toolReadingsPort().port);
  const tool = fixture();
  const original = Bun.spawn;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const spy = spyOn(Bun, 'spawn').mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
    const child = original(...args); children.push(child); return child;
  }) as typeof Bun.spawn);
  try {
    const result = await tool.execute({ commands: [{ cmd: command, timeout_ms: 2500, until: { pattern: 'READY', kill_after: false } }] });
    expect(result.success).toBe(false);
    expect(children).toHaveLength(1);
    expect(children[0]!.signalCode).toBe('SIGKILL');
  } finally {
    spy.mockRestore();
    for (const child of children) { try { child.kill('SIGKILL'); } catch { /* exited */ } await child.exited.catch(() => {}); }
  }
}, 10000);
