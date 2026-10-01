import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createCloudTerminalBackend } from '../sdk/src/platform/runtime/remote/host/backends/cloud-terminal.ts';
import type { Backend, BackendContext } from '../sdk/src/platform/runtime/remote/host/backends/types.ts';
import type { CloudProvider, PeerRecord } from '../sdk/src/platform/runtime/remote/host/peer-registry.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const CREDENTIAL = 'dummy-cloud-credential-for-fixture';
const captures: Array<{ args: string[]; env: Record<string, string>; file: string; contents: string }> = [];
const backends: Backend[] = [];
let home: string;
let holdExit: Promise<number> | undefined;
let resolveExit: ((code: number) => void) | undefined;
let kills: number;
let spawned: Promise<void>;
let signalSpawn!: () => void;
let stdout = 'fixture output';
function peer(provider: CloudProvider = 'gcp', peerId = 'peer'): PeerRecord {
  return { peerId, displayName: 'Fixture', backendKind: 'cloud-terminal', backendConfig: {
    kind: 'cloud-terminal', provider, credentialRef: 'goodvibes://secrets/goodvibes/FIXTURE',
    projectId: 'fixture-project', location: 'fixture-region', instance: 'fixture-instance',
  } };
}
function backend(resolveRef: BackendContext['credentials']['resolveRef'] = async () => CREDENTIAL): Backend {
  const result = createCloudTerminalBackend({
    credentials: { resolveRef }, logger: { info() {}, warn() {}, error() {} }, homeDirectory: home,
  });
  backends.push(result);
  return result;
}
beforeEach(() => {
  home = makeProjectTempDir('cloud-backend');
  captures.length = 0;
  kills = 0;
  holdExit = undefined;
  resolveExit = undefined;
  stdout = 'fixture output';
  spawned = new Promise<void>((resolve) => { signalSpawn = resolve; });
  spyOn(Bun, 'spawn').mockImplementation(((args: string[], options: { env: Record<string, string> }) => {
    const file = options.env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE
      ?? options.env.AWS_SHARED_CREDENTIALS_FILE ?? options.env.AZURE_AUTH_LOCATION!;
    captures.push({ args, env: options.env, file, contents: readFileSync(file, 'utf8') });
    signalSpawn();
    return {
      stdout: new Blob([stdout]).stream(), stderr: new Blob([]).stream(), stdin: null,
      exited: holdExit ?? Promise.resolve(0), kill() { kills += 1; resolveExit?.(137); },
    };
  }) as unknown as typeof Bun.spawn);
});
afterEach(async () => {
  resolveExit?.(0);
  for (const item of backends.splice(0)) await item.teardown?.();
  (Bun.spawn as unknown as { mockRestore(): void }).mockRestore();
});

describe('cloud-terminal pinned command contract', () => {
  test.each(['gcp', 'aws', 'azure'] as const)('retains %s argv and env-only single-use credentials', async (provider) => {
    const item = backend();
    const result = await item.dispatch(peer(provider), 'echo', { args: ['a b', '$HOME'] });
    const captured = captures[0]!;
    expect(captured.contents).toBe(CREDENTIAL);
    expect(captured.args.join(' ')).not.toContain(CREDENTIAL);
    expect(captured.args).toEqual(provider === 'gcp'
      ? ['gcloud', 'compute', 'ssh', '--project', 'fixture-project', '--zone', 'fixture-region', 'fixture-instance', '--command', 'echo a b $HOME']
      : provider === 'aws'
        ? ['aws', 'ssm', 'start-session', '--region', 'fixture-region', '--target', 'fixture-instance', '--document-name', 'AWS-StartInteractiveCommand', '--parameters', 'command=echo a b $HOME']
        : ['az', 'vm', 'run-command', 'invoke', '--resource-group', 'fixture-project', '--name', 'fixture-instance', '--command-id', 'RunShellScript', '--scripts', 'echo a b $HOME']);
    expect(existsSync(captured.file)).toBe(false);
    expect(result).toEqual({ exitCode: 0, stdout: 'fixture output', stderr: '' });
  });

  test('missing credentials refuse before spawning', async () => {
    await expect(backend(async () => null).dispatch(peer(), 'uptime')).rejects.toMatchObject({ code: 'REMOTE_BACKEND_CREDENTIAL_MISSING' });
    expect(captures).toHaveLength(0);
  });

  test('known credential bytes are not returned in output', async () => {
    stdout = `prefix ${CREDENTIAL} suffix`;
    const result = await backend().dispatch(peer(), 'uptime');
    expect(result.stdout).not.toContain(CREDENTIAL);
    expect(result.stdout).toContain('prefix');
  });

  test('resolver failures do not disclose the store exception', async () => {
    await expect(backend(async () => { throw new Error(CREDENTIAL); }).dispatch(peer(), 'uptime'))
      .rejects.toMatchObject({ code: 'REMOTE_BACKEND_CREDENTIAL_FAILED' });
    try { await backend(async () => { throw new Error(CREDENTIAL); }).dispatch(peer(), 'uptime'); }
    catch (error) { expect(String(error)).not.toContain(CREDENTIAL); }
  });
});

describe('cloud-terminal owned lifecycle', () => {
  test('new dispatch after teardown refuses before looking up credentials', async () => {
    let lookups = 0;
    const item = backend(async () => { lookups += 1; return CREDENTIAL; });
    await item.teardown?.();
    await expect(item.dispatch(peer(), 'uptime')).rejects.toMatchObject({ code: 'REMOTE_BACKEND_CLOSED' });
    expect(lookups).toBe(0);
    expect(captures).toHaveLength(0);
  });

  test('a malformed provider is refused before looking up credentials', async () => {
    let lookups = 0;
    const item = backend(async () => { lookups += 1; return CREDENTIAL; });
    await expect(item.dispatch(peer('unsupported' as CloudProvider), 'uptime'))
      .rejects.toMatchObject({ code: 'REMOTE_BACKEND_UNSUPPORTED_PROVIDER' });
    expect(lookups).toBe(0);
    expect(captures).toHaveLength(0);
  });

  test('peer IDs cannot choose credential file paths', async () => {
    await backend().dispatch(peer('gcp', '../outside'), 'uptime');
    const root = join(home, '.goodvibes', 'tui', 'operator', 'cloud-creds');
    const path = relative(root, captures[0]!.file);
    expect(path.startsWith('..')).toBe(false);
    expect(path.split('/').length).toBe(2);
  });

  test('one instance cannot remove another active instance credential', async () => {
    holdExit = new Promise<number>((resolve) => { resolveExit = resolve; });
    const first = backend();
    const pending = first.dispatch(peer(), 'uptime');
    try {
      await spawned;
      const file = captures[0]!.file;
      const second = backend();
      await second.teardown?.();
      expect(readFileSync(file, 'utf8')).toBe(CREDENTIAL);
    } finally { resolveExit?.(0); await pending; }
  });

  test('late credential resolution cannot dispatch or recreate files after teardown', async () => {
    let resolve!: (value: string) => void;
    let entered!: () => void;
    const waiting = new Promise<void>((done) => { entered = done; });
    const credential = new Promise<string>((done) => { resolve = done; });
    const item = backend(() => { entered(); return credential; });
    const settled = item.dispatch(peer(), 'uptime').then(() => 'ran', () => 'closed');
    await waiting;
    await item.teardown?.();
    resolve(CREDENTIAL);
    expect(await settled).toBe('closed');
    expect(captures).toHaveLength(0);
    const root = join(home, '.goodvibes', 'tui', 'operator', 'cloud-creds');
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
  });

  test('teardown aborts an active owned CLI before removing its credential', async () => {
    holdExit = new Promise<number>((resolve) => { resolveExit = resolve; });
    const item = backend();
    const settled = item.dispatch(peer(), 'uptime').then(() => 'ran', () => 'closed');
    try {
      await spawned;
      await item.teardown?.();
      expect(kills).toBe(1);
      expect(await settled).toBe('closed');
      expect(existsSync(captures[0]!.file)).toBe(false);
    } finally { resolveExit?.(0); await settled; }
  });
});
