/** Isolated module replacement supplies runtime services; actual CLI dispatch,
 * public runtime snapshots, shared setup reader and bundle serialization run. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const productRoot = resolve(import.meta.dir, '../../..');

const source = `
import { mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { parseGoodVibesCli } from '@goodvibes-jev/engine/terminal-shell';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
const home = process.env.HOME;
const facts = {
  gateway: { auth: { mode: 'anonymous', configured: true }, setup: { description: 'Operator-managed gateway with independently billed upstreams.' } },
  cloud: { auth: { mode: 'api-key', configured: true }, setup: { description: 'Cloud account resource credentials and workload identity.' } },
  missing: {},
};
const models = Object.keys(facts).flatMap(provider => ['one', 'two'].map(id => ({ provider, id, registryKey: provider + ':' + id, displayName: id, selectable: true, contextWindow: 2048 })));
let disposed = 0, stopped = 0;
const providers = Object.fromEntries(Object.keys(facts).map(name => [name, { name, models: ['one', 'two'], describeRuntime: async () => facts[name] }]));
const providerRegistry = {
  listProviders: () => Object.values(providers), getRegistered: id => providers[id], describeRuntime: async id => facts[id],
  getCurrentModel: () => models[0], listModels: () => models, getSelectableModels: () => models,
  resolveModelPricing: () => ({ status: 'unpriced' }), getContextWindowForModel: () => 2048, getKnownContextWindowForModel: () => 2048,
  initModelLimits() {}, initCatalog() {}, ready: async () => {}, stopWatching() { stopped++; },
};
mock.module('./src/runtime/services.ts', () => ({ createRuntimeServices: () => ({ providerRegistry, benchmarkStore: { initBenchmarks() {} }, dispose() { disposed++; } }) }));
const posture = await import('./src/cli/service-posture.ts');
mock.module('./src/cli/service-posture.ts', () => ({ ...posture, buildCliServicePosture: async () => ({ issues: [] }) }));
const { handleGoodVibesCliCommand } = await import('./src/cli/management.ts');
const { handleBundleCommand } = await import('./src/cli/bundle-command.ts');
const configManager = new ConfigManager({ workingDir: home, homeDir: home, surfaceRoot: 'tui' });
const runtime = args => ({ cli: parseGoodVibesCli(args, 'goodvibes'), configManager, workingDirectory: home, homeDirectory: home });
const answer = fakePort((name, _q, state) => noulAnswer((name === 'self_hosted' && String(state).includes('Operator-managed gateway')) || (name === 'cloud_account' && String(state).includes('Cloud account resource')) ? 0.99 : 0.01));
let release; let wait = new Promise(r => { release = r; });
installJudgmentPort({ ...answer.port, async ask(request) { await wait; return answer.port.ask(request); } });
const printed = [], outputs = {}; const originalLog = console.log;
console.log = text => { printed.push(text); };
const listing = handleGoodVibesCliCommand(runtime(['providers', 'list', '--json']));
await new Promise(r => setTimeout(r, 0));
if (printed.length !== 0) throw new Error('provider list did not await setup facts');
release();
if ((await listing).exitCode !== 0) throw new Error('provider list failed');
outputs.providers = JSON.parse(printed.pop());
for (const [key, args] of [['inspect', ['providers', 'inspect', 'cloud', '--json']], ['current', ['models', 'current', '--json']], ['models', ['models', 'list', '--json']]]) {
  answer.requests.length = 0;
  if ((await handleGoodVibesCliCommand(runtime(args))).exitCode !== 0) throw new Error(key + ' failed');
  outputs[key] = JSON.parse(printed.pop());
  if (key === 'models') {
    // Model-family presentation has its own reads; count the setup battery only.
    const setupReads = answer.requests.filter(request => request.context?.battery === 'providers.setup-presentation');
    outputs.modelReads = setupReads.map(request => JSON.parse(String(request.state)).provider.id);
  }
}
const bundlePath = join(home, 'bundle.json');
const exported = await handleBundleCommand(runtime(['support-bundle', 'export', bundlePath, '--json']));
if (exported.exitCode !== 0) throw new Error(exported.output);
outputs.bundle = JSON.parse(readFileSync(bundlePath, 'utf8')).diagnostics.providers;
installJudgmentPort({ ...answer.port, async ask() { throw new Error('reading unavailable'); } });
await handleGoodVibesCliCommand(runtime(['providers', 'inspect', 'cloud', '--json']));
outputs.unavailable = JSON.parse(printed.pop());
outputs.disposed = disposed; outputs.stopped = stopped;
console.log = originalLog;
console.log(JSON.stringify(outputs));
`;

test('actual providers, models and support-bundle callers await shared setup facts and retain unknown', () => {
  const home = mkdtempSync(join(tmpdir(), 'provider-setup-callers-'));
  try {
    const child = Bun.spawnSync([process.execPath, '--eval', source], {
      cwd: productRoot, env: { ...process.env, HOME: home, GOODVIBES_HOME: home, GOODVIBES_DAEMON_HOME: join(home, 'daemon') },
      stdout: 'pipe', stderr: 'pipe', timeout: 15000,
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const output = JSON.parse(child.stdout.toString().trim().split('\n').at(-1)!);
    expect(output.providers.map((row: { setupClass: string }) => row.setupClass)).toEqual(['self-hosted', 'cloud-account', 'unknown']);
    expect(output.inspect.setup.setupClass).toBe('cloud-account');
    expect(output.current.setup.setupClass).toBe('self-hosted');
    expect(output.models.map((row: { setupClass: string }) => row.setupClass)).toEqual(['self-hosted', 'self-hosted', 'cloud-account', 'cloud-account', 'unknown', 'unknown']);
    expect(output.modelReads.sort()).toEqual(['cloud', 'gateway', 'missing']);
    expect(output.bundle.map((row: { setup: { setupClass: string } }) => row.setup.setupClass)).toEqual(['self-hosted', 'cloud-account', 'unknown']);
    expect(output.unavailable.setup.setupClass).toBe('unknown');
    expect(output.disposed).toBe(6); expect(output.stopped).toBe(6);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 20000);
