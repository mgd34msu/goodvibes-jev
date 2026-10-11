import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { DEFAULT_CONFIG, type PermissionMode, type PermissionsToolConfig } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { FileUndoManager } from '@goodvibes-jev/engine/sdk/platform/state';
import { ToolRegistry, ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { forwardHarnessCatalogCall, harnessCatalogInvocationAuthority } from '../../tools/agent-harness-catalog-ingress.ts';
import { requireConfirmedAction } from '../../tools/agent-harness-tool-utils.ts';
import { runFileRecovery } from '../../tools/agent-harness-file-recovery.ts';

type ExecuteOptions = Parameters<Tool['execute']>[1];
let prior: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
const roots: string[] = [];

beforeEach(() => {
  log = new SqliteDecisionLog(':memory:');
  // These are recorded synthetic readings. They intentionally classify the
  // intercepted body as read-only, exercising the separate code-owned floor.
  const readings = fakePort((name, question) => {
    if (question.type === 'choice') {
      const label = name === 'disposition' ? Object.hasOwn(question.criteria, 'act') ? 'act' : 'reject'
        : name === 'kind' ? 'read' : name === 'family' || name === 'capability' ? 'generic' : undefined;
      if (label === undefined) throw new Error(`Unexpected synthetic choice ${name}`);
      return choiceAnswer(question, label, 0.999);
    }
    if (question.type === 'noul') return noulAnswer(0.001);
    throw new Error(`Unexpected synthetic question ${name}`);
  });
  prior = installJudgmentPort(withDecisionLog(readings.port, log));
});
afterEach(() => {
  installJudgmentPort(prior); log[Symbol.dispose]();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'harness-effect-authority-'));
  roots.push(root); return root;
}
function fixture(body: Tool['execute'], initialMode: PermissionMode = 'prompt', tools: PermissionsToolConfig = {}, directory = '/synthetic/effect-authority') {
  let mode = initialMode; let sequence = 0;
  let authorityRead: (() => void) | undefined;
  const permissions = () => ({ ...DEFAULT_CONFIG.permissions, mode, tools });
  const reader: PermissionConfigReader = {
    getAutonomousSnapshot: () => { authorityRead?.(); return { permissions: permissions(), autoApprove: false, directory }; },
    getSnapshot: () => ({ permissions: permissions() }),
    isAutoApproveEnabled: () => false, getWorkingDirectory: () => directory,
  };
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const registry = new ToolRegistry(manager);
  registry.register({ definition: { name: 'agent_harness', description: 'Intercepted synthetic action authority fixture.',
    sideEffects: ['state'], parameters: { type: 'object', properties: {}, additionalProperties: true } }, execute: body });
  return {
    setMode(next: PermissionMode) { mode = next; },
    beforeAuthorityRead(callback: () => void) { authorityRead = callback; },
    async run(args: Record<string, unknown>, signal?: AbortSignal) {
      const id = `synthetic-action-${++sequence}`;
      const call = await registry.prepareCall(id, 'agent_harness', args, { signal });
      const admission = await manager.admitAutonomous(id, 'agent_harness', call.args, {
        sourceOf: () => ({ goal: 'Check intercepted action authority and isolated temporary file fixtures',
          criteria: ['Do not perform external product actions or send private values'] }),
        signal, schemaRevision: call.schemaRevision, preparedCall: { registry, call },
      });
      expect(admission.result.autonomousDecision?.outcome).toBe('act');
      return registry.executePrepared(call, admission);
    },
  };
}

test('caller request/confirmation fields and restriction callbacks do not grant an action', () => {
  const args = { mode: 'set_keybinding', confirm: true, explicitUserRequest: 'Caller assertion' };
  expect(requireConfirmedAction(args, undefined, 'Synthetic action')).toContain('recorded effect admission');
  expect(requireConfirmedAction(args, { assertCurrent() {} }, 'Synthetic action')).toContain('recorded effect admission');
  expect(harnessCatalogInvocationAuthority(args, undefined, 'write')).toBe(false);
});

test('a recorded synthetic act passes the helper without caller confirmation fields', async () => {
  const tools = fixture(async (args, options) => {
    expect(requireConfirmedAction(args, options, 'Synthetic action')).toBeNull();
    return { success: true };
  });
  expect(await tools.run({ mode: 'set_keybinding' })).toMatchObject({ success: true });
});

test('trusted facade translation and nested same-object forwarding retain the original proof', async () => {
  let retainedArgs: Record<string, unknown> | undefined;
  let retainedOptions: ExecuteOptions;
  const inner: Tool = { definition: { name: 'translated_harness', description: 'Synthetic translated facade.', parameters: {} },
    async execute(args, options) {
      retainedArgs = args; retainedOptions = options;
      expect(requireConfirmedAction(args, options, 'Synthetic translated action')).toBeNull();
      expect(() => requireConfirmedAction({ ...args }, options, 'Copied action')).toThrow(ToolInputProjectionError);
      expect(() => requireConfirmedAction(args, { ...options }, 'Copied options')).toThrow(ToolInputProjectionError);
      expect(() => requireConfirmedAction(args, undefined, 'Dropped options')).toThrow(ToolInputProjectionError);
      expect(requireConfirmedAction(args, options, 'Original action')).toBeNull();
      return { success: true };
    } };
  const middle: Tool = { ...inner, execute: (args, options) => forwardHarnessCatalogCall(inner, args, args, options) };
  const tools = fixture((original, options) => forwardHarnessCatalogCall(middle, original, { mode: 'set_keybinding' }, options));
  expect(await tools.run({ action: 'set_keybinding' })).toMatchObject({ success: true });
  if (!retainedArgs) throw new Error('Synthetic forwarded body did not run');
  expect(() => requireConfirmedAction(retainedArgs, retainedOptions, 'Expired translated action')).toThrow(ToolInputProjectionError);
});

test('raw facade forwarding cannot mint proof from confirmation fields', async () => {
  const inner: Tool = { definition: { name: 'translated_harness', description: 'Synthetic unadmitted facade.', parameters: {} },
    async execute(args, options) {
      expect(requireConfirmedAction(args, options, 'Unadmitted action')).toContain('recorded effect admission');
      return { success: true };
    } };
  await forwardHarnessCatalogCall(inner, { action: 'set_keybinding' }, { mode: 'set_keybinding', confirm: true, explicitUserRequest: 'Caller assertion' });
});

test.each(['plan', 'custom'] as const)('a synthetic read classification cannot authorize a %s mode effect', async mode => {
  let effects = 0;
  const tools = fixture(async (args, options) => {
    requireConfirmedAction(args, options, 'Synthetic state write'); effects++;
    return { success: true };
  }, mode, mode === 'custom' ? { write: 'deny' } : {});
  await expect(tools.run({ mode: 'set_keybinding', confirm: true, explicitUserRequest: 'Caller assertion' })).rejects.toThrow(ToolInputProjectionError);
  expect(effects).toBe(0);
});

test('translated outward modes preserve the captured deterministic floor', async () => {
  let effects = 0;
  const inner: Tool = { definition: { name: 'translated_harness', description: 'Synthetic remote action.', parameters: {} },
    async execute(args, options) { requireConfirmedAction(args, options, 'Synthetic send'); effects++; return { success: true }; } };
  const tools = fixture((original, options) => forwardHarnessCatalogCall(inner, original, { mode: 'remote_peers_invoke' }, options), 'plan');
  await expect(tools.run({ action: 'invoke' })).rejects.toThrow(ToolInputProjectionError);
  expect(effects).toBe(0);
});

test('cancellation and owner revocation refuse the effect before its body', async () => {
  const controller = new AbortController(); let effects = 0;
  const cancelled = fixture(async (args, options) => {
    controller.abort(); requireConfirmedAction(args, options, 'Cancelled effect'); effects++; return { success: true };
  });
  await expect(cancelled.run({ mode: 'set_keybinding' }, controller.signal)).rejects.toThrow();
  const revoked = fixture(async (args, options) => {
    revoked.setMode('plan'); requireConfirmedAction(args, options, 'Revoked effect'); effects++; return { success: true };
  });
  await expect(revoked.run({ mode: 'set_keybinding' })).rejects.toThrow();
  expect(effects).toBe(0);
});

function recoveryFixture() {
  const root = temporaryRoot(); const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const manager = new FileUndoManager();
  const context = { workspace: { fileUndoManager: manager, shellPaths: { workingDirectory: workspace } } };
  let recovery: Record<string, unknown> | undefined;
  const tools = fixture(async (args, options) => { recovery = runFileRecovery(context, args, options); return { success: true }; }, 'prompt', {}, workspace);
  return { root, workspace, manager, context, tools, result: () => recovery };
}

test('file recovery applies admitted undo/redo only within the physical workspace', async () => {
  const scene = recoveryFixture(); const path = join(scene.workspace, 'owned.txt');
  writeFileSync(path, 'after'); scene.manager.snapshot({ path, beforeContent: 'before', afterContent: 'after', tool: 'edit' });
  await scene.tools.run({ mode: 'run_file_recovery', recoveryAction: 'undo' });
  expect(scene.result()).toMatchObject({ status: 'applied', path: 'owned.txt' });
  expect(readFileSync(path, 'utf8')).toBe('before');
  const next = scene.manager.peekRedo();
  expect(next?.path).toBe(path); expect(scene.manager.redoDepth()).toBe(1); expect(scene.manager.peekRedo()).toBe(next);
  await scene.tools.run({ mode: 'run_file_recovery', recoveryAction: 'redo' });
  expect(scene.result()).toMatchObject({ status: 'applied', path: 'owned.txt' });
  expect(readFileSync(path, 'utf8')).toBe('after'); expect(scene.manager.peekRedo()).toBeUndefined();
});

test('raw file recovery cannot use caller confirmation to restore bytes', () => {
  const scene = recoveryFixture(); const path = join(scene.workspace, 'owned.txt');
  writeFileSync(path, 'after'); scene.manager.snapshot({ path, beforeContent: 'before', afterContent: 'after', tool: 'edit' });
  expect(runFileRecovery(scene.context, { mode: 'run_file_recovery', recoveryAction: 'undo', confirm: true, explicitUserRequest: 'Caller assertion' })).toMatchObject({ status: 'held' });
  expect(readFileSync(path, 'utf8')).toBe('after'); expect(scene.manager.undoDepth()).toBe(1);
});

test.each(['undo', 'redo'] as const)('file recovery refuses outside-workspace %s without changing the journal', async action => {
  const scene = recoveryFixture(); const path = join(scene.root, 'outside.txt');
  writeFileSync(path, 'after'); scene.manager.snapshot({ path, beforeContent: 'before', afterContent: 'after', tool: 'edit' });
  if (action === 'redo') scene.manager.undo();
  const expectedBytes = readFileSync(path, 'utf8');
  await scene.tools.run({ mode: 'run_file_recovery', recoveryAction: action });
  expect(scene.result()).toMatchObject({ status: 'held' }); expect(readFileSync(path, 'utf8')).toBe(expectedBytes);
  expect(action === 'undo' ? scene.manager.undoDepth() : scene.manager.redoDepth()).toBe(1);
});

test.each(['existing', 'dangling'] as const)('file recovery refuses a %s symlink escape before owner write', async targetState => {
  const scene = recoveryFixture(); const outside = join(scene.root, 'outside.txt'); const path = join(scene.workspace, 'link.txt');
  if (targetState === 'existing') writeFileSync(outside, 'outside');
  symlinkSync(outside, path); scene.manager.snapshot({ path, beforeContent: 'restored', afterContent: 'after', tool: 'edit' });
  await scene.tools.run({ mode: 'run_file_recovery', recoveryAction: 'undo' });
  expect(scene.result()).toMatchObject({ status: 'held' }); expect(scene.manager.undoDepth()).toBe(1);
  if (targetState === 'existing') expect(readFileSync(outside, 'utf8')).toBe('outside');
  else expect(existsSync(outside)).toBe(false);
});

test('file recovery preserves journal and bytes under a deterministic read-only floor', async () => {
  const scene = recoveryFixture(); const path = join(scene.workspace, 'owned.txt');
  writeFileSync(path, 'after'); scene.manager.snapshot({ path, beforeContent: 'before', afterContent: 'after', tool: 'edit' });
  scene.tools.setMode('plan');
  await expect(scene.tools.run({ mode: 'run_file_recovery', recoveryAction: 'undo' })).rejects.toThrow(ToolInputProjectionError);
  expect(readFileSync(path, 'utf8')).toBe('after'); expect(scene.manager.undoDepth()).toBe(1);
});

test('file recovery refuses journal changes during the final authority check', async () => {
  const root = temporaryRoot(); const path = join(root, 'owned.txt');
  class ObservedJournal extends FileUndoManager {
    observed = false;
    override peekUndo() { this.observed = true; return super.peekUndo(); }
  }
  const manager = new ObservedJournal();
  writeFileSync(path, 'after'); manager.snapshot({ path, beforeContent: 'before', afterContent: 'after', tool: 'edit' });
  const next = manager.peekUndo(); manager.observed = false;
  if (!next) throw new Error('Synthetic journal entry missing');
  let result: Record<string, unknown> | undefined;
  const context = { workspace: { fileUndoManager: manager, shellPaths: { workingDirectory: root } } };
  const tools = fixture(async (args, options) => { result = runFileRecovery(context, args, options); return { success: true }; }, 'prompt', {}, root);
  tools.beforeAuthorityRead(() => { if (manager.observed) next.beforeContent = 'changed source'; });
  await tools.run({ mode: 'run_file_recovery', recoveryAction: 'undo' });
  expect(result).toMatchObject({ status: 'held' }); expect(readFileSync(path, 'utf8')).toBe('after'); expect(manager.undoDepth()).toBe(1);
});
