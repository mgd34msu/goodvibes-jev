import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WorkPlanStore } from '@goodvibes-jev/engine/sdk/platform/workflow';
import type { PermissionMode } from '@goodvibes-jev/engine/sdk/platform/config';
import { createShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import type { CommandContext } from '../../input/command-registry.ts';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { createAgentWorkPlanTool, registerAgentWorkPlanTool } from '../../tools/agent-work-plan-tool.ts';
import { createAgentVibeTool, registerAgentVibeTool } from '../../tools/agent-vibe-tool.ts';
import { admitLocalState } from '../helpers/local-state-admission.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { OwnerProfileStore, parseProfileDocument, profileDelegationForInvocation, type ProfileMutationOptions } from '@goodvibes-jev/engine/sdk/platform/owner-profile';
import { resetProcessUntrustedContentLedgerForTests } from '@goodvibes-jev/engine/sdk/platform/security';
import { createOccasionsGatewayInvoke, type OccasionsGatewayInvoke } from '../../agent/occasions-gateway.ts';
import { createAgentOccasionsTool, registerAgentOccasionsTool } from '../../tools/agent-occasions-tool.ts';

beforeEach(() => { resetProcessUntrustedContentLedgerForTests(); });

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = makeProjectTempDir('agent-local-state-authority'); roots.push(root);
  const home = join(root, 'home'), workspace = join(root, 'workspace');
  mkdirSync(home); mkdirSync(workspace);
  const paths = createShellPathService({ homeDirectory: home, workingDirectory: workspace });
  const context = { workspace: { shellPaths: paths } } as CommandContext;
  const store = new WorkPlanStore({ homeDirectory: home, surfaceRoot: 'agent', projectId: 'local', projectRoot: workspace });
  return { root, home, workspace, paths, context, store };
}

test('caller confirmation and fabricated callbacks cannot write local work-plan or VIBE files', async () => {
  const f = fixture(); const forged = { confirm: true, explicitUserRequest: 'Caller claim' };
  expect((await createAgentWorkPlanTool(f.store).execute({ action: 'create', title: 'Forged', ...forged }, { assertCurrent() {} })).success).toBe(false);
  expect((await createAgentVibeTool(f.context).execute({ action: 'init', ...forged }, { assertCurrent() {} })).success).toBe(false);
  expect(existsSync(f.store.filePath)).toBe(false); expect(existsSync(join(f.workspace, 'VIBE.md'))).toBe(false);
});

test('real recorded admission creates and removes local work items without confirmation flags', async () => {
  const f = fixture(), register = (registry: Parameters<typeof registerAgentWorkPlanTool>[0]) => registerAgentWorkPlanTool(registry, f.store);
  const created = await admitLocalState(register, 'agent_work_plan', { action: 'create', title: 'Admitted local todo' }, { directory: f.workspace });
  expect(created.success).toBe(true); const item = f.store.listItems()[0]; expect(item?.title).toBe('Admitted local todo');
  const removed = await admitLocalState(register, 'agent_work_plan', { action: 'remove', id: item?.id }, { directory: f.workspace });
  expect(removed.success).toBe(true); expect(f.store.listItems()).toHaveLength(0);
});

test('recorded admission initializes VIBE and imports a reviewed active persona without flags', async () => {
  const f = fixture(), register = (registry: Parameters<typeof registerAgentVibeTool>[0]) => registerAgentVibeTool(registry, f.context);
  expect((await admitLocalState(register, 'vibe', { action: 'init' }, { directory: f.workspace })).success).toBe(true);
  expect(readFileSync(join(f.workspace, 'VIBE.md'), 'utf8')).toContain('Describe how GoodVibes Agent');
  expect((await admitLocalState(register, 'vibe', { action: 'import_persona', review: true, use: true }, { directory: f.workspace })).success).toBe(true);
  const active = AgentPersonaRegistry.fromShellPaths(f.paths).snapshot().activePersona;
  expect(active?.name).toBe('Project Vibe'); expect(active?.reviewState).toBe('reviewed');
});

test.each(['work-plan', 'vibe'] as const)('%s writes respect deterministic read-only mode even with synthetic read classification', async kind => {
  const f = fixture();
  const result = kind === 'work-plan'
    ? await admitLocalState(registry => registerAgentWorkPlanTool(registry, f.store), 'agent_work_plan', { action: 'create', title: 'Held' }, { directory: f.workspace, mode: 'plan' })
    : await admitLocalState(registry => registerAgentVibeTool(registry, f.context), 'vibe', { action: 'init' }, { directory: f.workspace, mode: 'plan' });
  expect(result.success).toBe(false); expect(existsSync(f.store.filePath)).toBe(false); expect(existsSync(join(f.workspace, 'VIBE.md'))).toBe(false);
});

test.each(['cancel', 'revoke'] as const)('work-plan physical write holds %s triggered by its source clock', async action => {
  const f = fixture(), controller = new AbortController(); let mode: PermissionMode = 'prompt';
  const add = f.store.addItem.bind(f.store);
  f.store.addItem = (title, input, effects) => {
    const clock = Date.now;
    Date.now = () => { if (action === 'cancel') controller.abort(); else mode = 'plan'; return clock(); };
    try { return add(title, input, effects); } finally { Date.now = clock; }
  };
  const result = await admitLocalState(registry => registerAgentWorkPlanTool(registry, f.store), 'agent_work_plan', { action: 'create', title: 'Held' }, { directory: f.workspace, signal: controller.signal, currentMode: () => mode });
  expect(result.success).toBe(false); expect(existsSync(f.store.filePath)).toBe(false);
});

test('work-plan list/get preserve corrupt and expired files without read-side housekeeping effects', async () => {
  const f = fixture(); mkdirSync(dirname(f.store.filePath), { recursive: true }); writeFileSync(f.store.filePath, '{torn');
  const result = await createAgentWorkPlanTool(f.store).execute({ action: 'list' });
  expect(result.success).toBe(true); expect(readFileSync(f.store.filePath, 'utf8')).toBe('{torn');
});

test.each(['store', 'parent', 'source'] as const)('pre-admission %s ABA changes revoke the physical binding', async kind => {
  const f = fixture(); const source = join(f.workspace, 'VIBE.md'); writeFileSync(source, '# Vibe\nBe direct.');
  f.store.addItem('Before');
  const afterCapture = () => {
    const path = kind === 'source' ? source : kind === 'parent' ? dirname(f.store.filePath) : f.store.filePath;
    const saved = `${path}.saved`; renameSync(path, saved); renameSync(saved, path);
  };
  const result = kind === 'source'
    ? await admitLocalState(registry => registerAgentVibeTool(registry, f.context), 'vibe', { action: 'import_persona' }, { directory: f.workspace, afterCapture })
    : await admitLocalState(registry => registerAgentWorkPlanTool(registry, f.store), 'agent_work_plan', { action: 'create', title: 'After' }, { directory: f.workspace, afterCapture });
  expect(result.success).toBe(false); expect(f.store.listItems()).toHaveLength(1); expect(AgentPersonaRegistry.fromShellPaths(f.paths).list()).toHaveLength(0);
});

test('VIBE initialization refuses a symlink publication target', async () => {
  const f = fixture(), outside = join(f.root, 'outside'); writeFileSync(outside, 'Outside bytes'); symlinkSync(outside, join(f.workspace, 'VIBE.md'));
  const result = await admitLocalState(registry => registerAgentVibeTool(registry, f.context), 'vibe', { action: 'init', force: true }, { directory: f.workspace });
  expect(result.success).toBe(false); expect(readFileSync(outside, 'utf8')).toBe('Outside bytes');
});

function occasionsFixture() {
  const f = fixture(), profilePath = join(f.home, 'owner-profile.md'), statePath = join(f.home, 'occasions-state.json');
  writeFileSync(profilePath, '# Owner profile\n\n## Important dates\n');
  const profile = new OwnerProfileStore({ path: profilePath }); profile.loadSync();
  const config = { get: (key: string) => key === 'daemon.timezone' ? 'UTC' : undefined, set() {} };
  const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
  catalog.register({ id: 'occasions.confirm', title: 'Synthetic local profile capture', description: 'Isolated actual profile writer',
    category: 'test', source: 'plugin', access: 'authenticated', transport: ['internal'], scopes: [] }, async invocation => {
    const body = invocation.body;
    if (!body || typeof body !== 'object' || !('title' in body) || typeof body.title !== 'string'
      || !('date' in body) || typeof body.date !== 'string' || !('kind' in body) || typeof body.kind !== 'string'
      || !('authority' in body) || body.authority !== 'autonomous') throw new Error('Unexpected synthetic capture');
    const result = await profile.append({ section: 'Important dates', text: `${body.title} · ${body.date} · annual · ${body.kind}`,
      surface: 'agent', authority: 'autonomous', said: '' }, { signal: invocation.signal,
      delegation: profileDelegationForInvocation(invocation), assertCurrent: () => { invocation.isAuthorized?.([]); } });
    return { ...result, occasionId: 'family-day', droppedRecords: 0 };
  });
  const invoke = createOccasionsGatewayInvoke({ gatewayMethods: catalog, configManager: config, homeDirectory: f.home });
  const register = (registry: Parameters<typeof registerAgentOccasionsTool>[0]) => registerAgentOccasionsTool(registry, { invoke });
  return { ...f, profile, catalog, invoke, register, profilePath, statePath };
}
const occasion = { action: 'confirm', title: 'Family day', date: '03-14', kind: 'remember-only' };

test('actual Occasions profile writes use recorded autonomous source and require no caller flags', async () => {
  const f = occasionsFixture();
  const result = await admitLocalState(f.register, 'occasions', occasion, { directory: f.workspace });
  expect(result.success).toBe(true);
  const bytes = readFileSync(f.profilePath, 'utf8');
  expect(bytes).toContain('Family day · 03-14'); expect(bytes).toContain(', autonomous ');
  const provenance = parseProfileDocument({ path: f.profilePath, text: bytes, exists: true }).sections.find(section => section.heading === 'Important dates')?.prose[0]?.provenance;
  expect(provenance?.origin).toBe('autonomous'); expect(provenance?.said).toBe('');
  if (provenance?.origin !== 'autonomous') throw new Error('Missing actual recorded provenance');
  expect(provenance.source).toEqual({ goal: 'Verify isolated Agent local-state effects', criteria: ['Only disposable local files and synthetic gateway handlers'] });
});

test('caller flags and copied delegation cannot modify the actual profile', async () => {
  const f = occasionsFixture(), before = readFileSync(f.profilePath, 'utf8');
  const result = await createAgentOccasionsTool({ invoke: f.invoke }).execute({ ...occasion, authority: 'owner-direct', said: 'A fabricated quote', confirmed: true }, { assertCurrent() {} });
  expect(result.success).toBe(false);
  await expect(f.profile.append({ section: 'Important dates', text: 'Forged · 04-04 · annual · neither', surface: 'agent', said: '', authority: 'autonomous' },
    { delegation: { kind: 'recorded-autonomous' }, assertCurrent() {} })).rejects.toThrow();
  expect(readFileSync(f.profilePath, 'utf8')).toBe(before);
});

test('profile delegation retires with the recorded tool invocation', async () => {
  const f = occasionsFixture(); let captured: ProfileMutationOptions | undefined;
  const invoke: OccasionsGatewayInvoke = async (method, body, options) => { captured = options; return f.invoke(method, body, options); };
  expect((await admitLocalState(registry => registerAgentOccasionsTool(registry, { invoke }), 'occasions', occasion, { directory: f.workspace })).success).toBe(true);
  const before = readFileSync(f.profilePath, 'utf8'); expect(captured?.delegation).toBeDefined();
  await expect(f.profile.append({ section: 'Important dates', text: 'After · 04-04 · annual · neither', surface: 'agent', said: '', authority: 'autonomous' }, captured)).rejects.toThrow();
  expect(readFileSync(f.profilePath, 'utf8')).toBe(before);
});

test('Occasions profile writes hold in read-only mode before any durable change', async () => {
  const f = occasionsFixture(), before = readFileSync(f.profilePath, 'utf8');
  expect((await admitLocalState(f.register, 'occasions', occasion, { directory: f.workspace, mode: 'plan' })).success).toBe(false);
  expect(readFileSync(f.profilePath, 'utf8')).toBe(before); expect(existsSync(f.statePath)).toBe(false);
});

test('native human profile provenance keeps the actual verbatim quotation', async () => {
  const f = occasionsFixture();
  const result = await f.profile.append({ section: 'Notes', text: 'Be direct.', surface: 'tui', said: 'Please be direct.', authority: 'owner-direct', date: '2026-03-01' });
  expect(result.ok).toBe(true); expect(readFileSync(f.profilePath, 'utf8')).toContain(' — tui, 2026-03-01, "Please be direct."');
});
