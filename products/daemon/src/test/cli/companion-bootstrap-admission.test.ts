import { expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDaemonCliConfiguration } from '../../cli/configuration.js';
import { runConfiguredDaemonCli } from '../../cli/serve.js';
import { runDaemonCli } from '../../cli/run.js';
import type { DaemonProcessExitCode, DaemonProcessHandle } from '../../daemon/process-lifecycle.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

class ProcessFixture extends EventEmitter {
  readonly exits: DaemonProcessExitCode[] = [];
  exit(code: DaemonProcessExitCode) { this.exits.push(code); }
}

function fixture() {
  const root = makeOwnedTempDir('daemon-token-admission');
  const selected = join(root, 'selected');
  const env = { HOME: root, GOODVIBES_HOME: join(root, 'tree'), GOODVIBES_DAEMON_HOME: selected };
  const configuration = createDaemonCliConfiguration({ daemonHome: undefined, workingDir: undefined }, env, root);
  const target = new ProcessFixture();
  let acquisitions = 0;
  const runtime = { inboxFactory() { acquisitions++; throw new Error('No runtime admission expected'); } };
  return { root, selected, env, configuration, target, runtime, acquisitions: () => acquisitions,
    tokenPath: join(selected, 'operator-tokens.json') };
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`${signal} before configured startup acquires neither token nor runtime`, async () => {
    const f = fixture();
    const handle = runConfiguredDaemonCli(f.configuration, f.runtime, f.env, { process: f.target });
    f.target.emit(signal);
    expect(await handle.ready).toBeUndefined();
    expect(await handle.finished).toBe(0);
    expect(f.target.exits).toEqual([0]);
    expect(f.acquisitions()).toBe(0);
    expect(existsSync(f.tokenPath)).toBe(false);
    expect(f.target.listenerCount('SIGINT') + f.target.listenerCount('SIGTERM')).toBe(0);
  });
}

test('direct shutdown before configured startup preserves an existing identity byte-for-byte', async () => {
  const f = fixture();
  mkdirSync(f.selected, { recursive: true });
  const bytes = '{ "token": "synthetic-existing", "peerId": "owned-peer", "createdAt": 1 }\n';
  writeFileSync(f.tokenPath, bytes);
  const handle = runConfiguredDaemonCli(f.configuration, f.runtime, f.env, { process: f.target });
  expect(await handle.shutdown()).toBe(0);
  expect(await handle.ready).toBeUndefined();
  expect(readFileSync(f.tokenPath, 'utf8')).toBe(bytes);
  expect(f.acquisitions()).toBe(0);
});

test('invalid shutdown ownership refuses before token acquisition', () => {
  const f = fixture();
  expect(() => runConfiguredDaemonCli(f.configuration, f.runtime, f.env,
    { process: f.target, shutdownTimeoutMs: -1 })).toThrow('shutdown timeout');
  expect(existsSync(f.tokenPath)).toBe(false);
  expect(f.acquisitions()).toBe(0);
});

test('token publication failure exits unsuccessfully before acquiring the runtime', async () => {
  const f = fixture();
  const rename = fs.renameSync;
  const failure = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to) === f.tokenPath) throw new Error('Synthetic token publication failure');
    return rename(from, to);
  });
  try {
    const handle = runConfiguredDaemonCli(f.configuration, f.runtime, f.env, { process: f.target });
    await expect(handle.ready).rejects.toThrow('Daemon startup failed');
    expect(await handle.finished).toBe(1);
    expect(f.target.exits).toEqual([1]);
    expect(f.acquisitions()).toBe(0);
    expect(existsSync(f.tokenPath)).toBe(false);
    expect(readdirSync(f.selected).filter((name) => name.startsWith('operator-tokens.json'))).toEqual([]);
  } finally { failure.mockRestore(); }
});

test('quarantine reports the changed identity before a reporting-port shutdown fences the graph', async () => {
  const f = fixture();
  mkdirSync(f.selected, { recursive: true });
  const malformed = '{ synthetic-private-token-body';
  writeFileSync(f.tokenPath, malformed);
  const lines: string[] = [];
  let handle!: DaemonProcessHandle;
  handle = runConfiguredDaemonCli(f.configuration, f.runtime, f.env, { process: f.target }, (line) => {
    lines.push(line);
    void handle.shutdown();
  });
  expect(await handle.ready).toBeUndefined();
  expect(await handle.finished).toBe(0);
  expect(f.acquisitions()).toBe(0);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('paired clients must pair again');
  expect(lines[0]).toContain('previous file was preserved');
  expect(lines[0]).not.toContain(malformed);
  expect(readFileSync(`${f.tokenPath}.unrecognized`, 'utf8')).toBe(malformed);
  const record = JSON.parse(readFileSync(f.tokenPath, 'utf8')) as { token: string };
  expect(record.token.startsWith('gv_')).toBe(true);
  expect(lines[0]).not.toContain(record.token);
});

test('unsupported default composition and invalid serve flags never bootstrap an identity', async () => {
  for (const args of [['serve'], ['serve', '--enable', 'unknown-fixture-feature']]) {
    const f = fixture();
    const stderr: string[] = [];
    const code = await runDaemonCli(args, { env: f.env, cwd: f.root,
      ...(args.length > 1 ? { runtime: f.runtime } : {}),
      process: { process: f.target }, stdout() {}, stderr: (line) => { stderr.push(line); } });
    expect(code).toBe(2);
    expect(stderr.length).toBeGreaterThan(0);
    expect(existsSync(f.tokenPath)).toBe(false);
    expect(f.acquisitions()).toBe(0);
  }
});
