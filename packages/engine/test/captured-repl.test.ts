import { afterEach, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureContractInput, contractInputPath, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.js';
import { createContractInputAuthority, revokeContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { SandboxSessionRegistry } from '../sdk/src/platform/runtime/sandbox/session-registry.js';
import { probeCapturedExecAvailability, type CapturedExecAuthority } from '../sdk/src/platform/tools/exec/captured-exec.js';
import { createCapturedReplTool, isCapturedReplTool } from '../sdk/src/platform/tools/repl/captured.js';
import { createReplTool } from '../sdk/src/platform/tools/repl/index.js';
import { capturedInputTool } from '../sdk/src/platform/tools/shared/captured-input-tools.js';
import { useToolReadings } from './_helpers/tool-readings.js';

useToolReadings([], [['REFUSED_REPL_ACTION', { catastrophic: true }]]);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const availability = await probeCapturedExecAvailability();
if (process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT === '1' && !availability.available)
  throw new Error('required captured REPL containment backend is unavailable');

function git(root: string, ...args: string[]): void {
  const result = childProcess.spawnSync('git', ['-C', root, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}
async function fixture(filter: (path: string) => boolean | Promise<boolean> = () => true, mutable = true) {
  const owner = mkdtempSync(join(tmpdir(), 'captured-repl-')); roots.push(owner);
  git(owner, 'init', '-q'); git(owner, 'config', 'user.name', 'Fixture'); git(owner, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(owner, 'allowed.ts'), 'export const value = "CAPTURED_ALLOWED";\n');
  writeFileSync(join(owner, 'private.ts'), 'export const value = "DENIED_REPL_BYTES";\n');
  git(owner, 'add', '.'); git(owner, 'commit', '-qm', 'captured repl fixture');
  const inputSnapshot = await captureContractInput(owner);
  const root = contractInputPath(inputSnapshot);
  git(owner, 'worktree', 'add', '--no-checkout', '-b', `input/${inputSnapshot.id}`, root, inputSnapshot.inputCommit);
  await materializeContractInput(inputSnapshot, root);
  const contract = { projectRoot: owner, inputSnapshot } as Contract;
  const authority = await createContractInputAuthority(contract, root,
    mutable ? { mutable: true, branch: `input/${inputSnapshot.id}` } : {});
  const readAccessFilter = async (path: string): Promise<boolean> => filter(path);
  const binding: CapturedExecAuthority = { authority, root, readAccessFilter };
  const raw = createCapturedReplTool(binding);
  return { owner, root, contract, binding, raw, tool: capturedInputTool(raw, authority, root, readAccessFilter, undefined) };
}

for (const runtime of ['javascript', 'typescript'] as const) {
  test.skipIf(!availability.available)(`${runtime} completion, bindings and imports use a fresh contained member`, async () => {
    const f = await fixture();
    writeFileSync(join(f.owner, 'allowed.ts'), 'export const value = "LIVE_OWNER_CHANGED";\n');
    const expression = runtime === 'typescript'
      ? 'import { value } from "./allowed.ts"; const count: number = amount; `${value}:${count * 7}`'
      : 'import { value } from "./allowed.ts"; `${value}:${amount * 7}`';
    const result = await f.tool.execute({ mode: 'eval', runtime, expression, bindings: { amount: 6 }, workspaceRoot: f.owner });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output!)).toMatchObject({ runtime, result: 'CAPTURED_ALLOWED:42\n', isolated: true, stateless: true });
    expect(JSON.stringify(result)).not.toContain('LIVE_OWNER_CHANGED');
    expect((await f.tool.execute({ mode: 'eval', expression: 'typeof amount' })).output).toContain('undefined');
    expect(existsSync(join(f.owner, '.goodvibes', 'agent', 'repl-history.json'))).toBe(false);
  });
}

test.skipIf(!availability.available)('quoted multiline input and bindings remain one code argument', async () => {
  const f = await fixture();
  const text = "' ; $(touch shell-injected)\n`backticks` \\\"";
  const result = await f.tool.execute({ mode: 'eval', runtime: 'typescript', expression: 'const suffix: string = "\\\"quoted\\\"";\ntext + suffix', bindings: { text } });
  expect(result.success).toBe(true);
  expect(JSON.parse(result.output!).result).toBe(`${text}"quoted"\n`);
  expect(existsSync(join(f.root, 'shell-injected'))).toBe(false);
});

for (const side of ['original', 'copy'] as const) {
  test.skipIf(!availability.available)(`denied ${side} bytes and symlink aliases never reach the projection or result`, async () => {
    let denied = '';
    const f = await fixture(path => path !== denied);
    denied = join(side === 'original' ? f.owner : f.root, 'private.ts');
    symlinkSync(join(f.root, 'private.ts'), join(f.root, 'alias.ts'));
    const opened: string[] = [];
    const read = fs.readFile;
    const tap = spyOn(fs, 'readFile').mockImplementation(((path, ...args) => {
      opened.push(String(path)); return read(path, ...args);
    }) as typeof fs.readFile);
    try {
      const result = await f.tool.execute({ mode: 'eval', expression: 'import { value } from "./allowed.ts"; const fs = require("node:fs"); [value, fs.existsSync("private.ts"), fs.existsSync("alias.ts")]' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('CAPTURED_ALLOWED');
      expect(JSON.parse(result.output!).result).toContain('false, false');
      expect(JSON.stringify(result)).not.toContain('DENIED_REPL_BYTES');
      expect(opened).toContain(join(f.root, 'allowed.ts'));
      expect(opened).not.toContain(join(f.root, 'private.ts'));
      expect(opened).not.toContain(join(f.owner, 'private.ts'));
      expect(opened).not.toContain(join(f.root, 'alias.ts'));
    } finally { tap.mockRestore(); }
  });
}

test.skipIf(!availability.available)('authorized generated files survive only in a mutable member; owner, network and ambient env stay absent', async () => {
  const f = await fixture();
  const name = 'CAPTURED_REPL_SYNTHETIC_ENV'; process.env[name] = 'AMBIENT_REPL_MARKER';
  try {
    const result = await f.tool.execute({ mode: 'eval', expression: `const fs = require("node:fs"); fs.writeFileSync("generated.txt", "MEMBER_GENERATED"); let blocked = false; try { Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}}); } catch { blocked = true; } [fs.existsSync(${JSON.stringify(join(f.owner, 'allowed.ts'))}), fs.existsSync("/etc/passwd"), process.env.${name}, blocked]` });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output!).result).toContain('false, false, undefined, true');
    expect(readFileSync(join(f.root, 'generated.txt'), 'utf8')).toBe('MEMBER_GENERATED');
    expect(existsSync(join(f.owner, 'generated.txt'))).toBe(false);
    const followup = await f.tool.execute({ mode: 'eval', expression: 'require("node:fs").readFileSync("generated.txt", "utf8")' });
    expect(followup.success).toBe(true); expect(followup.output).toContain('MEMBER_GENERATED');
  } finally { delete process.env[name]; }
});

test.skipIf(!availability.available)('immutable captured eval reads but cannot publish writes', async () => {
  const f = await fixture(() => true, false);
  expect((await f.tool.execute({ mode: 'eval', expression: 'import { value } from "./allowed.ts"; value' })).success).toBe(true);
  await f.tool.execute({ mode: 'eval', expression: 'require("node:fs").writeFileSync("new.txt", "MUST_NOT_PERSIST")' });
  expect(existsSync(join(f.root, 'new.txt'))).toBe(false);
  expect(existsSync(join(f.owner, 'new.txt'))).toBe(false);
  const next = await f.tool.execute({ mode: 'eval', expression: 'require("node:fs").existsSync("new.txt")' });
  expect(next.success).toBe(true);
  expect(JSON.parse(next.output!)).toMatchObject({ result: 'false\n', workspace_changes_persist: false });
});

test('semantic safety denial reaches no evaluation backend', async () => {
  const f = await fixture();
  const spawn = spyOn(childProcess, 'spawn');
  try {
    const result = await f.tool.execute({ mode: 'eval', expression: '"REFUSED_REPL_ACTION"' });
    expect(result.success).toBe(false); expect(result.error).toContain('Command denied');
    expect(spawn).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); }
});

test.skipIf(!availability.available)('concurrent same-root authorities keep their own permissions and fresh evaluation state', async () => {
  const f = await fixture();
  const authority = await createContractInputAuthority(f.contract, f.root, { mutable: true, branch: `input/${f.contract.inputSnapshot!.id}` });
  const filter = async (path: string) => !path.endsWith('allowed.ts');
  const second = capturedInputTool(createCapturedReplTool({ ...f.binding, authority, readAccessFilter: filter }), authority, f.root, filter, undefined);
  const [firstResult, secondResult] = await Promise.all([
    f.tool.execute({ mode: 'eval', expression: 'globalThis.viewValue = 42; require("node:fs").readFileSync("allowed.ts", "utf8")' }),
    second.execute({ mode: 'eval', expression: '[typeof viewValue, require("node:fs").existsSync("allowed.ts")]' }),
  ]);
  expect(firstResult.success).toBe(true); expect(firstResult.output).toContain('CAPTURED_ALLOWED');
  expect(secondResult.success).toBe(true); expect(JSON.parse(secondResult.output!).result).toContain('"undefined", false');
  expect(secondResult.output).not.toContain('CAPTURED_ALLOWED');
});

test.skipIf(!availability.available)('a resumed authority gets a fresh binding while the previous tool remains revoked', async () => {
  const f = await fixture();
  expect((await f.tool.execute({ mode: 'eval', expression: 'globalThis.previousRun = 42; previousRun' })).success).toBe(true);
  revokeContractInputAuthority(f.binding.authority);
  const authority = await createContractInputAuthority(f.contract, f.root, { mutable: true, branch: `input/${f.contract.inputSnapshot!.id}` });
  const next = capturedInputTool(createCapturedReplTool({ ...f.binding, authority }), authority, f.root, f.binding.readAccessFilter, undefined);
  await expect(f.tool.execute({ mode: 'eval', expression: '"OLD_RUN"' })).rejects.toThrow('revoked');
  const result = await next.execute({ mode: 'eval', expression: 'typeof previousRun' });
  expect(result.success).toBe(true); expect(JSON.parse(result.output!).result).toBe('undefined\n');
});

test('construction binding rejects forged/copied/ordinary tools and foreign authority', async () => {
  const f = await fixture();
  expect(isCapturedReplTool(f.raw, f.binding.authority)).toBe(true);
  expect(isCapturedReplTool({ ...f.raw }, f.binding.authority)).toBe(false);
  expect(isCapturedReplTool(f.raw, { kind: 'contract-input-authority' })).toBe(false);
  let calls = 0;
  const forged = { definition: f.raw.definition, execute: async () => { calls++; return { success: true, output: 'FORGED_BACKEND' }; } };
  expect((await capturedInputTool(forged, f.binding.authority, f.root, f.binding.readAccessFilter, undefined).execute({ mode: 'eval', expression: '42' })).success).toBe(false);
  expect(calls).toBe(0);
  expect((await createCapturedReplTool({ ...f.binding, authority: { kind: 'contract-input-authority' } }).execute({ mode: 'eval', expression: '42' })).success).toBe(false);
  expect((await createCapturedReplTool({ ...f.binding, readAccessFilter: undefined }).execute({ mode: 'eval', expression: '42' })).success).toBe(false);
  const ordinary = createReplTool(new ConfigManager({ configDir: join(f.owner, '.config') }), new SandboxSessionRegistry(f.owner), { surfaceRoot: 'agent' });
  expect((await ordinary.execute({ mode: 'history', workspaceRoot: f.root })).success).toBe(false);
});

test('unsupported runtimes/history and oversized code do not start evaluation or read history', async () => {
  const f = await fixture();
  mkdirSync(join(f.root, '.goodvibes', 'agent'), { recursive: true });
  const history = join(f.root, '.goodvibes', 'agent', 'repl-history.json');
  writeFileSync(history, '[{"result":"UNRELATED_HISTORY_BYTES"}]');
  const spawn = spyOn(childProcess, 'spawn');
  const read = spyOn(fs, 'readFile');
  try {
    for (const args of [{ mode: 'history' }, ...['python', 'sql', 'graphql'].map(runtime => ({ mode: 'eval', runtime, expression: '42' })), { mode: 'eval', expression: 'x'.repeat(70_000) }]) {
      const result = await f.tool.execute(args);
      expect(result.success).toBe(false); expect(JSON.stringify(result)).not.toContain('UNRELATED_HISTORY_BYTES');
    }
    expect(spawn).not.toHaveBeenCalled();
    expect(read.mock.calls.some(args => String(args[0]) === history)).toBe(false);
  } finally { spawn.mockRestore(); read.mockRestore(); }
});

for (const interruption of ['abort', 'revoke', 'permission'] as const) {
  test.skipIf(!availability.available)(`${interruption} while evaluation runs withholds output and kills late publication`, async () => {
    let allowed = true;
    const f = await fixture(() => allowed);
    const controller = new AbortController();
    const originalSpawn = childProcess.spawn;
    let started = false;
    const tap = spyOn(childProcess, 'spawn').mockImplementation(((...args: Parameters<typeof childProcess.spawn>) => {
      const child = originalSpawn(...args);
      if (String(args[0]) === '/usr/bin/bwrap' && JSON.stringify(args[1]).includes('LATE_REPL_OUTPUT')) {
        started = true;
        setTimeout(() => { if (interruption === 'abort') controller.abort(); else if (interruption === 'revoke') revokeContractInputAuthority(f.binding.authority); else allowed = false; }, 50);
      }
      return child;
    }) as typeof childProcess.spawn);
    try {
      const result = await f.tool.execute({ mode: 'eval', expression: 'console.log("EARLY_REPL_OUTPUT"); await Bun.sleep(500); require("node:fs").writeFileSync("late.txt", "LATE_REPL_OUTPUT"); "LATE_REPL_OUTPUT"' }, { signal: controller.signal });
      expect(started).toBe(true); expect(result.success).toBe(false);
      expect(JSON.stringify(result)).not.toContain('EARLY_REPL_OUTPUT');
      expect(JSON.stringify(result)).not.toContain('LATE_REPL_OUTPUT');
      expect(existsSync(join(f.root, 'late.txt'))).toBe(false);
    } finally { tap.mockRestore(); }
  });
}

test('cancellation inside a permission await starts no late evaluation', async () => {
  const controller = new AbortController();
  const f = await fixture(async () => { await Promise.resolve(); controller.abort(); return true; });
  const spawn = spyOn(childProcess, 'spawn');
  try {
    const result = await f.tool.execute({ mode: 'eval', expression: '"NEVER_STARTED"' }, { signal: controller.signal });
    expect(result.success).toBe(false); expect(spawn).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); }
});

test.skipIf(!availability.available)('revocation of a previously read file prevents a later eval from releasing cached context', async () => {
  let allowed = true;
  const f = await fixture(path => allowed || !path.endsWith('allowed.ts'));
  expect((await f.tool.execute({ mode: 'eval', expression: 'require("node:fs").readFileSync("allowed.ts", "utf8")' })).success).toBe(true);
  allowed = false;
  const spawn = spyOn(childProcess, 'spawn');
  try {
    expect((await f.tool.execute({ mode: 'eval', expression: '"NO_REPLAY"' })).success).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); }
});

test.skipIf(!availability.available)('the execution deadline withholds partial output and leaves no late member changes', async () => {
  const f = await fixture();
  const result = await f.tool.execute({ mode: 'eval', expression: 'console.log("PARTIAL_TIMEOUT_OUTPUT"); await Bun.sleep(20_000); require("node:fs").writeFileSync("late-timeout.txt", "TOO_LATE")' });
  expect(result.success).toBe(false); expect(result.error).toContain('timed out');
  expect(JSON.stringify(result)).not.toContain('PARTIAL_TIMEOUT_OUTPUT');
  expect(existsSync(join(f.root, 'late-timeout.txt'))).toBe(false);
  expect((await f.tool.execute({ mode: 'eval', expression: '42' })).success).toBe(true);
}, 30_000);

test('unsupported host capability is surfaced without host fallback', async () => {
  const f = await fixture();
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'darwin' });
    const result = await f.tool.execute({ mode: 'eval', expression: 'require("node:fs").writeFileSync("host-fallback", "BAD")' });
    expect(result.success).toBe(false);
    expect(JSON.parse(result.output!).captured_exec_availability.reason).toBe('unsupported-platform');
    expect(existsSync(join(f.root, 'host-fallback'))).toBe(false);
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});
