import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDecisionLog } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../sdk/src/platform/core/orchestrator-tool-runtime.ts';
import { createClientRuntimeServices, type ClientRuntimeServices } from '../sdk/src/platform/runtime/client-services.ts';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../sdk/src/platform/runtime/store/index.ts';
import { createShellPathService } from '../sdk/src/platform/runtime/shell-paths.ts';
import { WorkspaceTrustManager } from '../sdk/src/platform/runtime/workspace-trust.ts';
import { FileStateCache } from '../sdk/src/platform/state/file-cache.ts';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import { createWriteTool } from '../sdk/src/platform/tools/write/index.ts';
import { createEditTool } from '../sdk/src/platform/tools/edit/core.ts';
import { runValidators } from '../sdk/src/platform/tools/shared/validators.ts';
import type { Tool } from '../sdk/src/platform/types/tools.ts';
import { toolReadingsPort } from './_helpers/tool-readings.ts';
import { forgetGateReadings } from './_helpers/gate-readings.ts';

let root: string; let services: ClientRuntimeServices; let trust: WorkspaceTrustManager; let restore: () => void;
let sourceGoal: string; let humanAsks: number; let nextCall = 0;
beforeEach(async () => {
  forgetGateReadings(); humanAsks = 0; nextCall = 0; sourceGoal = 'Change only owned local fixture files';
  root = mkdtempSync(join(tmpdir(), 'native-file-effect-'));
  const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir: join(root, 'config'), workingDir: root, homeDir: root });
  trust = new WorkspaceTrustManager({ shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }), surfaceRoot: 'tui' });
  await trust.setLevel('trusted');
  services = createClientRuntimeServices({ configManager, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), surfaceRoot: 'tui',
    workingDir: root, homeDirectory: root, modelDiscovery: 'skip', workspaceTrust: trust,
    requestApproval: async () => { humanAsks++; return { approved: false }; } });
  const readings = toolReadingsPort();
  const semantic = fakePort((_name, question) => choiceAnswer(question, 'act', 0.98));
  const recorded = withDecisionLog({ model: readings.port.model, ask: request => 'disposition' in request.questions ? semantic.port.ask(request) : readings.port.ask(request) }, services.judgment.decisionLog);
  const spy = spyOn(services.judgment.port, 'ask').mockImplementation(recorded.ask); restore = () => spy.mockRestore();
});
afterEach(() => { restore?.(); services?.dispose(); if (root) rmSync(root, { recursive: true, force: true }); forgetGateReadings(); });
function run(tool: Tool, args: Record<string, unknown>, signal?: AbortSignal) {
  const registry = new ToolRegistry(services.permissionManager); registry.register(tool);
  const deps: ToolExecutionDeps = { autonomousSource: () => ({ goal: sourceGoal, criteria: ['No human wait', 'Keep current policy and source authority'] }),
    permissionManager: services.permissionManager, toolRegistry: registry, hookDispatcher: null, runtimeBus: null, turnSignal: signal,
    sessionId: 'file-effect', emitterContext: () => ({ sessionId: 'file-effect', traceId: 'fixture', source: 'orchestrator' }) };
  const id = `file-effect-${++nextCall}`;
  return executeToolCalls(deps, id, [{ id, name: tool.definition.name, arguments: args }]);
}
const writeArgs = () => ({ files: [{ path: 'owned.txt', content: 'owned replacement', mode: 'overwrite' }] });
const editArgs = () => ({ edits: [{ path: 'owned.txt', find: 'before', replace: 'owned replacement' }], validate: { before: ['test'] } });

test('actual admitted Write and Edit preserve positive file effects', async () => {
  expect((await run(createWriteTool({ projectRoot: root }), writeArgs()))[0]!.success).toBe(true);
  writeFileSync(join(root, 'owned.txt'), 'before');
  expect((await run(createEditTool(new FileStateCache(), { cwd: root }), { edits: [{ path: 'owned.txt', find: 'before', replace: 'after' }] }))[0]!.success).toBe(true);
  expect(readFileSync(join(root, 'owned.txt'), 'utf8')).toBe('after'); expect(humanAsks).toBe(0);
});
for (const revocation of ['restricted', 'aba', 'cancel', 'config', 'source'] as const) test(`Write final effect fences ${revocation} during awaited path preparation`, async () => {
  const controller = new AbortController();
  const tool = createWriteTool({ projectRoot: root, capturedReadAccess: async () => {
    if (revocation === 'restricted' || revocation === 'aba') await trust.setLevel('restricted');
    if (revocation === 'aba') await trust.setLevel('trusted');
    if (revocation === 'cancel') controller.abort(new Error('fixture cancelled'));
    if (revocation === 'config') services.configManager.set('sandbox.enabled', false);
    if (revocation === 'source') sourceGoal = 'New owner task';
    return true;
  } });
  await run(tool, writeArgs(), controller.signal).catch(() => {});
  expect(existsSync(join(root, 'owned.txt'))).toBe(false); expect(humanAsks).toBe(0);
});
test('Edit final effect fences restriction during awaited pre-validation', async () => {
  writeFileSync(join(root, 'owned.txt'), 'before');
  const result = await run(createEditTool(new FileStateCache(), { cwd: root, validatorRunner: async validator => {
    await trust.setLevel('restricted'); return { validator, passed: true, exitCode: 0, stdout: '', stderr: '' };
  } }), editArgs());
  expect(result[0]!.success).toBe(false); expect(readFileSync(join(root, 'owned.txt'), 'utf8')).toBe('before');
});
for (const name of ['write', 'edit'] as const) for (const copied of ['args', 'options', 'missing'] as const) test(`${name} cannot downgrade ${copied} through an authentic wrapper`, async () => {
  writeFileSync(join(root, 'owned.txt'), 'before');
  const raw = name === 'write' ? createWriteTool({ projectRoot: root }) : createEditTool(new FileStateCache(), { cwd: root });
  const wrapped: Tool = { ...raw, execute: (args, options) => raw.execute(copied === 'args' ? { ...args } : args, copied === 'missing' ? undefined : copied === 'options' ? { ...options } : options) };
  const result = await run(wrapped, name === 'write' ? writeArgs() : { edits: [{ path: 'owned.txt', find: 'before', replace: 'after' }] });
  expect(result[0]!.success).toBe(false); expect(readFileSync(join(root, 'owned.txt'), 'utf8')).toBe('before');
});
test('notebook final publication checks current policy after read preparation', async () => {
  const original = JSON.stringify({ nbformat: 4, nbformat_minor: 5, cells: [{ cell_type: 'code', source: ['before'], metadata: {}, outputs: [], execution_count: null }], metadata: {} });
  writeFileSync(join(root, 'owned.ipynb'), original);
  const cache = new FileStateCache(); const lookup = cache.lookup.bind(cache);
  let pending: Promise<void> | undefined;
  const spy = spyOn(cache, 'lookup').mockImplementation(path => { pending ??= trust.setLevel('restricted'); return lookup(path); });
  try {
    const result = await run(createEditTool(cache, { cwd: root }), { notebook_operations: { path: 'owned.ipynb', operations: [{ op: 'replace', cell: 0, source: 'after' }] } });
    expect(result[0]!.success).toBe(false); expect(readFileSync(join(root, 'owned.ipynb'), 'utf8')).toBe(original);
  } finally { await pending; spy.mockRestore(); }
});
for (const external of [false, true]) test(`atomic Edit compensation after revocation preserves ${external ? 'external newer bytes' : 'original bytes'}`, async () => {
  writeFileSync(join(root, 'owned.txt'), 'before');
  const tool = createEditTool(new FileStateCache(), { cwd: root, validatorRunner: async validator => {
    await trust.setLevel('restricted');
    if (external) writeFileSync(join(root, 'owned.txt'), 'external update');
    return { validator, passed: false, exitCode: 1, stdout: '', stderr: 'fixture invalid' };
  } });
  const result = await run(tool, { edits: [{ path: 'owned.txt', find: 'before', replace: 'after' }], validate: { after: ['test'] }, transaction: { mode: 'atomic' } });
  expect(result[0]!.success).toBe(false); expect(readFileSync(join(root, 'owned.txt'), 'utf8')).toBe(external ? 'external update' : 'before');
  if (external) expect(result[0]!.error ?? result[0]!.output).toContain('rollback incomplete');
});
test('subsequent validators cannot start after an awaited validator revokes the invocation', async () => {
  writeFileSync(join(root, 'owned.txt'), 'before'); let calls = 0;
  const tool = createEditTool(new FileStateCache(), { cwd: root, validatorRunner: async validator => {
    calls++; await trust.setLevel('restricted'); return { validator, passed: true, exitCode: 0, stdout: '', stderr: '' };
  } });
  await run(tool, { ...editArgs(), validate: { before: ['test', 'build'] } });
  expect(calls).toBe(1); expect(readFileSync(join(root, 'owned.txt'), 'utf8')).toBe('before');
});
test('native validator invokes its final synchronous guard before spawn', async () => {
  let spawns = 0; const original = Bun.spawn;
  const spy = spyOn(Bun, 'spawn').mockImplementation(((...args: Parameters<typeof Bun.spawn>) => { spawns++; return original(...args); }) as typeof Bun.spawn);
  let guards = 0;
  try { await expect(runValidators(['test'], root, undefined, () => { if (++guards === 2) throw new Error('revoked at final boundary'); })).rejects.toThrow('revoked'); expect(spawns).toBe(0); }
  finally { spy.mockRestore(); }
});

for (const existing of [false, true]) for (const external of [false, true]) test(`atomic Write repair revocation compensates only its owned revision (existing=${existing}, external=${external})`, async () => {
  if (existing) writeFileSync(join(root, 'repair.ts'), 'export const before = 1;\n');
  const which = spyOn(Bun, 'which').mockReturnValue(null); let chats = 0; let pendingTrust: Promise<void> | undefined;
  try {
    const tool = createWriteTool({ projectRoot: root,
      configManager: { get: (() => true) as ConfigManager['get'] },
      toolLLM: { chat: async () => { chats++; if (external) writeFileSync(join(root, 'repair.ts'), 'external update'); pendingTrust = trust.setLevel('restricted'); await pendingTrust; return 'export const repaired = 1;\n'; } },
    });
    const result = await run(tool, { files: [{ path: 'repair.ts', content: 'export const broken = ;\n', mode: 'overwrite' }], transaction: { mode: 'atomic' } });
    expect(chats).toBe(1); expect(result[0]!.success).toBe(false);
    if (external) expect(readFileSync(join(root, 'repair.ts'), 'utf8')).toBe('external update');
    else if (existing) expect(readFileSync(join(root, 'repair.ts'), 'utf8')).toBe('export const before = 1;\n');
    else expect(existsSync(join(root, 'repair.ts'))).toBe(false);
  } finally { await pendingTrust; which.mockRestore(); }
});

for (const alias of ['symlink', 'hardlink'] as const) for (const name of ['write', 'edit'] as const) test(`authenticated atomic ${name} refuses ${alias} before mutation while legacy Edit remains supported`, async () => {
  writeFileSync(join(root, 'target.txt'), 'before');
  if (alias === 'symlink') symlinkSync(join(root, 'target.txt'), join(root, 'owned.txt'));
  else linkSync(join(root, 'target.txt'), join(root, 'owned.txt'));
  const tool = name === 'write' ? createWriteTool({ projectRoot: root }) : createEditTool(new FileStateCache(), { cwd: root });
  const args = name === 'write' ? { ...writeArgs(), transaction: { mode: 'atomic' } } : { edits: [{ path: 'owned.txt', find: 'before', replace: 'forbidden' }], transaction: { mode: 'atomic' } };
  const result = await run(tool, args);
  expect(result[0]!.success).toBe(false); expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('before');
  expect(alias === 'symlink' ? lstatSync(join(root, 'owned.txt')).isSymbolicLink() : lstatSync(join(root, 'owned.txt')).nlink === 2).toBe(true);
  const legacy = await createEditTool(new FileStateCache(), { cwd: root }).execute({ edits: [{ path: 'owned.txt', find: 'before', replace: 'legacy supported' }] });
  expect(legacy.success).toBe(true); expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('legacy supported');
});
test('native pending repair provider is interrupted and late resolution cannot publish', async () => {
  writeFileSync(join(root, 'repair.ts'), 'export const before = 1;\n');
  let release!: (value: string) => void; let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const pending = new Promise<string>(resolve => { release = resolve; });
  const which = spyOn(Bun, 'which').mockReturnValue(null);
  try {
    const tool = createWriteTool({ projectRoot: root, configManager: { get: (() => true) as ConfigManager['get'] }, toolLLM: { chat: async () => { began(); return pending; } } });
    const result = run(tool, { files: [{ path: 'repair.ts', content: 'export const broken = ;\n', mode: 'overwrite' }], transaction: { mode: 'atomic' } });
    await started; await trust.setLevel('restricted');
    const settled = await Promise.race([result, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('repair did not stop promptly')), 1500))]);
    expect(settled[0]!.success).toBe(false); expect(readFileSync(join(root, 'repair.ts'), 'utf8')).toBe('export const before = 1;\n');
    const entries = services.judgment.decisionLog.query().length;
    release('export const late = 2;\n'); await Bun.sleep(30);
    expect(readFileSync(join(root, 'repair.ts'), 'utf8')).toBe('export const before = 1;\n'); expect(services.judgment.decisionLog.query().length).toBe(entries);
  } finally { release?.(''); which.mockRestore(); }
});

test('native pending repair judgment cannot record or attach a late answer after revocation', async () => {
  writeFileSync(join(root, 'repair.ts'), 'export const before = 1;\n');
  let release!: () => void; let began!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  const readings = toolReadingsPort([['', { fixesErrors: true, onlyTheFix: true }]]);
  const semantic = fakePort((_name, question) => choiceAnswer(question, 'act', 0.98));
  const owned = withDecisionLog({ model: readings.port.model, async ask(request) {
    if ('fixes_errors' in request.questions) { began(); await pending; }
    return 'disposition' in request.questions ? semantic.port.ask(request) : readings.port.ask(request);
  } }, services.judgment.decisionLog);
  const previous = installJudgmentPort(owned);
  const which = spyOn(Bun, 'which').mockReturnValue(null);
  try {
    const tool = createWriteTool({ projectRoot: root, configManager: { get: (() => true) as ConfigManager['get'] }, toolLLM: { chat: async () => 'export const repaired = 1;\n' } });
    const result = run(tool, { files: [{ path: 'repair.ts', content: 'export const broken = ;\n', mode: 'overwrite' }], transaction: { mode: 'atomic' } });
    await started; await trust.setLevel('restricted');
    const settled = await Promise.race([result, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('judgment did not stop promptly')), 1500))]);
    expect(settled[0]!.success).toBe(false); const before = JSON.stringify(services.judgment.decisionLog.query());
    release(); await Bun.sleep(30);
    expect(JSON.stringify(services.judgment.decisionLog.query())).toBe(before); expect(readFileSync(join(root, 'repair.ts'), 'utf8')).toBe('export const before = 1;\n');
  } finally { release?.(); installJudgmentPort(previous); which.mockRestore(); }
});

for (const external of [false, true]) test(`atomic Write later-path revocation restores only its owned prefix (external=${external})`, async () => {
  writeFileSync(join(root, 'first.txt'), 'first before'); writeFileSync(join(root, 'second.txt'), 'second before');
  const tool = createWriteTool({ projectRoot: root, capturedReadAccess: async path => {
    if (path === join(root, 'second.txt')) {
      if (external) writeFileSync(join(root, 'first.txt'), 'external first');
      await trust.setLevel('restricted');
    }
    return true;
  } });
  const result = await run(tool, { files: [{ path: 'first.txt', content: 'first owned', mode: 'overwrite' },
    { path: 'second.txt', content: 'forbidden second', mode: 'overwrite' }, { path: 'third.txt', content: 'forbidden third' }], transaction: { mode: 'atomic' } });
  expect(result[0]!.success).toBe(false); expect(readFileSync(join(root, 'first.txt'), 'utf8')).toBe(external ? 'external first' : 'first before');
  expect(readFileSync(join(root, 'second.txt'), 'utf8')).toBe('second before'); expect(existsSync(join(root, 'third.txt'))).toBe(false);
});
test('atomic Edit per-file revocation cannot publish a later file and compensates its owned first file', async () => {
  writeFileSync(join(root, 'first.txt'), 'first before'); writeFileSync(join(root, 'second.txt'), 'second before');
  const cache = new FileStateCache(); const update = cache.update.bind(cache); let pending: Promise<void> | undefined;
  const spy = spyOn(cache, 'update').mockImplementation((path, content, options) => { const result = update(path, content, options); if (path === join(root, 'first.txt')) pending ??= trust.setLevel('restricted'); return result; });
  try {
    const result = await run(createEditTool(cache, { cwd: root }), { edits: [{ path: 'first.txt', find: 'before', replace: 'after' }, { path: 'second.txt', find: 'before', replace: 'forbidden' }], transaction: { mode: 'atomic' } });
    expect(result[0]!.success).toBe(false); expect(readFileSync(join(root, 'first.txt'), 'utf8')).toBe('first before'); expect(readFileSync(join(root, 'second.txt'), 'utf8')).toBe('second before');
  } finally { await pending; spy.mockRestore(); }
});
