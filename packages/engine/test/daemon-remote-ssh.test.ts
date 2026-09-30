import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createSshBackend } from '../sdk/src/platform/runtime/remote/host/backends/ssh.ts';
import type { Backend, BackendContext } from '../sdk/src/platform/runtime/remote/host/backends/types.ts';
import type { PeerRecord, SshBackendConfig } from '../sdk/src/platform/runtime/remote/host/peer-registry.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const KEY = 'dummy-ssh-private-key-for-fixture';
const REF = 'goodvibes://secrets/goodvibes/FIXTURE';
const captures: Array<{ args: string[]; file: string; contents: string }> = [];
const controls: string[][] = [];
const backends: Backend[] = [];
const socketPaths = new Set<string>();
let home: string;
let lookups: number;
let kills: number;
let holdFirst: Promise<number> | undefined;
let releaseFirst: ((value: number) => void) | undefined;
let firstSpawned: Promise<void>;
let signalFirst!: () => void;
let output = 'fixture output';
let controlExit = 0;

function peer(config: Partial<SshBackendConfig> = {}, peerId = 'peer'): PeerRecord {
  return { peerId, displayName: 'Fixture', backendKind: 'ssh', backendConfig: {
    kind: 'ssh', sshHost: 'one.invalid', sshUser: 'fixture', sshPort: 22, identityRef: REF, ...config,
  } };
}
function backend(resolveRef: BackendContext['credentials']['resolveRef'] = async () => { lookups += 1; return KEY; }): Backend {
  const result = createSshBackend({ credentials: { resolveRef }, logger: { info() {}, warn() {}, error() {} }, homeDirectory: home });
  backends.push(result);
  return result;
}

beforeEach(() => {
  home = makeProjectTempDir('ssh-backend');
  lookups = 0; kills = 0; output = 'fixture output'; controlExit = 0;
  holdFirst = undefined; releaseFirst = undefined;
  captures.length = 0; controls.length = 0; socketPaths.clear();
  firstSpawned = new Promise<void>((resolve) => { signalFirst = resolve; });
  const originalLstat = fsPromises.lstat;
  spyOn(fsPromises, 'lstat').mockImplementation(((...args: Parameters<typeof fsPromises.lstat>) => {
    if (socketPaths.has(String(args[0]))) return Promise.resolve({ isSocket: () => true });
    return originalLstat(...args);
  }) as unknown as typeof fsPromises.lstat);
  spyOn(Bun, 'spawn').mockImplementation(((args: string[]) => {
    if (args.includes('-O')) {
      controls.push(args);
      return { stdout: new Blob([]).stream(), stderr: new Blob([]).stream(), stdin: null, exited: Promise.resolve(controlExit), kill() {} };
    }
    const file = args[args.indexOf('-i') + 1]!;
    const first = captures.length === 0;
    captures.push({ args, file, contents: readFileSync(file, 'utf8') });
    const path = args.find((arg) => arg.startsWith('ControlPath='))?.slice('ControlPath='.length);
    if (path && path !== 'none') socketPaths.add(path);
    signalFirst();
    return {
      stdout: new Blob([output]).stream(), stderr: new Blob([]).stream(), stdin: null,
      exited: first && holdFirst ? holdFirst : Promise.resolve(0), kill() { kills += 1; releaseFirst?.(137); },
    };
  }) as unknown as typeof Bun.spawn);
});
afterEach(async () => {
  releaseFirst?.(0);
  await Promise.allSettled(backends.splice(0).map((item) => item.teardown?.()));
  (Bun.spawn as unknown as { mockRestore(): void }).mockRestore();
  (fsPromises.lstat as unknown as { mockRestore(): void }).mockRestore();
  (Buffer.byteLength as unknown as { mockRestore?: () => void }).mockRestore?.();
});

// Exercise the multiplexing branch without putting fixtures outside the shared
// test-owned tree. The CLI and socket are mocked; no real Unix socket is bound.
function simulateShortSocketPath() {
  const original = Buffer.byteLength;
  spyOn(Buffer, 'byteLength').mockImplementation(((value: Parameters<typeof Buffer.byteLength>[0], encoding?: BufferEncoding) => {
    const path = typeof value === 'string' ? value.replaceAll('\\', '/') : '';
    if (path.includes('/ssh-keys/owner-') && /\/m[a-f0-9]{8}$/.test(path)) return 90;
    return original(value, encoding);
  }) as typeof Buffer.byteLength);
}

describe('SSH identity binding and command contract', () => {
  test('preserves flags and remote-shell args without placing the credential in argv', async () => {
    const item = backend();
    await item.dispatch(peer(), 'echo', { args: ['a b', '$HOME'] });
    expect(captures[0]?.contents).toBe(`${KEY}\n`);
    expect(captures[0]?.args).toContain('StrictHostKeyChecking=accept-new');
    expect(captures[0]?.args).toContain('BatchMode=yes');
    expect(captures[0]?.args.slice(-2)).toEqual(['fixture@one.invalid', 'echo a b $HOME']);
    expect(captures[0]?.args.join(' ')).not.toContain(KEY);
  });

  test('same binding shares one pending identity and reuses its key', async () => {
    const item = backend();
    await Promise.all([item.dispatch(peer(), 'one'), item.dispatch(peer(), 'two')]);
    expect(lookups).toBe(1);
    expect(captures[0]?.file).toBe(captures[1]?.file);
  });

  test.each([
    { sshHost: 'two.invalid' }, { sshUser: 'other' }, { sshPort: 2222 }, { identityRef: `${REF}_NEW` },
  ])('destination or reference change replaces the pooled binding: %j', async (change) => {
    const item = backend();
    await item.dispatch(peer(), 'one');
    await item.dispatch(peer(change), 'two');
    expect(lookups).toBe(2);
    expect(captures[0]?.file).not.toBe(captures[1]?.file);
  });

  test('rotation retains the prior key while a dispatch still holds its lease', async () => {
    holdFirst = new Promise<number>((resolve) => { releaseFirst = resolve; });
    const item = backend();
    const first = item.dispatch(peer(), 'one');
    try {
      await firstSpawned;
      await item.dispatch(peer({ identityRef: `${REF}_NEW` }), 'two');
      expect(readFileSync(captures[0]!.file, 'utf8')).toBe(`${KEY}\n`);
    } finally { releaseFirst?.(0); await first; }
    await item.teardown?.();
    for (const call of captures) expect(existsSync(call.file)).toBe(false);
  });

  test('peer IDs never become credential paths', async () => {
    await backend().dispatch(peer({}, '../outside'), 'uptime');
    const path = relative(join(home, '.goodvibes', 'tui', 'operator', 'ssh-keys'), captures[0]!.file);
    expect(path.startsWith('..')).toBe(false);
    expect(path.split('/').length).toBe(2);
  });

  test('known key bytes and resolver errors are not returned', async () => {
    output = KEY;
    expect((await backend().dispatch(peer(), 'uptime')).stdout).not.toContain(KEY);
    await expect(backend(async () => { throw new Error(KEY); }).dispatch(peer(), 'uptime'))
      .rejects.toMatchObject({ code: 'REMOTE_BACKEND_CREDENTIAL_FAILED' });
  });
});

describe('SSH owned teardown', () => {
  test('a failed lookup does not poison a later retry', async () => {
    let attempts = 0;
    const item = backend(async () => ++attempts === 1 ? null : KEY);
    await expect(item.dispatch(peer(), 'uptime')).rejects.toMatchObject({ code: 'REMOTE_BACKEND_CREDENTIAL_MISSING' });
    await item.dispatch(peer(), 'uptime');
    expect(attempts).toBe(2);
    expect(captures).toHaveLength(1);
  });

  test('long paths disable connection sharing while retaining command execution', async () => {
    home = join(home, 'long-home-'.repeat(12));
    const item = backend();
    await item.dispatch(peer(), 'uptime');
    expect(captures[0]?.args).toContain('ControlMaster=no');
    expect(captures[0]?.args).toContain('ControlPath=none');
    await item.teardown?.();
    expect(controls).toHaveLength(0);
  });

  test('a second instance cannot erase the first instance active key', async () => {
    holdFirst = new Promise<number>((resolve) => { releaseFirst = resolve; });
    const first = backend().dispatch(peer(), 'uptime');
    try {
      await firstSpawned;
      await backend().teardown?.();
      expect(readFileSync(captures[0]!.file, 'utf8')).toBe(`${KEY}\n`);
    } finally { releaseFirst?.(0); await first; }
  });

  test('late lookup cannot resume after teardown', async () => {
    let resolve!: (value: string) => void;
    let enter!: () => void;
    const entered = new Promise<void>((done) => { enter = done; });
    const key = new Promise<string>((done) => { resolve = done; });
    const item = backend(() => { enter(); return key; });
    const result = item.dispatch(peer(), 'uptime').then(() => 'ran', () => 'closed');
    await entered;
    await item.teardown?.();
    resolve(KEY);
    expect(await result).toBe('closed');
    expect(captures).toHaveLength(0);
  });

  test('teardown stops active owned SSH before deleting its key', async () => {
    holdFirst = new Promise<number>((resolve) => { releaseFirst = resolve; });
    const item = backend();
    const result = item.dispatch(peer(), 'uptime').then(() => 'ran', () => 'closed');
    try {
      await firstSpawned;
      await item.teardown?.();
      expect(kills).toBe(1);
      expect(await result).toBe('closed');
      expect(existsSync(captures[0]!.file)).toBe(false);
    } finally { releaseFirst?.(0); await result; }
  });

  test('teardown asks a mocked short-path multiplexing master to exit', async () => {
    simulateShortSocketPath();
    const item = backend();
    await item.dispatch(peer(), 'uptime');
    expect(captures[0]?.args).toContain('ControlMaster=auto');
    await item.teardown?.();
    expect(controls).toHaveLength(1);
    expect(controls[0]).toContain('exit');
    expect(controls[0]?.slice(-2)).toEqual(['--', 'fixture@one.invalid']);
    expect(existsSync(captures[0]!.file)).toBe(false);
  });

  test('failed master cleanup is visible but still removes the private key', async () => {
    simulateShortSocketPath();
    controlExit = 1;
    const item = backend();
    await item.dispatch(peer(), 'uptime');
    await expect(item.teardown?.()).rejects.toMatchObject({ code: 'REMOTE_BACKEND_CLEANUP_FAILED' });
    expect(existsSync(captures[0]!.file)).toBe(false);
  });
});
