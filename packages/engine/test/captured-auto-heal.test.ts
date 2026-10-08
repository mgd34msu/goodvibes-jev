import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installJudgmentPort } from '../errors/src/index.js';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';
import type { ToolLLM } from '../sdk/src/platform/config/tool-llm.js';
import { captureContractInput, contractInputPath, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.js';
import { createContractInputAuthority, revokeContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import { capturedInputTool } from '../sdk/src/platform/tools/shared/captured-input-tools.js';
import { createCapturedAutoHealBackend, type CapturedAutoHealBackend } from '../sdk/src/platform/tools/shared/captured-auto-heal.js';
import { createWriteTool } from '../sdk/src/platform/tools/write/index.js';
import { probeCapturedExecAvailability } from '../sdk/src/platform/tools/exec/captured-exec.js';
import { toolReadingsPort } from './_helpers/tool-readings.js';

const roots: string[] = [];
const restorers: (() => void)[] = [];
afterEach(() => { for (const restore of restorers.splice(0)) restore(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const broken = 'export function value() { return 1;\n';
const repaired = 'export function value() { return 1; }\n';
const config: Pick<ConfigManager, 'get'> = { get: (() => true) as ConfigManager['get'] };
const available = (await probeCapturedExecAvailability()).available;
function install(port: JudgmentPort): void { const previous = installJudgmentPort(port); restorers.push(() => { installJudgmentPort(previous); }); }
function readings() { return toolReadingsPort([['', { fixesErrors: true, onlyTheFix: true }]]); }
function git(root: string, ...args: string[]): void { const result = spawnSync('git', ['-C', root, ...args]); if (result.status !== 0) throw Error(result.stderr.toString()); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture(stage?: 'formatter' | 'linter' | 'biome', mutable = true) {
  const owner = mkdtempSync(join(tmpdir(), 'captured-auto-heal-')); roots.push(owner);
  git(owner, 'init', '-q'); git(owner, 'config', 'user.name', 'Fixture'); git(owner, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(owner, 'value.ts'), 'export const original = 1;\n');
  writeFileSync(join(owner, '.gitignore'), '.goodvibes/\n');
  if (stage) {
    mkdirSync(join(owner, 'node_modules/.bin'), { recursive: true });
    const path = join(owner, 'node_modules/.bin', stage === 'formatter' ? 'prettier' : stage === 'biome' ? 'biome' : 'eslint');
    writeFileSync(path, `#!/bin/sh\ncase "$*" in *--no-config*|*--config-path=/tmp/biome.json*) ;; *) exit 9;; esac\nfor target do :; done\nprintf '%s' '${repaired}' > "$target"\nprintf forbidden > side-effect.txt\n`);
    chmodSync(path, 0o755);
    writeFileSync(join(owner, 'prettier.config.js'), 'throw Error("project config must not execute")');
  }
  git(owner, 'add', '.'); git(owner, 'commit', '-qm', 'fixture');
  const inputSnapshot = await captureContractInput(owner); const root = contractInputPath(inputSnapshot); const branch = `input/${inputSnapshot.id}`;
  git(owner, 'worktree', 'add', '--no-checkout', '-b', branch, root, inputSnapshot.inputCommit); await materializeContractInput(inputSnapshot, root);
  const controller = new AbortController(); const contract = { projectRoot: owner, inputSnapshot } as Contract;
  const authority = await createContractInputAuthority(contract, root, { mutable, branch, signal: controller.signal });
  let permitted = true;
  const filter = async () => permitted;
  const backend = createCapturedAutoHealBackend({ authority, root, readAccessFilter: filter, signal: controller.signal });
  const tool = (chat: ToolLLM['chat'], selected: CapturedAutoHealBackend | undefined = backend) => capturedInputTool(createWriteTool({ projectRoot: root, configManager: config, toolLLM: { chat }, capturedAutoHeal: selected }), authority, root, filter, controller.signal);
  return { owner, root, controller, authority, backend, contract, branch, tool, deny: () => { permitted = false; } };
}
const args = { files: [{ path: 'value.ts', content: broken, mode: 'overwrite' }], verbosity: 'verbose' };

test('required captured repair stage proof cannot skip containment', () => { if (process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT === '1') expect(available).toBe(true); });
for (const stage of ['formatter', 'linter', 'biome'] as const) test.skipIf(!available)(`captured ${stage} candidate is judged before target-only publication`, async () => {
  const f = await fixture(stage); const port = readings(); install(port.port); let calls = 0;
  const result = await f.tool(async () => { calls++; return repaired; }).execute(args);
  expect(result.success).toBe(true); expect(calls).toBe(0);
  expect(JSON.parse(result.output!).files[0].auto_heal).toEqual({ attempted: true, healed: true, method: stage === 'biome' ? 'formatter' : stage });
  expect(readFileSync(join(f.root, 'value.ts'), 'utf8')).toBe(repaired);
  expect(existsSync(join(f.root, 'side-effect.txt'))).toBe(false); expect(existsSync(join(f.owner, 'side-effect.txt'))).toBe(false);
  expect(readFileSync(join(f.owner, 'value.ts'), 'utf8')).toContain('original');
  expect(port.requests.some((request) => Object.hasOwn(request.questions, 'fixes_errors'))).toBe(true);
});

for (const boundary of ['model', 'judgment'] as const) for (const change of ['cancel', 'revoke', 'deny'] as const) test(`captured ${boundary} ${change} aborts the owned signal and blocks late repair`, async () => {
  const f = await fixture(); const started = deferred(); const release = deferred(); let observedSignal: AbortSignal | undefined; let judgments = 0; let calls = 0;
  const base = readings().port;
  install({ model: base.model, async ask(request) {
    judgments++;
    if (boundary === 'judgment') { observedSignal = request.signal; started.resolve(); await release.promise; }
    return base.ask(request);
  } });
  const pending = f.tool(async (_prompt, options) => {
    calls++; if (boundary === 'model') { observedSignal = options?.signal; started.resolve(); await release.promise; }
    return repaired;
  }).execute(args);
  await started.promise;
  if (change === 'cancel') f.controller.abort(); else if (change === 'revoke') revokeContractInputAuthority(f.authority); else f.deny();
  const result = await Promise.race([pending, Bun.sleep(4000).then(() => { throw Error('repair failed to settle while backend ignored cancellation'); })]);
  expect(result.success).toBe(false); expect(result.output).toBeUndefined(); expect(observedSignal?.aborted).toBe(true);
  expect(readFileSync(join(f.root, 'value.ts'), 'utf8')).toBe(broken);
  const before = judgments; release.resolve(); await Bun.sleep(100);
  expect(calls).toBe(1); expect(judgments).toBe(before); if (boundary === 'model') expect(judgments).toBe(0);
  expect(readFileSync(join(f.root, 'value.ts'), 'utf8')).toBe(broken);
});

for (const mode of ['forged', 'wrong-owner', 'immutable', 'alias'] as const) test(`captured repair ${mode} never reaches the provider`, async () => {
  const f = await fixture(undefined, mode !== 'immutable'); install(readings().port); let calls = 0;
  let backend = f.backend;
  if (mode === 'forged') backend = { kind: 'captured-auto-heal-backend' };
  if (mode === 'wrong-owner') { const other = await fixture(); backend = other.backend; }
  if (mode === 'alias') { rmSync(join(f.root, 'value.ts')); symlinkSync(join(f.owner, 'value.ts'), join(f.root, 'value.ts')); }
  const result = await f.tool(async () => { calls++; return repaired; }, backend).execute(args);
  expect(result.success).toBe(false); expect(result.output).toBeUndefined(); expect(calls).toBe(0);
  expect(readFileSync(join(f.owner, 'value.ts'), 'utf8')).toContain('original');
});

for (const boundary of ['model', 'judgment'] as const) test(`captured ${boundary} retry rechecks async policy before any next dispatch`, async () => {
  const f = await fixture(); let transmissions = 0; let gates = 0;
  const base = readings().port;
  install({ model: base.model, async ask(request) {
    if (boundary === 'judgment') {
      expect(request.beforeAsyncAttempt).toBeFunction(); expect(request.beforeAttempt).toBeFunction();
      gates++; await request.beforeAsyncAttempt?.(); request.beforeAttempt?.(); transmissions++;
      f.deny();
      gates++; await request.beforeAsyncAttempt?.(); request.beforeAttempt?.(); transmissions++;
    }
    return base.ask(request);
  } });
  const result = await f.tool(async (_prompt, options) => {
    if (boundary === 'model') {
      expect(options?.beforeAttempt).toBeFunction();
      gates++; await options?.beforeAttempt?.(); transmissions++;
      f.deny();
      gates++; await options?.beforeAttempt?.(); transmissions++;
    }
    return repaired;
  }).execute(args);
  expect(result.success).toBe(false); expect(result.output).toBeUndefined();
  expect(gates).toBe(2); expect(transmissions).toBe(1);
  expect(readFileSync(join(f.root, 'value.ts'), 'utf8')).toBe(broken);
});
