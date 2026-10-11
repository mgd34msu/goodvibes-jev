import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyRuntimeConfigValue } from '@goodvibes-jev/engine/terminal-shell';
import * as pairing from '@goodvibes-jev/engine/sdk/platform/pairing';
import * as reconcile from '../../runtime/legacy-daemon-reconcile.js';
import { createDaemonCliConfiguration } from '../../cli/configuration.js';
import { persistDaemonStartupPublicUrl, pruneDaemonStartupTokens, reconcileDaemonStartup } from '../../cli/startup-maintenance.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });
function fixture(overridden = true) {
  const root = makeOwnedTempDir('startup-maintenance');
  const env = { HOME: root, ...(overridden ? { GOODVIBES_DAEMON_HOME: join(root, 'selected') } : {}) };
  const configuration = createDaemonCliConfiguration({ daemonHome: undefined, workingDir: undefined }, env, root);
  return { root, env, configuration };
}

test('prune uses the selected canonical identity and both original workspace candidates only', () => {
  const f = fixture();
  const canonical = join(f.configuration.daemonHomeDirectory, 'operator-tokens.json');
  const candidates = ['.goodvibes/operator-tokens.json', '.goodvibes/tui/operator-tokens.json'].map((p) => join(f.root, p));
  const untouched = join(f.root, '.goodvibes/daemon/operator-tokens.json');
  for (const path of [canonical, ...candidates, untouched]) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'synthetic'); }
  expect(pruneDaemonStartupTokens(f.configuration)).toBe(0);
  expect(candidates.map(existsSync)).toEqual([false, false]);
  expect(readFileSync(canonical, 'utf8')).toBe('synthetic');
  expect(readFileSync(untouched, 'utf8')).toBe('synthetic');
  expect(pruneDaemonStartupTokens(f.configuration)).toBe(0);
});

test('canonical file which aliases a workspace candidate survives pruning', () => {
  const f = fixture();
  const selected = join(f.root, '.goodvibes/tui');
  const configuration = createDaemonCliConfiguration({ daemonHome: selected, workingDir: undefined }, f.env, f.root);
  const canonical = join(selected, 'operator-tokens.json');
  writeFileSync(canonical, 'synthetic');
  pruneDaemonStartupTokens(configuration);
  expect(readFileSync(canonical, 'utf8')).toBe('synthetic');
});

for (const direction of ['selected-home', 'workspace-candidate'] as const) {
  test(`startup preserves canonical token identity through a ${direction} directory symlink`, () => {
    const root = makeOwnedTempDir('startup-token-alias');
    const workspace = join(root, 'workspace');
    const candidateDirectory = join(workspace, '.goodvibes/tui');
    const selected = join(root, 'selected');
    mkdirSync(dirname(candidateDirectory), { recursive: true });
    mkdirSync(direction === 'selected-home' ? candidateDirectory : selected);
    symlinkSync(direction === 'selected-home' ? candidateDirectory : selected,
      direction === 'selected-home' ? selected : candidateDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    const env = { HOME: root, GOODVIBES_DAEMON_HOME: selected };
    const configuration = createDaemonCliConfiguration({ daemonHome: undefined, workingDir: workspace }, env, root);
    const token = pairing.getOrCreateCompanionToken('tui', { daemonHomeDir: selected });
    const canonical = join(selected, 'operator-tokens.json');
    const before = readFileSync(canonical, 'utf8');
    const stale = join(workspace, '.goodvibes/operator-tokens.json');
    writeFileSync(stale, 'synthetic-stale');

    expect(pruneDaemonStartupTokens(configuration)).toBe(0);
    expect(existsSync(stale)).toBe(false);
    expect(readFileSync(canonical, 'utf8')).toBe(before);
    expect(pairing.getOrCreateCompanionToken('tui', { daemonHomeDir: selected })).toEqual(token);
    expect(pruneDaemonStartupTokens(configuration)).toBe(0);
    expect(readFileSync(canonical, 'utf8')).toBe(before);
  });
}

test('reconcile skips overridden homes and pre-aborted admission without touching the service owner', async () => {
  const spy = spyOn(reconcile, 'reconcileRedundantLegacyUnit').mockResolvedValue({ action: 'noop', reason: 'no-legacy-unit', lines: [] });
  restores.push(() => spy.mockRestore());
  const f = fixture();
  await reconcileDaemonStartup(f.configuration, f.env, new AbortController().signal);
  const g = fixture(false); const abort = new AbortController(); abort.abort();
  await reconcileDaemonStartup(g.configuration, g.env, abort.signal);
  expect(spy).not.toHaveBeenCalled();
});

test('reconcile receives login unit home and fresh configured client endpoint without runtime overrides', async () => {
  if (process.platform !== 'linux') return;
  const f = fixture(false);
  f.configuration.config.setDaemonValues({ 'controlPlane.hostMode': 'local', 'controlPlane.port': 4567 });
  f.configuration.config.setDynamic('service.serviceName', 'fixture-daemon');
  applyRuntimeConfigValue(f.configuration.config, 'controlPlane.port', 9876);
  applyRuntimeConfigValue(f.configuration.config, 'service.serviceName', 'runtime-daemon');
  const spy = spyOn(reconcile, 'reconcileRedundantLegacyUnit').mockResolvedValue({ action: 'noop', reason: 'no-legacy-unit', lines: [] });
  restores.push(() => spy.mockRestore());
  const signal = new AbortController().signal;
  await reconcileDaemonStartup(f.configuration, f.env, signal);
  expect(spy).toHaveBeenCalledWith({ homeDir: f.root, trackedServiceName: 'fixture-daemon', configuredEndpoint: { host: '127.0.0.1', port: 4567 }, signal });
});

function servedFixture() {
  const f = fixture(); const bundle = join(f.root, 'bundle');
  mkdirSync(bundle); writeFileSync(join(bundle, 'index.html'), 'fixture');
  f.configuration.config.setDaemonValues({ 'web.publicBaseUrl': '', 'controlPlane.webui.serve': true,
    'controlPlane.webui.bundleDir': bundle, 'controlPlane.hostMode': 'network', 'controlPlane.port': 4567 });
  const ensure = pairing.ensurePublicBaseUrl;
  const spy = spyOn(pairing, 'ensurePublicBaseUrl').mockImplementation((config, _probe, bound) => ensure(config, () => ({ hostname: 'fixture' }), bound));
  restores.push(() => spy.mockRestore());
  return { ...f, bundle, spy, bound: { host: '0.0.0.0', port: 4567, scheme: 'http' as const } };
}

test('served stable origin persists once in the selected daemon tier', () => {
  const f = servedFixture();
  persistDaemonStartupPublicUrl(f.configuration, f.bound);
  expect(f.configuration.config.get('web.publicBaseUrl')).toBe('http://fixture.local:4567');
  const bytes = readFileSync(join(f.configuration.daemonHomeDirectory, 'settings.json'), 'utf8');
  expect(bytes).toContain('http://fixture.local:4567');
  persistDaemonStartupPublicUrl(f.configuration, f.bound);
  expect(f.spy).toHaveBeenCalledTimes(1);
  expect(readFileSync(join(f.configuration.daemonHomeDirectory, 'settings.json'), 'utf8')).toBe(bytes);
});

for (const mode of ['placeholder', 'explicit', 'runtime', 'missing-bundle', 'port-drift', 'scheme-drift', 'disabled'] as const) {
  test(`public URL leaves settings untouched for ${mode}`, () => {
    const f = servedFixture();
    if (mode === 'placeholder') f.configuration.config.setDaemonValues({ 'web.publicBaseUrl': 'http://127.0.0.1:3423' });
    if (mode === 'explicit') f.configuration.config.setDaemonValues({ 'web.publicBaseUrl': 'https://operator.example' });
    if (mode === 'runtime') applyRuntimeConfigValue(f.configuration.config, 'controlPlane.port', 4567);
    if (mode === 'missing-bundle') f.configuration.config.setDaemonValues({ 'controlPlane.webui.bundleDir': join(f.root, 'missing') });
    if (mode === 'disabled') f.configuration.config.setDaemonValues({ 'controlPlane.webui.serve': false });
    const path = join(f.configuration.daemonHomeDirectory, 'settings.json'); const before = readFileSync(path, 'utf8');
    persistDaemonStartupPublicUrl(f.configuration, { ...f.bound, ...(mode === 'port-drift' ? { port: 4568 } : {}), ...(mode === 'scheme-drift' ? { scheme: 'https' as const } : {}) });
    expect(f.spy).not.toHaveBeenCalled(); expect(readFileSync(path, 'utf8')).toBe(before);
  });
}
