import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bindJudgmentPortAuthority, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { captureArchetypeListing, readArchetypeFamilies, type AgentArchetype } from '@goodvibes-jev/engine/sdk/platform/agents';
import { createTaskManager } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { createRuntimeStore } from '@goodvibes-jev/engine/sdk/platform/runtime/store';
import { RuntimeEventBus } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { createFeatureFlagManager } from '@goodvibes-jev/engine/sdk/platform/runtime/feature-flags';
import { createRuntimeOpsApi } from '@goodvibes-jev/engine/sdk/platform/runtime/bootstrap';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerTeamworkRuntimeCommands } from '../../input/commands/teamwork-runtime.ts';
import { ScheduleReadingLifetime } from '../../input/commands/schedule-reading-lifetime.ts';
import { createReadingDrain } from '../helpers/owned-reading-deferred.ts';
import { recordedBuiltinArchetypes, recordedFamilyPort } from '../helpers/teamwork-family-reading.ts';

const previous = installJudgmentPort(undefined), drain = createReadingDrain();
const directories: string[] = [];
afterEach(async () => {
  try { await drain.drain(); }
  finally { installJudgmentPort(previous); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'teamwork-family-')); directories.push(root);
  const directory = join(root, '.goodvibes', 'agents'); mkdirSync(directory, { recursive: true });
  const file = join(directory, 'operator.md');
  const text = '---\nname: operator\ndescription: Assess the current implementation and report defects.\ntools: [read, write, analyze]\n---\nRead the entire implementation.\n';
  writeFileSync(file, text);
  const entries = [...recordedBuiltinArchetypes, { name: 'operator', description: 'Assess the current implementation and report defects.', tools: ['read', 'write', 'analyze'], family: 'review' as const }];
  const flags = createFeatureFlagManager(); flags.loadFromConfig({ flags: { 'unified-runtime-task': 'enabled' } });
  const store = createRuntimeStore(), bus = new RuntimeEventBus();
  const manager = createTaskManager(store, bus, 'teamwork-session', flags);
  const readModel = { getSnapshot: () => ({ tasks: [...store.getState().tasks.tasks.values()] }) };
  const opsApi = createRuntimeOpsApi({ taskManager: manager, tasksReadModel: readModel });
  const output: string[] = [], runtime = { sessionId: 'teamwork-session' };
  const lifetime = new ScheduleReadingLifetime(() => runtime.sessionId, () => true);
  // This command fixture supplies the actual consumed shell owners. The task
  // API, task manager, native loader, command registry and reading owner are real.
  const ctx = { session: { runtime }, workspace: { shellPaths: { workingDirectory: root } }, provider: {},
    platform: { readModels: { tasks: readModel } }, clients: { opsApi }, teamworkReading: lifetime,
    print: (line: string) => output.push(line), renderRequest() {},
  } as unknown as CommandContext;
  drain.stopWith(() => lifetime.dispose());
  const registry = new CommandRegistry(); registerTeamworkRuntimeCommands(registry);
  return { root, directory, file, text, entries, registry, ctx, lifetime, output, runtime, opsApi };
}
const create = ['create-archetype', 'operator', 'Review', 'the', 'implementation'];

const samples: AgentArchetype[] = [
  { name: 'review-tools', description: 'Build and edit a source formatter.', tools: ['read', 'write', 'edit'], isCustom: false, origin: 'builtin' },
  { name: 'quality', description: 'Assess changes and write a report.', tools: ['read', 'write'], isCustom: false, origin: 'builtin' },
  { name: 'checks', description: 'Write and execute regression tests.', tools: ['read', 'write', 'exec'], isCustom: false, origin: 'builtin' },
  { name: 'investigator', description: 'Investigate architecture and report findings.', tools: ['read', 'edit', 'analyze'], isCustom: false, origin: 'builtin' },
  { name: 'assistant', description: 'Handle general tasks of any kind.', tools: ['read', 'write', 'edit', 'exec'], isCustom: false, origin: 'builtin' },
];

test('complete native evidence chooses all five families in one indexed fan-out', async () => {
  const families = ['implement', 'review', 'test', 'research', 'general'] as const;
  const port = recordedFamilyPort(samples.map((entry, index) => ({ ...entry, family: families[index]! })));
  installJudgmentPort(port.port);
  const result = await readArchetypeFamilies(samples);
  expect(result.readings).toEqual(families.map(family => ({ kind: 'settled', family })));
  expect(port.requests).toHaveLength(1);
  expect(port.requests[0]?.state).toEqual({ archetypes: samples.map(({ name, description, tools }) => ({ name, description, tools })) });
  expect(Object.keys(port.requests[0]?.questions ?? {})).toEqual(samples.map((_, index) => `archetype${index}__family`));
  result.assertCurrent();
});

for (const confidence of [.65, .5]) test(`unsettled family at confidence ${confidence} creates no native task`, async () => {
  const f = fixture(), port = recordedFamilyPort(f.entries, confidence); installJudgmentPort(port.port);
  await f.registry.execute('teamwork', [...create], f.ctx);
  expect(port.requests).toHaveLength(1); expect(f.opsApi.tasks.list()).toEqual([]);
  expect(f.output.join('\n')).toContain('no settled family');
});

test('settled review uses direct protocol with canonical runner metadata and actual native task', async () => {
  const f = fixture(), port = recordedFamilyPort(f.entries); installJudgmentPort(port.port);
  await f.registry.execute('teamwork', [...create], f.ctx);
  const tasks = f.opsApi.tasks.list(); expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ kind: 'agent', owner: 'custom:operator', title: 'Review the implementation', status: 'queued' });
  expect(tasks[0]?.description).toContain('"family":"review"');
  expect(tasks[0]?.description).toContain('"executionProtocol":"direct"');
  expect(tasks[0]?.description).not.toContain('reviewMode');
});

for (const action of ['escape', 'session-away-back', 'shutdown', 'port', 'native-account', 'source-bytes', 'file-away-back', 'directory-away-back', 'create-method', 'arguments'] as const) {
  test(`${action} retires an ignored-signal family response before native creation`, async () => {
    const f = fixture(), base = recordedFamilyPort(f.entries), held = drain.hold(base.port);
    let account = 'original'; const accountIdentity = {};
    bindJudgmentPortAuthority(held.port, () => ({ identity: accountIdentity, assertCurrent() { if (account !== 'original') throw new Error('Native account retired.'); } }));
    installJudgmentPort(held.port);
    const args = [...create], pending = drain.own(f.registry.execute('teamwork', args, f.ctx));
    await held.started;
    if (action === 'escape') f.lifetime.withCancellation(() => false)();
    if (action === 'session-away-back') { f.lifetime.cancel(); f.runtime.sessionId = 'other'; f.runtime.sessionId = 'teamwork-session'; }
    if (action === 'shutdown') f.lifetime.dispose();
    if (action === 'port') installJudgmentPort(base.port);
    if (action === 'native-account') account = 'retired';
    if (action === 'source-bytes') writeFileSync(f.file, f.text + 'Changed source.\n');
    if (action === 'file-away-back') { const retired = f.file + '.retired'; renameSync(f.file, retired); writeFileSync(f.file, f.text); rmSync(f.file); renameSync(retired, f.file); }
    if (action === 'directory-away-back') { const retired = f.directory + '-retired'; renameSync(f.directory, retired); mkdirSync(f.directory); rmSync(f.directory, { recursive: true }); renameSync(retired, f.directory); }
    if (action === 'create-method') f.opsApi.tasks.create = () => { throw new Error('Replacement task owner must never run.'); };
    if (action === 'arguments') args[2] = 'Replacement';
    held.release(); await pending;
    expect(f.opsApi.tasks.list()).toEqual([]); expect(f.output.join('\n')).not.toContain('Created teamwork task');
  });
}

test('supported symlink sources remain current and late target replacement is refused', async () => {
  const f = fixture(), target = join(f.root, 'target.md');
  renameSync(f.file, target); symlinkSync(target, f.file);
  const port = recordedFamilyPort(f.entries); installJudgmentPort(port.port);
  await f.registry.execute('teamwork', [...create], f.ctx); expect(f.opsApi.tasks.list()).toHaveLength(1);
  const held = drain.hold(port.port); installJudgmentPort(held.port);
  const pending = drain.own(f.registry.execute('teamwork', [...create], f.ctx)); await held.started;
  renameSync(target, target + '.retired'); writeFileSync(target, f.text);
  held.release(); await pending; expect(f.opsApi.tasks.list()).toHaveLength(1);
});

for (const field of ['name', 'description', 'tools', 'systemPrompt'] as const) test(`complete original ${field} material is refused before wire`, async () => {
  const entry: AgentArchetype = { ...samples[0]!, tools: [...samples[0]!.tools] };
  if (field === 'tools') entry.tools.push('Authorization: Bearer synthetic-private-value');
  else entry[field] = 'Authorization: Bearer synthetic-private-value';
  const port = recordedFamilyPort([{ ...entry, family: 'implement' }]); installJudgmentPort(port.port);
  await expect(readArchetypeFamilies([entry])).rejects.toThrow(); expect(port.requests).toEqual([]);
});

test('the full native markdown tail is screened before parse or family request', async () => {
  const f = fixture(), port = recordedFamilyPort(f.entries); installJudgmentPort(port.port);
  writeFileSync(f.file, f.text + '\nAuthorization: Bearer synthetic-private-value\n');
  await f.registry.execute('teamwork', [...create], f.ctx);
  expect(port.requests).toEqual([]); expect(f.opsApi.tasks.list()).toEqual([]);
  expect(f.output.join('\n')).not.toContain('synthetic-private-value');
});

test('native original slots cannot be replaced while the shared listing request waits', async () => {
  const entry: AgentArchetype = { ...samples[0]!, tools: [...samples[0]!.tools] }, base = recordedFamilyPort([{ ...entry, family: 'implement' }]);
  const held = drain.hold(base.port); installJudgmentPort(held.port);
  const pending = drain.own(readArchetypeFamilies([entry])); await held.started;
  entry.tools = [...entry.tools]; held.release(); await expect(pending).rejects.toThrow();
});

test('original proxy and hidden accessor are rejected without invoking them', async () => {
  const entry: AgentArchetype = { ...samples[0]!, tools: [...samples[0]!.tools] }; let touched = 0;
  Object.defineProperty(entry, 'ignored', { get() { touched++; return 'private'; } });
  const port = recordedFamilyPort([{ ...samples[0]!, family: 'implement' }]); installJudgmentPort(port.port);
  await expect(readArchetypeFamilies([entry])).rejects.toThrow();
  await expect(readArchetypeFamilies(new Proxy([samples[0]!], {}))).rejects.toThrow();
  expect(touched).toBe(0); expect(port.requests).toEqual([]);
});

test('complete malformed result is rejected before family consumption or native write', async () => {
  const f = fixture(), port = recordedFamilyPort(f.entries);
  installJudgmentPort({ model: port.port.model, async ask(request) {
    const result = await port.port.ask(request);
    return { ...result, ignored: { authorization: 'Bearer synthetic-private-value' } };
  } });
  await f.registry.execute('teamwork', [...create], f.ctx);
  expect(f.opsApi.tasks.list()).toEqual([]); expect(f.output.join('\n')).not.toContain('synthetic-private-value');
});

test('missing reader holds archetype creation while explicit static modes remain available', async () => {
  const f = fixture(); installJudgmentPort(undefined);
  await f.registry.execute('teamwork', [...create], f.ctx); expect(f.opsApi.tasks.list()).toEqual([]);
  await f.registry.execute('teamwork', ['create-mode', 'local-shell', 'Run', 'checks'], f.ctx);
  expect(f.opsApi.tasks.list()).toHaveLength(1);
  expect(f.opsApi.tasks.list()[0]?.description).not.toContain('reviewMode');
});

// The actual captured listing remains callable; this is not a substituted parser.
test('native local override keeps its chosen family and custom task owner', async () => {
  const f = fixture();
  const override = { name: 'engineer', description: 'Assess changes and report defects without implementation work.', tools: ['read', 'analyze'], family: 'review' as const };
  writeFileSync(join(f.directory, 'engineer.md'), '---\nname: engineer\ndescription: ' + override.description + '\ntools: [read, analyze]\n---\nReview the existing changes.\n');
  const port = recordedFamilyPort([...f.entries.filter(entry => entry.name !== 'engineer'), override]); installJudgmentPort(port.port);
  await f.registry.execute('teamwork', ['create-archetype', 'engineer', 'Review', 'changes'], f.ctx);
  expect(port.requests).toHaveLength(1); expect(f.opsApi.tasks.list()).toHaveLength(1);
  expect(f.opsApi.tasks.list()[0]).toMatchObject({ owner: 'custom:engineer', status: 'queued' });
  expect(f.opsApi.tasks.list()[0]?.description).toContain('"family":"review"');
  expect(f.opsApi.tasks.list()[0]?.description).toContain('"executionProtocol":"direct"');
});

test('native listing currentness detects a new markdown entry', () => {
  const f = fixture(), source = captureArchetypeListing(f.directory); source.assertCurrent();
  writeFileSync(join(f.directory, 'new.md'), f.text.replace('name: operator', 'name: another'));
  expect(source.assertCurrent).toThrow();
});

test('a non-synchronous source guard cannot start a family request', async () => {
  const port = recordedFamilyPort([{ ...samples[0]!, family: 'implement' }]); installJudgmentPort(port.port);
  await expect(readArchetypeFamilies([samples[0]!], { assertCurrent: () => Promise.resolve() })).rejects.toThrow();
  expect(port.requests).toEqual([]);
});
