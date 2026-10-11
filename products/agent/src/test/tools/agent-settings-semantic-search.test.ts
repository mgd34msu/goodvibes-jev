import { registerOperatorRuntimeCommands } from '../../input/commands/operator-runtime.ts';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
/** Synthetic readings; real settings lookup, privacy, ownership and tool adapters. */
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager, CONFIG_SCHEMA, type ConfigSetting } from '@goodvibes-jev/engine/sdk/platform/config';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { AGENT_NOTIFICATIONS_METADATA_ONLY_KEY } from '../../config/host-settings.ts';
import { createAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { createAgentSettingsTool } from '../../tools/agent-settings-tool.ts';
import { createPreferredSettingsProjector } from '../../tools/agent-settings-admission.ts';
import { listHarnessSettings, countHarnessSettings, resolveHarnessSetting } from '../../agent/harness-control.ts';
import { ordinaryResearchOwner, researchScreeningFixture, exactSensitiveSpans, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const INTENT = 'Make the interface less glaring';
let previous: ReturnType<typeof installJudgmentPort>;
const roots: string[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(cleanupResearchScreeningFixtures);

function fixture(owner = ordinaryResearchOwner()) {
  const root = makeProjectTempDir('settings-semantic-search'); roots.push(root);
  const home = join(root, 'home'), workspace = join(root, 'workspace');
  mkdirSync(home, { recursive: true }); mkdirSync(workspace, { recursive: true });
  const config = new ConfigManager({ surfaceRoot: 'agent', homeDir: home, workingDir: workspace, configDir: join(home, '.goodvibes', 'agent') });
  config.set('display.theme', 'vaporwave');
  const schema: ConfigSetting[] = [
    { ...CONFIG_SCHEMA.find(row => row.key === 'display.theme')!, description: 'The interface color palette.' },
    { ...CONFIG_SCHEMA.find(row => row.key === 'display.showThinking')!, description: `${INTENT} is a quoted unrelated example; this controls reasoning visibility.` },
  ];
  config.getSchema = () => schema;
  const registry = new ToolRegistry(); bindAgentResearchSourceOwner(registry, owner);
  const commands = new CommandRegistry();
  const context = { platform: { configManager: config, secretsManager: null }, extensions: { toolRegistry: registry }, clients: {},
    session: { runtime: { sessionId: 'settings-session' } } } as unknown as CommandContext;
  const deps = { commandContext: context, commandRegistry: commands, toolRegistry: registry };
  return { config, schema, context, registry, harness: createAgentHarnessTool(deps), settings: createAgentSettingsTool(deps) };
}
function reader(probability = 0.99) {
  return fakePort((_name, _question, state) => {
    const candidate = (state as unknown as { candidate: { name: string } }).candidate.name;
    return noulAnswer(candidate === 'display.theme' ? probability : 0.01);
  });
}
function suspended() {
  let start!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { started, gate, start, release };
}
const body = (result: { output?: unknown }) => JSON.parse(String(result.output));

test.each(['settings', 'harness'] as const)('%s searches the complete filtered catalog and rejects a lexical decoy', async kind => {
  const f = fixture(), fake = reader(); installJudgmentPort(fake.port);
  const tool = kind === 'settings' ? f.settings : f.harness;
  const result = await tool.execute(kind === 'settings' ? { action: 'list', query: INTENT, prefix: 'display.', limit: 1 }
    : { mode: 'settings', query: INTENT, prefix: 'display.', limit: 1 });
  expect(result.success).toBe(true);
  const page = body(result);
  expect(page.settings.map((row: { key: string }) => row.key)).toEqual(['display.theme']);
  expect(page.total).toBe(2);
  expect(page.settings[0].judgment.reading.verdict).toBe('yes');
  expect(fake.requests).toHaveLength(2);
  expect(fake.requests.every(request => request.context?.battery === 'engine.tools.registry-rank')).toBe(true);
});

test('natural-language get resolves the recorded candidate while uncertainty stays ambiguous', async () => {
  const f = fixture(); installJudgmentPort(reader().port);
  const selected = body(await f.settings.execute({ action: 'get', target: INTENT }));
  expect(selected.key).toBe('display.theme'); expect(selected.lookup.resolvedBy).toBe('search');
  installJudgmentPort(reader(0.5).port);
  const held = await f.settings.execute({ action: 'get', target: INTENT });
  expect(held.success).toBe(false); expect(held.error).toContain('Ambiguous setting');
});

test('structural list and exact case-insensitive identifiers stay model-free; sync prose is explicit', async () => {
  const f = fixture();
  expect(listHarnessSettings(f.config)).toHaveLength(2); expect(countHarnessSettings(f.config)).toBe(2);
  expect(resolveHarnessSetting(f.config, { key: 'DISPLAY.THEME' })?.status).toBe('found');
  expect(() => resolveHarnessSetting(f.config, { target: INTENT })).toThrow('asynchronous protected settings reader');
  expect(() => listHarnessSettings(f.config, { query: INTENT })).toThrow('asynchronous protected settings reader');
  expect((await f.settings.execute({ action: 'list', prefix: 'display.' })).success).toBe(true);
  expect(body(await f.settings.execute({ action: 'get', key: 'DISPLAY.THEME' })).key).toBe('display.theme');
});

test.each(['abort', 'body', 'caller', 'profile', 'schema', 'port-aba'] as const)('a pending settings search holds on %s without publishing a stale choice', async change => {
  const f = fixture(), fake = reader(), wait = suspended();
  const port: JudgmentPort = { ...fake.port, ask: async request => { wait.start(); await wait.gate; return fake.port.ask(request); } };
  installJudgmentPort(port);
  const controller = new AbortController();
  const args = { action: 'get', target: INTENT, context: 'original-settings-body' };
  const pending = f.settings.execute(args, { signal: controller.signal });
  // Observe rejection immediately, including synchronous cancellation listeners.
  const outcome = pending.then(result => ({ result }), error => ({ error }));
  await wait.started;
  if (change === 'abort') controller.abort();
  if (change === 'body') args.context = 'replacement-settings-body';
  if (change === 'caller') f.context.session.runtime!.sessionId = 'another-session';
  if (change === 'profile') f.config.set('display.showThinking', true);
  if (change === 'schema') f.schema[0]!.description = 'Replaced after the reading began';
  if (change === 'port-aba') { installJudgmentPort(reader().port); installJudgmentPort(port); }
  wait.release();
  expect('error' in await outcome).toBe(true);
  expect(f.config.get('display.theme')).toBe('vaporwave');
});

test('privacy screens the entire preferred body before any ranking call', async () => {
  const canary = 'PRIVATE_SETTINGS_CANARY';
  const screening = researchScreeningFixture({ spans: exactSensitiveSpans([canary]) });
  const f = fixture(screening.owner), fake = reader(); installJudgmentPort(fake.port);
  await expect(f.settings.execute({ action: 'get', target: INTENT, unrelated: canary })).rejects.toThrow();
  expect(fake.requests).toHaveLength(0);
});

test('a recorded settings choice only prepares the existing admission; it cannot write directly', async () => {
  const f = fixture(), fake = reader(); installJudgmentPort(fake.port);
  const args = { action: 'set', target: INTENT, value: 'nord' };
  const projector = createPreferredSettingsProjector(f.context.platform, undefined, { registry: f.registry, context: f.context });
  const projected = await projector.project({ callId: 'semantic-settings-mutation', name: 'settings', args, assertCurrent() {} });
  try {
    expect(projected.status).toBe('projected');
    if (projected.status !== 'projected') throw new Error('Expected a prepared mutation');
    expect(projected.settingsAdmissionEvidence?.key).toBe('display.theme');
    expect(f.config.get('display.theme')).toBe('vaporwave');
    const result = await f.settings.execute(args);
    expect(result.success).toBe(false);
    expect(f.config.get('display.theme')).toBe('vaporwave');
  } finally { if (projected.status === 'projected') await projected.release?.(); }
});

test('a mutation source change while ranking prevents preparation as well as dispatch', async () => {
  const f = fixture(), fake = reader(), wait = suspended();
  installJudgmentPort({ ...fake.port, ask: async request => { wait.start(); await wait.gate; return fake.port.ask(request); } });
  const args = { action: 'set', target: INTENT, value: 'nord' };
  const projector = createPreferredSettingsProjector(f.context.platform, undefined, { registry: f.registry, context: f.context });
  const pending = projector.project({ callId: 'superseded-settings-mutation', name: 'settings', args, assertCurrent() {} });
  const outcome = pending.then(result => ({ result }), error => ({ error }));
  await wait.started; args.value = 'vaporwave'; wait.release();
  expect('error' in await outcome).toBe(true);
  expect(f.config.get('display.theme')).toBe('vaporwave');
});

test('a hidden mutation field remains bound after the reading has settled', async () => {
  const f = fixture(); installJudgmentPort(reader().port);
  const args = { action: 'set', target: INTENT, value: 'nord' };
  Object.defineProperty(args, 'privateContext', { value: 'original hidden context', writable: true, configurable: true });
  const projector = createPreferredSettingsProjector(f.context.platform, undefined, { registry: f.registry, context: f.context });
  const projected = await projector.project({ callId: 'hidden-mutation-body', name: 'settings', args, assertCurrent() {} });
  try {
    expect(projected.status).toBe('projected');
    if (projected.status !== 'projected') throw new Error('Expected a prepared mutation');
    projected.assertCurrent?.();
    Object.defineProperty(args, 'privateContext', { value: 'replaced hidden context' });
    expect(() => projected.assertCurrent?.()).toThrow();
    expect(f.config.get('display.theme')).toBe('vaporwave');
  } finally { if (projected.status === 'projected') await projected.release?.(); }
});

test('hidden schema context is screened before the canonical reader', async () => {
  const canary = 'PRIVATE_SCHEMA_CANARY';
  const screening = researchScreeningFixture({ spans: exactSensitiveSpans([canary]) });
  const f = fixture(screening.owner), fake = reader(); installJudgmentPort(fake.port);
  Object.defineProperty(f.schema[0]!, 'privateContext', { value: canary });
  await expect(f.harness.execute({ mode: 'settings', query: INTENT })).rejects.toThrow();
  expect(fake.requests).toHaveLength(0);
});

test('hidden host schema context is screened before the canonical reader', async () => {
  const canary = 'PRIVATE_HOST_SCHEMA_CANARY';
  const screening = researchScreeningFixture({ spans: exactSensitiveSpans([canary]) });
  const f = fixture(screening.owner), fake = reader(); installJudgmentPort(fake.port);
  const host = { key: AGENT_NOTIFICATIONS_METADATA_ONLY_KEY, type: 'boolean' as const, default: true, description: 'Notification content.' };
  Object.defineProperty(host, 'privateContext', { value: canary });
  const hosts = [host]; f.config.getHostSettingsSchema = () => hosts;
  await expect(f.harness.execute({ mode: 'settings', query: INTENT })).rejects.toThrow();
  expect(fake.requests).toHaveLength(0);
});

test('changing hidden schema context while reading holds the settings result', async () => {
  const f = fixture(), fake = reader(), wait = suspended();
  Object.defineProperty(f.schema[0]!, 'privateContext', { value: 'original hidden context', writable: true });
  installJudgmentPort({ ...fake.port, ask: async request => { wait.start(); await wait.gate; return fake.port.ask(request); } });
  const outcome = f.harness.execute({ mode: 'settings', query: INTENT }).then(result => ({ result }), error => ({ error }));
  await wait.started; Object.defineProperty(f.schema[0]!, 'privateContext', { value: 'replaced hidden context' }); wait.release();
  expect('error' in await outcome).toBe(true);
});


test('the registered slash settings command uses the semantic reader and withholds a superseded transcript', async () => {
  const f = fixture(), fake = reader(); installJudgmentPort(fake.port);
  const printed: string[] = [], messages: { role: string; content: string }[] = [];
  const context = { ...f.context, print: (value: string) => printed.push(value),
    session: { ...f.context.session, conversationManager: { getMessageSnapshot: () => messages } } } as unknown as CommandContext;
  const commands = new CommandRegistry(); registerOperatorRuntimeCommands(commands);
  const settings = commands.get('settings')!;
  await settings.handler(['list', INTENT, '--prefix', 'display.'], context);
  expect(printed.at(-1)).toContain('display.theme');
  expect(printed.at(-1)).not.toContain('display.showThinking');
  const wait = suspended();
  installJudgmentPort({ ...fake.port, ask: async request => { wait.start(); await wait.gate; return fake.port.ask(request); } });
  const count = printed.length;
  const outcome = Promise.resolve(settings.handler(['list', INTENT], context)).then(result => ({ result }), error => ({ error }));
  await wait.started; messages.push({ role: 'user', content: 'Cancel that settings search' }); wait.release();
  expect('error' in await outcome).toBe(true); expect(printed).toHaveLength(count);
});

test.each(['nested', 'property', 'accessor', 'prototype', 'validator'] as const)('a pending settings reading rejects changed %s metadata without invoking replacement accessors', async change => {
  const f = fixture(), fake = reader(), wait = suspended();
  const context = { detail: 'original metadata' };
  Object.defineProperty(f.schema[0]!, 'privateContext', { value: context, configurable: true });
  let accessorReads = 0;
  installJudgmentPort({ ...fake.port, ask: async request => { wait.start(); await wait.gate; return fake.port.ask(request); } });
  const outcome = f.harness.execute({ mode: 'settings', query: INTENT }).then(result => ({ result }), error => ({ error }));
  await wait.started;
  if (change === 'nested') context.detail = 'replacement metadata';
  if (change === 'property') Object.defineProperty(f.schema[0]!, 'newContext', { value: 'new metadata' });
  if (change === 'accessor') Object.defineProperty(f.schema[0]!, 'description', { get() { accessorReads++; return 'replacement description'; } });
  if (change === 'prototype') Object.setPrototypeOf(f.schema[0]!, {});
  if (change === 'validator') f.schema[0]!.validate = () => true;
  wait.release();
  expect('error' in await outcome).toBe(true); expect(accessorReads).toBe(0);
  expect(f.config.get('display.theme')).toBe('vaporwave');
});

test('a pending settings mutation refuses a replaced schema accessor before evaluating it', async () => {
  const f = fixture(), fake = reader(), wait = suspended(); let accessorReads = 0;
  installJudgmentPort({ ...fake.port, ask: async request => { wait.start(); await wait.gate; return fake.port.ask(request); } });
  const projector = createPreferredSettingsProjector(f.context.platform, undefined, { registry: f.registry, context: f.context });
  const outcome = projector.project({ callId: 'mutation-schema-accessor', name: 'settings',
    args: { action: 'set', target: INTENT, value: 'nord' }, assertCurrent() {} }).then(result => ({ result }), error => ({ error }));
  await wait.started;
  Object.defineProperty(f.schema[0]!, 'description', { get() { accessorReads++; return 'replacement description'; } });
  wait.release();
  expect('error' in await outcome).toBe(true); expect(accessorReads).toBe(0);
  expect(f.config.get('display.theme')).toBe('vaporwave');
});

test('a replaced backend health accessor is refused before the lifetime guard reads it', async () => {
  const f = fixture(), fake = reader(), wait = suspended(); let accessorReads = 0;
  const port: JudgmentPort = { ...fake.port, ask: async request => { wait.start(); await wait.gate; return fake.port.ask(request); } };
  installJudgmentPort(port);
  const outcome = f.harness.execute({ mode: 'settings', query: INTENT }).then(result => ({ result }), error => ({ error }));
  await wait.started;
  Object.defineProperty(port, 'health', { get() { accessorReads++; return () => ({}); } });
  wait.release();
  expect('error' in await outcome).toBe(true); expect(accessorReads).toBe(0);
});
