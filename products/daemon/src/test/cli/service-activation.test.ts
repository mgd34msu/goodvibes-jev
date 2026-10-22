import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createDaemonCliConfiguration } from '../../cli/configuration.js';
import { parseDaemonCli } from '../../cli/parser.js';
import { createProductionDaemonRuntime } from '../../cli/production-runtime.js';
import { runDaemonCli } from '../../cli/run.js';
import { resolveShippedServiceExecutable } from '../../cli/service-executable.js';
import type { ManagedServiceActionRunner } from '../../daemon/service-commands.js';
import { VERSION } from '../../version.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
import { writeNativeInstallationFixture } from '../helpers/native-runtime-provenance.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type Call = { readonly command: string; readonly args: readonly string[] };
function fixture() {
  const root = makeOwnedTempDir('daemon-service-activation'); roots.push(root);
  const native = writeNativeInstallationFixture(join(root, 'native'), VERSION);
  const home = join(root, 'login-home'); const tree = join(root, 'tree');
  const daemon = join(root, 'daemon'); const workspace = join(root, 'workspace');
  const env = { HOME: home, GOODVIBES_HOME: tree };
  const selected = ['--daemon-home', daemon, '--working-dir', workspace];
  const configuration = createDaemonCliConfiguration(parseDaemonCli(['install-service', ...selected]).flags, env, root);
  configuration.config.set('service.platform', 'systemd');
  configuration.config.set('service.serviceName', 'service-activation-fixture');
  const unit = join(home, '.config', 'systemd', 'user', 'service-activation-fixture.service');
  const legacy = join(home, '.config', 'systemd', 'user', 'goodvibes-daemon.service');
  const calls: Call[] = [];
  const lines: string[] = [];
  let running = false; let legacyRunning = true;
  let observe: ((call: Call) => void) | undefined;
  const runner: ManagedServiceActionRunner = (command, args) => {
    const call = { command, args: [...args] }; calls.push(call); observe?.(call);
    if (command === 'systemctl' && args[0] === '--version') return { status: 0, stdout: 'systemd 256' };
    if (command === 'loginctl') return { status: 0, stdout: 'Linger=yes' };
    const old = args.includes('goodvibes-daemon.service');
    if (args.includes('is-active')) {
      const active = old ? legacyRunning : running;
      return { status: active ? 0 : 3, stdout: active ? 'active' : 'inactive' };
    }
    if (old && args.includes('stop')) legacyRunning = false;
    else if (!old && (args.includes('enable') || args.includes('restart'))) running = true;
    return { status: 0 };
  };
  const options = {
    env, cwd: root, runtime: createProductionDaemonRuntime(),
    resolveServiceExecutable: () => resolveShippedServiceExecutable(native.options),
    serviceActionRunner: runner, stdout: (line: string) => { lines.push(line); },
    stderr: (line: string) => { lines.push(line); },
  };
  const replaceRuntime = () => {
    const member = native.targets[1];
    if (!member) throw new Error('Missing synthetic runtime member');
    copyFileSync(member.path, member.path + '.replacement'); renameSync(member.path + '.replacement', member.path);
  };
  return { root, native, home, tree, daemon, workspace, selected, unit, legacy, calls, lines, options, replaceRuntime,
    observe(listener: (call: Call) => void) { observe = listener; },
    invoke(command: string, extra: readonly string[] = []) { return runDaemonCli([command, ...selected, ...extra], options); },
  };
}
function mutations(calls: readonly Call[]) {
  return calls.filter(call => call.args.some(arg => ['enable', 'restart', 'stop', 'disable', 'daemon-reload', 'enable-linger'].includes(arg)));
}

test('shipped native admission installs the exact executable and selected homes through the real service dispatcher', async () => {
  const f = fixture();
  const { runtime, ...options } = f.options;
  let constructions = 0;
  expect(await runDaemonCli(['install-service', ...f.selected], { ...options,
    async createRuntime() { constructions++; return runtime; },
  })).toBe(0);
  expect(constructions).toBe(1);
  const unit = readFileSync(f.unit, 'utf8');
  expect(unit).toContain(f.native.execPath); expect(unit).toContain(f.daemon);
  expect(unit).toContain(f.tree); expect(unit).toContain(f.workspace);
  expect(unit).not.toContain('src/daemon/cli.ts'); expect(unit).not.toContain('--hostname'); expect(unit).not.toContain('--port');
  expect(f.calls.some(call => call.command === 'systemctl' && call.args.includes('enable') && call.args.includes('--now'))).toBe(true);
});

for (const action of ['start-service', 'restart-service']) test(`shipped native ${action} reaches the matching installed unit`, async () => {
  const f = fixture(); expect(await f.invoke('install-service')).toBe(0); f.calls.length = 0;
  expect(await f.invoke(action)).toBe(0);
  expect(f.calls.some(call => call.command === 'systemctl' && call.args.includes(action === 'start-service' ? 'enable' : 'restart'))).toBe(true);
  expect(readFileSync(f.unit, 'utf8')).toContain(f.native.execPath);
});

test('shipped migration preserves the exact consent boundary and only retires the synthetic legacy unit after healthy new startup', async () => {
  const f = fixture(); mkdirSync(dirname(f.legacy), { recursive: true }); writeFileSync(f.legacy, 'synthetic legacy unit');
  expect(await f.invoke('migrate-service')).toBe(0);
  expect(mutations(f.calls)).toEqual([]); expect(existsSync(f.unit)).toBe(false);
  expect(readFileSync(f.legacy, 'utf8')).toBe('synthetic legacy unit');
  f.calls.length = 0;
  expect(await f.invoke('migrate-service', ['--yes'])).toBe(0);
  expect(existsSync(f.unit)).toBe(true); expect(existsSync(f.legacy)).toBe(false);
  const started = f.calls.findIndex(call => call.args.includes('enable'));
  const health = f.calls.findIndex((call, index) => index > started && call.args.includes('is-active') && call.args.includes('service-activation-fixture.service'));
  const stopped = f.calls.findIndex(call => call.args.includes('stop') && call.args.includes('goodvibes-daemon.service'));
  expect(started).toBeGreaterThanOrEqual(0); expect(health).toBeGreaterThan(started); expect(stopped).toBeGreaterThan(health);
});

for (const command of ['install-service', 'migrate-service']) test(`${command} retains the endpoint flag refusal with a valid shipped executable`, async () => {
  const f = fixture();
  const rejection = parseDaemonCli([command, ...f.selected, '--port', '43123']).errors;
  expect(rejection.length).toBeGreaterThan(0);
  expect(await f.invoke(command, ['--port', '43123'])).toBe(2);
  expect(f.lines.slice(0, rejection.length)).toEqual([...rejection]);
  expect(f.calls).toEqual([]);
  expect(existsSync(f.unit)).toBe(false); expect(existsSync(f.legacy)).toBe(false);
});

test('a different selected workspace cannot start the admitted executable under the old unit definition', async () => {
  const f = fixture(); expect(await f.invoke('install-service')).toBe(0); const bytes = readFileSync(f.unit); f.calls.length = 0;
  expect(await runDaemonCli(['start-service', '--daemon-home', f.daemon, '--working-dir', join(f.root, 'other-workspace')], f.options)).toBe(1);
  expect(f.lines.join('\n')).toContain('installed definition does not match');
  expect(mutations(f.calls)).toEqual([]); expect(readFileSync(f.unit)).toEqual(bytes);
});

test('source execution cannot borrow a complete adjacent native installation', async () => {
  const f = fixture();
  expect(await runDaemonCli(['install-service', ...f.selected], { ...f.options,
    resolveServiceExecutable: () => resolveShippedServiceExecutable({ ...f.native.options, bundled: false }),
  })).toBe(2);
  expect(f.calls).toEqual([]); expect(existsSync(f.unit)).toBe(false);
});

test('a missing native cohort refuses before any service query or publication', async () => {
  const f = fixture(); const runtime = f.native.targets[1]; if (!runtime) throw new Error('Missing fixture runtime'); rmSync(runtime.path);
  expect(await f.invoke('install-service')).toBe(1);
  expect(f.calls).toEqual([]); expect(existsSync(f.unit)).toBe(false);
});

test('verified prior recovery cannot authorize activation of a damaged current executable', async () => {
  const f = fixture(); const prior = writeNativeInstallationFixture(join(f.root, 'prior'), '9.9.8-test');
  for (const [index, member] of f.native.targets.entries()) {
    const before = prior.targets[index]; if (!before) throw new Error('Missing prior native member');
    copyFileSync(before.path, member.path + '.previous');
  }
  writeFileSync(f.native.execPath, 'damaged synthetic current executable');
  expect(await f.invoke('install-service')).toBe(1);
  expect(f.calls).toEqual([]); expect(existsSync(f.unit)).toBe(false);
});

test('real same-byte executable-member replacement during the native version query prevents unit publication', async () => {
  const f = fixture(); f.observe(call => { if (call.args[0] === '--version') f.replaceRuntime(); });
  expect(await f.invoke('install-service')).toBe(1);
  expect(f.calls.some(call => call.args[0] === '--version')).toBe(true);
  expect(mutations(f.calls)).toEqual([]); expect(existsSync(f.unit)).toBe(false);
});

test('caller cancellation during native preparation prevents the service write and activation', async () => {
  const f = fixture(); const abort = new AbortController();
  f.observe(call => { if (call.args[0] === '--version') abort.abort(); });
  expect(await runDaemonCli(['install-service', ...f.selected], { ...f.options,
    resolveServiceExecutable: () => resolveShippedServiceExecutable({ ...f.native.options, signal: abort.signal }),
  })).toBe(1);
  expect(mutations(f.calls)).toEqual([]); expect(existsSync(f.unit)).toBe(false);
});

test('native replacement during the start status query prevents any activation of the retained unit', async () => {
  const f = fixture(); expect(await f.invoke('install-service')).toBe(0); const bytes = readFileSync(f.unit); f.calls.length = 0;
  f.observe(call => { if (call.args.includes('is-active')) f.replaceRuntime(); });
  expect(await f.invoke('start-service')).toBe(1);
  expect(mutations(f.calls)).toEqual([]); expect(readFileSync(f.unit)).toEqual(bytes);
});

test('migration retirement after stopping the old unit preserves its definition and refuses the remaining actions', async () => {
  const f = fixture(); mkdirSync(dirname(f.legacy), { recursive: true }); writeFileSync(f.legacy, 'synthetic legacy unit');
  f.observe(call => { if (call.args.includes('stop') && call.args.includes('goodvibes-daemon.service')) f.replaceRuntime(); });
  expect(await f.invoke('migrate-service', ['--yes'])).toBe(1);
  expect(existsSync(f.unit)).toBe(true); expect(readFileSync(f.legacy, 'utf8')).toBe('synthetic legacy unit');
  expect(f.calls.some(call => call.args.includes('stop') && call.args.includes('goodvibes-daemon.service'))).toBe(true);
  expect(f.calls.some(call => call.args.includes('disable') && call.args.includes('goodvibes-daemon.service'))).toBe(false);
  expect(f.calls.some(call => call.args.includes('daemon-reload'))).toBe(false);
});

test('native screening/runtime composition remains mandatory even with a valid executable resolver', async () => {
  const f = fixture(); let resolutions = 0;
  expect(await runDaemonCli(['install-service', ...f.selected], { env: f.options.env, cwd: f.options.cwd, serviceActionRunner: f.options.serviceActionRunner,
    stdout: f.options.stdout, stderr: f.options.stderr,
    resolveServiceExecutable() { resolutions++; return resolveShippedServiceExecutable(f.native.options); },
  })).toBe(2);
  expect(resolutions).toBe(0); expect(f.calls).toEqual([]); expect(existsSync(f.unit)).toBe(false);
});
