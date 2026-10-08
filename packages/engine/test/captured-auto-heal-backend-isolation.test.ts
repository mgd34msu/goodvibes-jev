import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';
import type { ToolLLM, ToolLLMChatOptions } from '../sdk/src/platform/config/tool-llm.js';
import { createContractInputAuthority, revokeContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import { captureContractInput, contractInputPath, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import { createCapturedAutoHealBackend, type CapturedAutoHealBackend } from '../sdk/src/platform/tools/shared/captured-auto-heal.js';
import { capturedInputTool } from '../sdk/src/platform/tools/shared/captured-input-tools.js';
import { createWriteTool } from '../sdk/src/platform/tools/write/index.js';
import { useToolReadings } from './_helpers/tool-readings.js';

// Both the repair model and Jev acceptance are local fakes. No live provider,
// project-local formatter, or linter is needed for this authority proof.
useToolReadings([['', { fixesErrors: true, onlyTheFix: true }]]);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const original = 'export const original = 1;\n';
const broken = 'export const broken = ;\n';
const repairedA = 'export const repairedA = 2;\n';
const repairedB = 'export const repairedB = 3;\n';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}
async function fixture() {
  const owner = mkdtempSync(join(tmpdir(), 'captured-heal-backend-isolation-')); roots.push(owner);
  git(owner, 'init', '-q'); git(owner, 'config', 'user.name', 'Fixture'); git(owner, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(owner, '.gitignore'), '.goodvibes/\n');
  for (const name of ['a.ts', 'b.ts', 'substitute.ts']) writeFileSync(join(owner, name), original);
  git(owner, 'add', '.'); git(owner, 'commit', '-qm', 'fixture');
  const inputSnapshot = await captureContractInput(owner);
  const root = contractInputPath(inputSnapshot);
  const branch = `input/${inputSnapshot.id}`;
  git(owner, 'worktree', 'add', '--no-checkout', '-b', branch, root, inputSnapshot.inputCommit);
  await materializeContractInput(inputSnapshot, root);
  const configManager = { get: (() => true) as ConfigManager['get'], getWorkingDirectory: () => root };
  async function context() {
    const ownerController = new AbortController();
    const callController = new AbortController();
    let allowed = true;
    const filter = async () => allowed;
    // Admission belongs to a contract object and pins its cancellation signal.
    // Independent owners of the same view therefore have separate admissions.
    const contract = { projectRoot: owner, inputSnapshot } as Contract;
    const authority = await createContractInputAuthority(contract, root, { mutable: true, branch, signal: ownerController.signal });
    const binding = { authority, root, readAccessFilter: filter, signal: ownerController.signal };
    const backend = createCapturedAutoHealBackend(binding);
    const write = (path: string, chat: ToolLLM['chat'], selectedBackend: CapturedAutoHealBackend = backend) =>
      capturedInputTool(createWriteTool({ projectRoot: root, configManager, toolLLM: { chat }, capturedAutoHeal: selectedBackend }),
        authority, root, filter, ownerController.signal).execute({ files: [{ path, content: broken, mode: 'overwrite' }] },
        { signal: callController.signal });
    return { authority, backend, binding, ownerController, callController, write, revokePermission: () => { allowed = false; } };
  }
  const a = await context(); const b = await context();
  expect(a.authority).not.toBe(b.authority);
  expect(a.backend).not.toBe(b.backend);
  expect(a.binding.root).toBe(b.binding.root);
  expect(a.binding.readAccessFilter).not.toBe(b.binding.readAccessFilter);
  return { owner, root, a, b };
}
function pendingModel(content: string) {
  const entered = deferred<{ prompt: string; options: ToolLLMChatOptions }>();
  const release = deferred<void>();
  let calls = 0;
  let response: Promise<string> | undefined;
  const chat: ToolLLM['chat'] = (prompt, options = {}) => {
    calls++;
    // Deliberately ignore cancellation, exercising late uncooperative results.
    response = release.promise.then(() => content);
    entered.resolve({ prompt, options });
    return response;
  };
  return { chat, entered: entered.promise, release: () => release.resolve(), get calls() { return calls; },
    get response() { return response; } };
}
async function admitted(model: ReturnType<typeof pendingModel>, work: Promise<unknown>) {
  const request = await Promise.race([model.entered, work.then(() => { throw new Error('Write settled before its repair model was reached'); })]);
  expect(request.options.signal).toBeDefined();
  expect(request.options.signal!.aborted).toBe(false);
  expect(request.options.beforeAttempt).toBeFunction();
  return request;
}
function assertOwnerUntouched(f: Awaited<ReturnType<typeof fixture>>) {
  for (const name of ['a.ts', 'b.ts', 'substitute.ts']) expect(readFileSync(join(f.owner, name), 'utf8')).toBe(original);
}

// A path is not the publication lock's identity. These distinct targets let
// both genuine owners overlap without assuming isolation of competing writes
// to the same file, which is not the independent-writer contract.
test('same-root genuine backends retain their own bindings through overlapping repairs completed in reverse order', async () => {
  const f = await fixture(); const a = pendingModel(repairedA); const b = pendingModel(repairedB);
  const pendingA = f.a.write('a.ts', a.chat);
  let pendingB: ReturnType<typeof f.b.write> | undefined;
  try {
    const requestA = await admitted(a, pendingA);
    pendingB = f.b.write('b.ts', b.chat);
    const requestB = await admitted(b, pendingB);
    expect(requestA.prompt).toContain(join(f.root, 'a.ts'));
    expect(requestB.prompt).toContain(join(f.root, 'b.ts'));
    expect(requestA.options.signal).not.toBe(requestB.options.signal);
    expect(readFileSync(join(f.root, 'a.ts'), 'utf8')).toBe(broken);
    expect(readFileSync(join(f.root, 'b.ts'), 'utf8')).toBe(broken);
    b.release(); expect((await pendingB).success).toBe(true);
    expect(readFileSync(join(f.root, 'b.ts'), 'utf8')).toBe(repairedB);
    expect(readFileSync(join(f.root, 'a.ts'), 'utf8')).toBe(broken);
    expect(requestA.options.signal!.aborted).toBe(false);
    a.release(); expect((await pendingA).success).toBe(true);
    expect(readFileSync(join(f.root, 'a.ts'), 'utf8')).toBe(repairedA);
    expect(readFileSync(join(f.root, 'b.ts'), 'utf8')).toBe(repairedB);
    expect([a.calls, b.calls]).toEqual([1, 1]);
    assertOwnerUntouched(f);
  } finally { a.release(); b.release(); await Promise.allSettled([pendingA, pendingB]); }
});

for (const active of ['a', 'b'] as const)
  test(`same-root authority ${active} cannot lend its backend to another owner while its repair is pending`, async () => {
    const f = await fixture(); const other = active === 'a' ? 'b' : 'a';
    const first = pendingModel(repairedA); const second = pendingModel(repairedB);
    const pendingFirst = f[active].write(`${active}.ts`, first.chat);
    let pendingSecond: ReturnType<typeof f.b.write> | undefined; let substitutedCalls = 0;
    try {
      const requestFirst = await admitted(first, pendingFirst);
      const held = await f[other].write(`${other}.ts`, async () => { substitutedCalls++; return repairedB; }, f[active].backend);
      expect(held.success).toBe(false); expect(held.error).toContain('Output withheld');
      expect(substitutedCalls).toBe(0);
      expect(readFileSync(join(f.root, `${active}.ts`), 'utf8')).toBe(broken);
      expect(readFileSync(join(f.root, `${other}.ts`), 'utf8')).toBe(broken);
      expect(requestFirst.options.signal!.aborted).toBe(false);
      // The rejected substitution must not poison either legitimate backend.
      pendingSecond = f[other].write(`${other}.ts`, second.chat);
      await admitted(second, pendingSecond);
      second.release(); expect((await pendingSecond).success).toBe(true);
      first.release(); expect((await pendingFirst).success).toBe(true);
      expect(readFileSync(join(f.root, `${active}.ts`), 'utf8')).toBe(repairedA);
      expect(readFileSync(join(f.root, `${other}.ts`), 'utf8')).toBe(repairedB);
      expect([first.calls, second.calls]).toEqual([1, 1]);
      assertOwnerUntouched(f);
    } finally { first.release(); second.release(); await Promise.allSettled([pendingFirst, pendingSecond]); }
  });

for (const interruption of ['per-call cancellation', 'owner cancellation', 'authority revocation', 'permission revocation'] as const)
  test(`same-root ${interruption} holds only its pending repair and cannot confer a sibling backend or publish a late response`, async () => {
    const f = await fixture(); const a = pendingModel(repairedA); const b = pendingModel(repairedB);
    const pendingA = f.a.write('a.ts', a.chat);
    let pendingB: ReturnType<typeof f.b.write> | undefined;
    try {
      const requestA = await admitted(a, pendingA);
      pendingB = f.b.write('b.ts', b.chat);
      const requestB = await admitted(b, pendingB);
      if (interruption === 'per-call cancellation') f.a.callController.abort();
      else if (interruption === 'owner cancellation') f.a.ownerController.abort();
      else if (interruption === 'authority revocation') revokeContractInputAuthority(f.a.authority);
      else f.a.revokePermission();
      // Settlement occurs while both model promises are still gated. Revoked
      // permissions/authority must reach the owned signal without a response.
      const held = await pendingA;
      expect(held.success).toBe(false); expect(held.error).toContain('Output withheld');
      expect(requestA.options.signal!.aborted).toBe(true);
      expect(requestB.options.signal!.aborted).toBe(false);
      let borrowedCalls = 0;
      const borrowing = f.a.write('substitute.ts', async () => { borrowedCalls++; return repairedB; }, f.b.backend);
      // Revoked tokens/owner signals reject at context entry; call cancellation
      // and denied permissions are held inside the admitted tool wrapper.
      if (interruption === 'owner cancellation') await expect(borrowing).rejects.toBe(f.a.ownerController.signal.reason);
      else if (interruption === 'authority revocation') await expect(borrowing).rejects.toThrow('captured input authority is missing or revoked');
      else {
        const borrowed = await borrowing;
        expect(borrowed.success).toBe(false); expect(borrowed.error).toContain('Output withheld');
      }
      expect(borrowedCalls).toBe(0);
      expect(readFileSync(join(f.root, 'substitute.ts'), 'utf8')).toBe(original);
      a.release(); await a.response;
      // Drain reactions to the model's late result after the outer invocation
      // has settled. No timer-based assumption about provider progress.
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(readFileSync(join(f.root, 'a.ts'), 'utf8')).toBe(broken);
      expect(readFileSync(join(f.root, 'b.ts'), 'utf8')).toBe(broken);
      expect(requestB.options.signal!.aborted).toBe(false);
      b.release(); expect((await pendingB).success).toBe(true);
      expect(readFileSync(join(f.root, 'a.ts'), 'utf8')).toBe(broken);
      expect(readFileSync(join(f.root, 'b.ts'), 'utf8')).toBe(repairedB);
      // Even after A's lease settles, B cannot rebind that opaque backend.
      const stale = await f.b.write('substitute.ts', async () => { borrowedCalls++; return repairedA; }, f.a.backend);
      expect(stale.success).toBe(false); expect(stale.error).toContain('Output withheld');
      expect(borrowedCalls).toBe(0);
      expect(readFileSync(join(f.root, 'substitute.ts'), 'utf8')).toBe(broken);
      expect([a.calls, b.calls]).toEqual([1, 1]);
      assertOwnerUntouched(f);
    } finally { a.release(); b.release(); await Promise.allSettled([pendingA, pendingB]); }
  });
