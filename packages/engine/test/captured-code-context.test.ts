/** Real mutable worktree receipts and stored original-path policy; synthetic providers only. */
import { expect, test, spyOn } from 'bun:test';
import { installJudgmentPort } from '../errors/src/index.js';
import { fakePort, noulAnswer, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import * as fs from 'node:fs';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, unlinkSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPerTurnKnowledgeInjection } from '../sdk/src/platform/agents/turn-knowledge-injection.js';
import { createCapturedCodeContext } from '../sdk/src/platform/agents/captured-code-context.js';
import { captureContractInput, materializeContractInput, contractInputPath } from '../sdk/src/platform/contract/input-snapshot.js';
import { createContractInputAuthority, revokeContractInputAuthority, type ContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import { ConfigManager } from '../sdk/src/platform/config/index.js';
import { MemoryEmbeddingProviderRegistry, type MemoryEmbeddingRequest } from '../sdk/src/platform/state/memory-embeddings.js';
import { createClientRuntimeServices } from '../sdk/src/platform/runtime/bootstrap.js';
import { createRuntimeStore, RuntimeEventBus } from '../sdk/src/platform/runtime/state.js';
import { createLaunchTolerantProviderRegistry } from '../sdk/src/platform/providers/index.js';

const PRIVATE = 'PRIVATE_CAPTURED_UNIT_MARKER';
const ORIGINAL = 'CAPTURED_UNIT_ORIGINAL';
const REVISED = 'CAPTURED_UNIT_REVISED_';
function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}
async function fixture(run: (context: {
  root: string; view: string; contract: Contract; authority: ContractInputAuthority; registry: MemoryEmbeddingProviderRegistry;
  source: ReturnType<typeof createCapturedCodeContext>; calls: MemoryEmbeddingRequest[]; stop: AbortController;
  deny: (path: string) => Promise<void>; readAccessFilter: (path: string) => Promise<boolean>;
}) => Promise<void>, mutable = true): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'captured-code-unit-'));
  let dispose: (() => void) | undefined;
  let disposeRuntime: (() => void) | undefined;
  let restoreJudgment: (() => void) | undefined;
  try {
    git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(root, '.gitignore'), '.goodvibes/\nignored.txt\n');
    writeFileSync(join(root, 'allowed.txt'), ORIGINAL);
    writeFileSync(join(root, 'private.txt'), PRIVATE);
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
    const receipt = await captureContractInput(root);
    const view = contractInputPath(receipt);
    git(root, 'worktree', 'add', '--no-checkout', '-b', 'unit-view', view, receipt.inputCommit);
    await materializeContractInput(receipt, view);
    const stop = new AbortController();
    const contract = { inputSnapshot: receipt, projectRoot: root } as Contract;
    const authority = await createContractInputAuthority(contract,
      view, { mutable, branch: 'unit-view', signal: stop.signal });
    const config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(root, '.goodvibes', 'cfg'), workingDir: root, homeDir: root });
    config.set('permissions.engine', 'policy-engine'); config.set('permissions.mode', 'prompt'); config.set('behavior.autoApprove', false);
    const runtime = createClientRuntimeServices({ surfaceRoot: 'agent', configManager: config, workingDir: root, homeDirectory: root,
      requestApproval: async () => ({ approved: false }), runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), modelDiscovery: 'skip', providerRegistryFactory: createLaunchTolerantProviderRegistry });
    disposeRuntime = () => runtime.dispose();
    const previous = installJudgmentPort(fakePort((name, question) => {
      if (question.type === 'choice') {
        if (name !== 'family' || !('file-mutation' in question.criteria)) throw new Error('Unexpected unit judgment');
        return choiceAnswer(question, 'file-mutation', 0.99);
      }
      return noulAnswer(0.01);
    }).port);
    restoreJudgment = () => installJudgmentPort(previous);
    let rule = 0;
    const deny = async (path: string): Promise<void> => {
      await runtime.userPermissionRuleStore.add({ rule: { id: `unit-deny-${++rule}`, type: 'path-scope', origin: 'user', effect: 'deny', toolPattern: 'read', pathPatterns: [path] }, createdAt: Date.now(), tier: 'path', tool: 'read' });
    };
    await deny(join(root, 'private.txt'));
    const calls: MemoryEmbeddingRequest[] = [];
    const registry = new MemoryEmbeddingProviderRegistry({ configManager: config });
    registry.register({ id: 'captured-unit-semantic', label: 'Synthetic unit provider', dimensions: 384, capturedInputAdmission: 'per-attempt', async embed(request) {
      calls.push(request); await request.beforeAttempt?.();
      const vector = new Float32Array(384); vector[0] = 1;
      return { vector, dimensions: 384 };
    } }, { makeDefault: true });
    const readAccessFilter = async (path: string): Promise<boolean> => await runtime.permissionManager.readAccess(path) === 'allow';
    const source = createCapturedCodeContext({ authority, root: view, registry, readAccessFilter, signal: stop.signal });
    dispose = () => source.dispose?.();
    await run({ root, view, contract, authority, registry, source, calls, stop, deny, readAccessFilter });
  } finally { dispose?.(); disposeRuntime?.(); restoreJudgment?.(); rmSync(root, { recursive: true, force: true }); }
}

test('mutable captured context opens only permitted source bytes and embeds allowed content', async () => fixture(async ({ view, source, calls }) => {
  const originalOpen = fs.openSync;
  const opened: string[] = [];
  const tap = spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    opened.push(String(args[0])); return originalOpen(...args);
  }) as typeof fs.openSync);
  try {
    await source.prepare?.();
    const results = await source.search('captured');
    expect(results.some((result) => result.chunk.path === 'allowed.txt')).toBe(true);
    expect(calls.some((call) => call.text.includes(ORIGINAL))).toBe(true);
    expect(calls.some((call) => call.text.includes(PRIVATE))).toBe(false);
    expect(opened).toContain(join(view, 'allowed.txt'));
    expect(opened).not.toContain(join(view, 'private.txt'));
  } finally { tap.mockRestore(); }
}), 30_000);

test('mutable edits, same-line rewrites, generated and deleted files refresh generation', async () => fixture(async ({ view, source, calls }) => {
  await source.prepare?.();
  const first = source.generation?.();
  writeFileSync(join(view, 'allowed.txt'), REVISED);
  writeFileSync(join(view, 'generated.txt'), 'CAPTURED_GENERATED');
  await expect(source.assertCurrent?.(first)).rejects.toThrow();
  calls.length = 0;
  await source.prepare?.();
  expect(source.generation?.()).not.toBe(first);
  expect(calls.some((call) => call.text.includes(REVISED))).toBe(true);
  expect(calls.some((call) => call.text.includes(ORIGINAL))).toBe(false);
  expect((await source.search('captured')).some((result) => result.chunk.path === 'generated.txt')).toBe(true);
  unlinkSync(join(view, 'generated.txt'));
  await source.prepare?.();
  expect((await source.search('captured')).some((result) => result.chunk.path === 'generated.txt')).toBe(false);
}), 30_000);

test('stored policy revocation prevents cached results and any later query embedding', async () => fixture(async ({ root, source, calls, deny }) => {
  await source.prepare?.();
  const count = calls.length;
  await deny(join(root, 'allowed.txt'));
  await expect(source.search('captured')).rejects.toThrow();
  expect(calls.length).toBe(count);
}), 30_000);

test('revoked authority, wrong root, forged authority, and missing policy fail closed', async () => fixture(async ({ view, authority, registry, source, calls, readAccessFilter }) => {
  for (const input of [
    { authority: undefined as unknown as ContractInputAuthority, root: view, registry, readAccessFilter },
    { authority: JSON.parse(JSON.stringify(authority)) as ContractInputAuthority, root: view, registry, readAccessFilter },
    { authority, root: join(view, 'wrong'), registry, readAccessFilter },
    { authority, root: view, registry },
  ]) {
    let other: ReturnType<typeof createCapturedCodeContext> | undefined;
    try {
      try { other = createCapturedCodeContext(input); } catch { continue; }
      await expect(other.prepare?.()).rejects.toThrow();
    } finally { other?.dispose?.(); }
  }
  revokeContractInputAuthority(authority);
  await expect(source.prepare?.()).rejects.toThrow();
  expect(calls.length).toBe(0);
}), 30_000);

test('symlinked captured file cannot redirect a captured byte open', async () => fixture(async ({ root, view, source, calls }) => {
  unlinkSync(join(view, 'allowed.txt'));
  symlinkSync(join(root, 'private.txt'), join(view, 'allowed.txt'));
  await expect(source.prepare?.()).rejects.toThrow();
  expect(calls.length).toBe(0);
}), 30_000);

test('abort during a pending async provider prevents cache or result publication', async () => fixture(async ({ source, registry, stop }) => {
  const provider = registry.getDefaultProvider();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  registry.register({ ...provider, async embed() {
    entered(); await pending;
    const vector = new Float32Array(384); vector[0] = 1;
    return { vector, dimensions: 384 };
  } }, { replace: true });
  const prepared = source.prepare!();
  await started;
  stop.abort(new Error('unit stopped'));
  await expect(prepared).rejects.toThrow('unit stopped');
  release();
  await expect(source.search('captured')).rejects.toThrow('unit stopped');
}), 30_000);

test('redirecting an already prepared captured root cannot reuse its cache', async () => fixture(async ({ root, view, source, calls }) => {
  await source.prepare?.();
  const count = calls.length;
  const moved = `${view}-moved`;
  renameSync(view, moved);
  symlinkSync(root, view);
  await expect(source.search('captured')).rejects.toThrow();
  expect(calls.length).toBe(count);
}), 30_000);

test('immutable captured context excludes post-capture ignored content from delegated opens and embeddings', async () => fixture(async ({ view, source, calls }) => {
  const poisonPath = join(view, 'ignored.txt');
  writeFileSync(poisonPath, 'UNCAPTURED_IGNORED_MARKER');
  // This tap covers this adapter's synchronous delegated byte opens only. Host
  // receipt validation may independently hash bytes through other filesystem APIs.
  const originalOpen = fs.openSync;
  const opened: string[] = [];
  const tap = spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    opened.push(String(args[0])); return originalOpen(...args);
  }) as typeof fs.openSync);
  try {
    await source.prepare?.();
    expect(calls.some((call) => call.text.includes(ORIGINAL))).toBe(true);
    expect(calls.some((call) => call.text.includes('UNCAPTURED_IGNORED_MARKER'))).toBe(false);
    expect(opened).not.toContain(poisonPath);
    expect((await source.search('captured')).some((result) => result.chunk.path === 'ignored.txt')).toBe(false);
  } finally { tap.mockRestore(); }
}, false), 30_000);

test('exact root-policy revocation blocks cached search while both child paths remain permitted', async () => fixture(async ({ root, view, authority, registry, calls, readAccessFilter }) => {
  let revoked = false;
  const filter = async (path: string): Promise<boolean> => !(revoked && (path === root || path === view)) && await readAccessFilter(path);
  const source = createCapturedCodeContext({ authority, root: view, registry, readAccessFilter: filter });
  try {
    await source.prepare?.();
    const count = calls.length;
    revoked = true;
    expect(await filter(join(root, 'allowed.txt'))).toBe(true);
    expect(await filter(join(view, 'allowed.txt'))).toBe(true);
    await expect(source.search('captured')).rejects.toThrow('root is access-restricted');
    expect(calls.length).toBe(count);
  } finally { source.dispose?.(); }
}), 30_000);

test('missing, hashed, unregistered, and unsupported providers gate before delegated source opens', async () => fixture(async ({ view, authority, registry, calls, readAccessFilter }) => {
  const semantic = registry.getDefaultProvider();
  const originalOpen = fs.openSync;
  const opened: string[] = [];
  const tap = spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).startsWith(`${view}/`)) opened.push(String(args[0]));
    return originalOpen(...args);
  }) as typeof fs.openSync);
  try {
    for (const kind of ['missing', 'hashed', 'unregistered', 'dimensions', 'unsupported', 'opaque']) {
      registry.register(semantic, { replace: true, makeDefault: true });
      if (kind === 'hashed') registry.setDefaultProvider('hashed-local');
      if (kind === 'unregistered') registry.unregister(semantic.id);
      if (kind === 'dimensions') registry.register({ ...semantic, dimensions: 7 }, { replace: true });
      if (kind === 'opaque') registry.register({ ...semantic, capturedInputAdmission: undefined }, { replace: true });
      if (kind === 'unsupported') registry.register({ id: semantic.id, label: semantic.label, dimensions: 384 }, { replace: true });
      const source = createCapturedCodeContext({ authority, root: view, registry: kind === 'missing' ? undefined : registry, readAccessFilter });
      try {
        await source.prepare?.();
        expect(source.stats().available).toBe(false);
        expect(await source.search('captured')).toEqual([]);
      } finally { source.dispose?.(); }
    }
    expect(opened).toEqual([]);
    expect(calls).toEqual([]);
  } finally { tap.mockRestore(); }
}), 30_000);

test('immutable same-line rewrite rejects before any additional embedding', async () => fixture(async ({ view, source, calls }) => {
  await source.prepare?.();
  const count = calls.length;
  expect(ORIGINAL.length).toBe(REVISED.length);
  writeFileSync(join(view, 'allowed.txt'), REVISED);
  await expect(source.search('captured')).rejects.toThrow();
  expect(calls.length).toBe(count);
}, false), 30_000);

test('same-root copied receipt cannot rebind an admitted captured generation', async () => fixture(async ({ contract, source, calls }) => {
  await source.prepare?.();
  const count = calls.length;
  Object.assign(contract, { inputSnapshot: structuredClone(contract.inputSnapshot) });
  await expect(source.search('captured')).rejects.toThrow('receipt changed after admission');
  expect(calls.length).toBe(count);
}), 30_000);

test('regular-file to FIFO replacement requires nonblocking open and rejects before reading bytes', async () => fixture(async ({ view, source, calls }) => {
  const target = join(view, 'allowed.txt');
  const originalOpen = fs.openSync;
  let replaced = false;
  let nonblocking = false;
  const tap = spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]) === target && !replaced) {
      nonblocking = typeof args[1] === 'number' && (args[1] & fs.constants.O_NONBLOCK) !== 0;
      // Never invoke a potentially blocking FIFO open, even if production regresses.
      if (!nonblocking) throw new Error('unsafe blocking open flags');
      unlinkSync(target);
      const fifo = spawnSync('mkfifo', [target]);
      if (fifo.status !== 0) throw new Error(fifo.stderr.toString());
      replaced = true;
    }
    return originalOpen(...args);
  }) as typeof fs.openSync);
  try {
    await expect(source.prepare?.()).rejects.toThrow('changed before open');
    expect(replaced).toBe(true);
    expect(nonblocking).toBe(true);
    expect(calls.length).toBe(0);
  } finally { tap.mockRestore(); }
}), 30_000);


test('captured vector injection applies the canonical relevance owner to authorized snapshots', async () => fixture(async ({ source }) => {
  const fake = fakePort((name, question) => question.type === 'choice' ? choiceAnswer(question, 'file-mutation', 0.99) : noulAnswer(name === 'match' ? 0.99 : 0.01));
  const previous = installJudgmentPort(fake.port);
  try {
    const result = await buildPerTurnKnowledgeInjection({ task: ORIGINAL, conversationTail: [], memoryRegistry: { getAll: () => [] },
      codeIndex: source, codeInjectionEnabled: true, budgetTokens: 4000, relevanceFloor: 95, alreadyInjectedIds: [], turn: 1 });
    expect(result.record.injectedSources).toContain('code-index');
    expect(fake.requests.some(request => request.context?.battery === 'engine.state.code-search')).toBe(true);
    expect(JSON.stringify(fake.requests)).not.toContain(PRIVATE);
    await source.assertCurrent?.();
    installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
    await expect(source.assertCurrent!()).rejects.toThrow();
  } finally { installJudgmentPort(previous); }
}));


test('captured vector relevance cannot publish after its source file changes during the reading', async () => fixture(async ({ source, view }) => {
  const fake = fakePort((name, question) => {
    if (name === 'match') writeFileSync(join(view, 'allowed.txt'), REVISED);
    return question.type === 'choice' ? choiceAnswer(question, 'file-mutation', 0.99) : noulAnswer(name === 'match' ? 0.99 : 0.01);
  });
  const previous = installJudgmentPort(fake.port);
  try {
    await expect(buildPerTurnKnowledgeInjection({ task: ORIGINAL, conversationTail: [], memoryRegistry: { getAll: () => [] },
      codeIndex: source, codeInjectionEnabled: true, budgetTokens: 4000, relevanceFloor: 95, alreadyInjectedIds: [], turn: 1 })).rejects.toThrow();
    expect(fake.requests.some(request => request.context?.battery === 'engine.state.code-search')).toBe(true);
  } finally { installJudgmentPort(previous); }
}));
