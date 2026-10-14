import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install, parseOptions, preflight, wrapper, type InstallHooks, type Options, assertPortFree } from './install.ts';
import { COMMANDS, assertOwnedFiles, atomicWrite, dataOwner, readInstallation, unitPath, uninstall, validateLayout, withLock, type Run } from './installation.ts';

let home: string;
let previousHome: string | undefined;
let options: Options;
let state: string;
let actions: string[][];
let execute: Run;
let hooks: InstallHooks;
const COMMIT = 'a'.repeat(40);
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'jev-suite-test-'));
  previousHome = process.env.HOME; process.env.HOME = home;
  options = parseOptions(['--no-service'], home);
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  options.port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  state = 'inactive'; actions = [];
  execute = (command, args) => {
    actions.push([command, ...args]);
    if (command === 'systemctl') {
      if (args.includes('--property=FragmentPath')) return existsSync(unitPath(options)) ? unitPath(options) : '';
      if (args.includes('--property=ActiveState')) return state;
      if (args.includes('stop')) state = 'inactive';
      if (args.includes('start') || args.includes('restart')) state = 'active';
    } else if (command.endsWith('goodvibes-daemon')) {
      atomicWrite(join(options.dataDir, '.goodvibes/daemon/settings.json'), JSON.stringify({ installed: true }));
      atomicWrite(join(options.dataDir, '.goodvibes/tui/settings.json'), JSON.stringify({ judgment: 'jev-latest' }));
    }
    return '';
  };
  hooks = {
    execute, build: async () => COMMIT,
    stage: async (_root, release) => {
      mkdirSync(join(release, 'webui'), { recursive: true }); writeFileSync(join(release, 'webui/index.html'), '<html>test</html>');
      writeFileSync(join(release, 'payload'), 'binary');
    },
    renderUnit: async () => '[Service]\nExecStart=/owned/goodvibes-daemon serve\n',
    ready: async () => {},
  };
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('suite install and uninstall', () => {
  test('installs all command links and preserves credentials/data on removal', async () => {
    await install(options, hooks);
    const receipt = readInstallation(options.prefix)!;
    assertOwnedFiles(receipt);
    for (const name of COMMANDS) expect(readlinkSync(join(options.binDir, name))).toBe(join(options.prefix, 'commands', name));
    atomicWrite(join(options.dataDir, 'environment'), "TYPESAFE_API_KEY='synthetic-private-value'\n");
    writeFileSync(join(options.dataDir, 'user-notes'), 'keep me');
    await uninstall(options.prefix, false, execute);
    expect(existsSync(options.prefix)).toBe(false);
    expect(readFileSync(join(options.dataDir, 'user-notes'), 'utf8')).toBe('keep me');
    expect(readFileSync(join(options.dataDir, 'environment'), 'utf8')).toContain('synthetic-private-value');
    for (const name of COMMANDS) expect(existsSync(join(options.binDir, name))).toBe(false);
    await uninstall(options.prefix, false, execute);
  });
  test('explicit purge removes only the installation data tree', async () => {
    await install(options, hooks);
    writeFileSync(join(home, 'unrelated'), 'keep');
    await uninstall(options.prefix, true, execute);
    expect(existsSync(options.dataDir)).toBe(false);
    expect(readFileSync(join(home, 'unrelated'), 'utf8')).toBe('keep');
  });
  test('reinstall reuses preserved data ownership and credentials', async () => {
    await install(options, hooks);
    const id = readInstallation(options.prefix)!.id;
    writeFileSync(join(options.dataDir, 'user-notes'), 'keep');
    await uninstall(options.prefix, false, execute);
    await install(options, hooks);
    expect(readInstallation(options.prefix)!.id).toBe(id);
    expect(readFileSync(join(options.dataDir, 'user-notes'), 'utf8')).toBe('keep');
  });
  test('updates retain data and replace the release after success', async () => {
    await install(options, hooks);
    const before = readInstallation(options.prefix)!;
    writeFileSync(join(options.dataDir, 'user-notes'), 'keep');
    await install(options, { ...hooks, build: async () => 'b'.repeat(40) });
    const after = readInstallation(options.prefix)!;
    expect(after.id).toBe(before.id);
    expect(after.sourceCommit).not.toBe(before.sourceCommit);
    expect(existsSync(join(options.prefix, 'releases', before.release))).toBe(false);
    expect(readFileSync(join(options.dataDir, 'user-notes'), 'utf8')).toBe('keep');
  });
  test('creates, enables and starts the service; stops and disables it before removal', async () => {
    options.service = true;
    await install(options, hooks);
    expect(actions.some(args => args.includes('enable'))).toBe(true);
    expect(state).toBe('active');
    expect(existsSync(unitPath(options))).toBe(true);
    actions = [];
    await uninstall(options.prefix, false, execute);
    expect(actions.findIndex(args => args.includes('stop'))).toBeLessThan(actions.findIndex(args => args.includes('disable')));
    expect(state).toBe('inactive');
    expect(existsSync(unitPath(options))).toBe(false);
  });
  test('a failed service update restores release, settings and old service', async () => {
    options.service = true;
    await install(options, hooks);
    const before = readInstallation(options.prefix)!;
    const config = join(options.dataDir, '.goodvibes/daemon/settings.json');
    const surface = join(options.dataDir, '.goodvibes/tui/settings.json');
    atomicWrite(config, '{"original":true}'); atomicWrite(surface, '{"originalSurface":true}');
    await expect(install(options, { ...hooks, ready: async () => { throw new Error('readiness failure'); } })).rejects.toThrow('readiness failure');
    expect(readInstallation(options.prefix)).toEqual(before);
    expect(readlinkSync(join(options.prefix, 'current'))).toBe(`releases/${before.release}`);
    expect(readFileSync(config, 'utf8')).toBe('{"original":true}');
    expect(readFileSync(surface, 'utf8')).toBe('{"originalSurface":true}');
    expect(state).toBe('active');
    assertOwnedFiles(before);
  });
  test('failed first start removes published commands and preserves user data', async () => {
    options.service = true;
    await expect(install(options, { ...hooks, ready: async () => { throw new Error('readiness failure'); } })).rejects.toThrow('readiness failure');
    expect(existsSync(options.prefix)).toBe(false);
    expect(existsSync(dataOwner(options))).toBe(true);
    expect(existsSync(unitPath(options))).toBe(false);
    expect(state).toBe('inactive');
    for (const name of COMMANDS) expect(existsSync(join(options.binDir, name))).toBe(false);
    await install(options, hooks);
  });
  test('refuses uninstall if a service cannot stop; leaves payloads and data', async () => {
    options.service = true; await install(options, hooks);
    const failing: Run = (command, args, opts) => {
      if (args.includes('stop')) throw new Error('stop failed');
      return execute(command, args, opts);
    };
    await expect(uninstall(options.prefix, true, failing)).rejects.toThrow('stop failed');
    expect(existsSync(options.prefix)).toBe(true);
    expect(existsSync(options.dataDir)).toBe(true);
    expect(existsSync(unitPath(options))).toBe(true);
  });
  test('refuses a changed service before stopping anything', async () => {
    options.service = true; await install(options, hooks);
    atomicWrite(unitPath(options), 'another service'); actions = [];
    await expect(uninstall(options.prefix, true, execute)).rejects.toThrow('modified');
    expect(actions).toEqual([]);
    expect(existsSync(options.prefix)).toBe(true);
  });
  test('does not remove a replacement command or unrelated installation', async () => {
    await install(options, hooks);
    const link = join(options.binDir, 'goodvibes'); rmSync(link); writeFileSync(link, 'user file');
    await expect(uninstall(options.prefix, true, execute)).rejects.toThrow('another installation');
    expect(readFileSync(link, 'utf8')).toBe('user file');
    expect(existsSync(options.dataDir)).toBe(true);
  });
  test('refuses foreign commands and data before building', () => {
    mkdirSync(options.binDir, { recursive: true }); writeFileSync(join(options.binDir, 'goodvibes'), 'existing');
    expect(() => preflight(options, undefined, execute)).toThrow('Command already exists');
    rmSync(join(options.binDir, 'goodvibes'));
    mkdirSync(options.dataDir, { recursive: true }); writeFileSync(join(options.dataDir, 'notes'), 'existing');
    expect(() => preflight(options, undefined, execute)).toThrow('Data directory is not empty');
  });
  test('refuses symlinked paths, overlap and paths outside the home', () => {
    mkdirSync(join(home, 'actual')); symlinkSync(join(home, 'actual'), join(home, 'link'));
    expect(() => validateLayout({ ...options, prefix: join(home, 'link/program') })).toThrow('symlink');
    expect(() => validateLayout({ ...options, dataDir: options.prefix })).toThrow('overlap');
    expect(() => validateLayout({ ...options, prefix: '/usr/local' })).toThrow('below your home');
  });
  test('rejects a replaced data directory before purge', async () => {
    await install(options, hooks);
    const unrelated = join(home, 'unrelated'); mkdirSync(unrelated); writeFileSync(join(unrelated, 'keep'), 'keep');
    rmSync(options.dataDir, { recursive: true }); symlinkSync(unrelated, options.dataDir);
    await expect(uninstall(options.prefix, true, execute)).rejects.toThrow('symlink');
    expect(readFileSync(join(unrelated, 'keep'), 'utf8')).toBe('keep');
  });
  test('serializes install and uninstall for the same prefix', async () => {
    await withLock(options.prefix, async () => {
      await expect(install(options, hooks)).rejects.toThrow('Another install/uninstall');
    });
    expect(existsSync(`${options.prefix}.lock`)).toBe(false);
  });
  test('rejects occupied ports without touching their listener', async () => {
    const listener = createServer();
    await new Promise<void>(yes => listener.listen(0, '127.0.0.1', yes));
    try {
      const address = listener.address(); if (!address || typeof address === 'string') throw new Error('missing port');
      await expect(assertPortFree(address.port)).rejects.toThrow('already in use');
      expect(listener.listening).toBe(true);
    } finally { await new Promise<void>(yes => listener.close(() => yes())); }
  });
  test('keeps custom paths and service choice on a repeat install', async () => {
    options = parseOptions(['--prefix', join(home, 'programs'), '--data-dir', join(home, 'state'), '--bin-dir', join(home, 'bin'), '--no-service', '--port', '43219'], home);
    await install(options, hooks);
    expect(parseOptions(['--prefix', options.prefix], home)).toMatchObject(options);
  });
  test('generated launchers quote paths and follow jev-latest', () => {
    options = { ...options, prefix: join(home, "programs '$; x"), dataDir: join(home, "state '$; x") };
    const script = wrapper(options, 'goodvibes-daemon');
    expect(script).toContain('export TYPESAFE_DEFAULT_MODEL=jev-latest');
    const result = Bun.spawnSync(['/bin/sh', '-n'], { stdin: new TextEncoder().encode(script) });
    expect(result.exitCode).toBe(0);
    expect(script).toContain("'\\''");
  });
});
