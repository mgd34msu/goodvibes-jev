import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createDockerBackend } from '../sdk/src/platform/runtime/remote/host/backends/docker.ts';
import { createLocalProcessBackend, tokenizeCommand } from '../sdk/src/platform/runtime/remote/host/backends/local-process.ts';
import { BackendDispatchError, buildRemoteShellCommand, resolveTimeout, DEFAULT_SYNC_TIMEOUT_MS, MAX_SYNC_TIMEOUT_MS, type BackendContext } from '../sdk/src/platform/runtime/remote/host/backends/types.ts';
import type { PeerRecord } from '../sdk/src/platform/runtime/remote/host/peer-registry.ts';

const captures: Array<{ args: string[]; options: Record<string, unknown>; stdin: string[] }> = [];
const resolutions: string[] = [];
const context: BackendContext = {
  homeDirectory: '/fixture', logger: { info() {}, warn() {}, error() {} },
  credentials: { async resolveRef(ref) { resolutions.push(ref); return 'fixture-resolved-host'; } },
};
const local = (allowedCommands?: string[]): PeerRecord => ({
  peerId: 'local', displayName: 'Local', backendKind: 'local-process',
  backendConfig: { kind: 'local-process', cwd: '/fixture/default', ...(allowedCommands !== undefined ? { allowedCommands } : {}) },
});
const docker = (dockerHost?: string): PeerRecord => ({
  peerId: 'docker', displayName: 'Docker', backendKind: 'docker',
  backendConfig: { kind: 'docker', containerName: 'web', ...(dockerHost !== undefined ? { dockerHost } : {}) },
});

beforeEach(() => {
  captures.length = 0;
  resolutions.length = 0;
  spyOn(Bun, 'spawn').mockImplementation(((args: string[], options: Record<string, unknown>) => {
    const input: string[] = [];
    captures.push({ args, options, stdin: input });
    return {
      stdout: new Blob(['fixture output']).stream(), stderr: new Blob(['fixture stderr']).stream(),
      stdin: { write: (value: string) => { input.push(value); }, end() {} },
      exited: Promise.resolve(0), kill() {},
    };
  }) as unknown as typeof Bun.spawn);
});
afterEach(() => { (Bun.spawn as unknown as { mockRestore(): void }).mockRestore(); });

describe('remote command grammar and timeout contract', () => {
  test.each([
    ['git status --short', ['git', 'status', '--short']],
    ['echo "hello world" \'a b\'', ['echo', 'hello world', 'a b']],
    ['echo a\\ b', ['echo', 'a b']],
    ['echo ""', ['echo', '']],
  ] satisfies Array<[string, string[]]>)('tokenizes %s', (command, expected) => { expect(tokenizeCommand(command)).toEqual(expected); });

  test.each(['echo "open', 'echo trailing\\'])('refuses incomplete grammar: %s', (command) => {
    expect(() => tokenizeCommand(command)).toThrow(BackendDispatchError);
  });

  test('remote shell args remain unescaped while absent args preserve the command', () => {
    expect(buildRemoteShellCommand('uptime')).toBe('uptime');
    expect(buildRemoteShellCommand('uptime', [])).toBe('uptime');
    expect(buildRemoteShellCommand('echo', ['a b', '$HOME'])).toBe('echo a b $HOME');
  });

  test('timeout follows only the caller duration and fixed ceiling', () => {
    expect(resolveTimeout()).toBe(DEFAULT_SYNC_TIMEOUT_MS);
    for (const timeoutMs of [0, -1, NaN, Infinity]) expect(resolveTimeout({ timeoutMs })).toBe(DEFAULT_SYNC_TIMEOUT_MS);
    expect(resolveTimeout({ timeoutMs: 123 })).toBe(123);
    expect(resolveTimeout({ timeoutMs: MAX_SYNC_TIMEOUT_MS + 1 })).toBe(MAX_SYNC_TIMEOUT_MS);
  });
});

describe('local-process backend', () => {
  test('passes literal argv, env, stdin and explicit cwd without a shell', async () => {
    const result = await createLocalProcessBackend(context).dispatch(local(['printf']), 'printf "hello world"', {
      args: ['a b', '$HOME', ';'], cwd: '/fixture/override', env: { GV_FIXTURE_VALUE: 'value' }, stdin: 'fixture stdin',
    });
    expect(captures[0]?.args).toEqual(['printf', 'hello world', 'a b', '$HOME', ';']);
    expect(captures[0]?.options.cwd).toBe('/fixture/override');
    expect((captures[0]?.options.env as Record<string, unknown>).GV_FIXTURE_VALUE).toBe('value');
    expect(captures[0]?.stdin).toEqual(['fixture stdin']);
    expect(result).toEqual({ exitCode: 0, stdout: 'fixture output', stderr: 'fixture stderr' });
  });

  test('omitting the optional allowlist preserves unrestricted operator execution', async () => {
    await createLocalProcessBackend(context).dispatch(local(), 'fixture-tool');
    expect(captures[0]?.args).toEqual(['fixture-tool']);
    expect(captures[0]?.options.cwd).toBe('/fixture/default');
  });

  test.each([{ allowedCommands: [] }, { allowedCommands: ['printf'] }])('an explicit allowlist refuses unlisted commands: %j', async ({ allowedCommands }) => {
    await expect(createLocalProcessBackend(context).dispatch(local([...allowedCommands]), 'fixture-denied'))
      .rejects.toMatchObject({ code: 'REMOTE_BACKEND_COMMAND_DENIED' });
    expect(captures).toHaveLength(0);
  });

  test.each([' ', '""'])('refuses an empty executable: %s', async (command) => {
    await expect(createLocalProcessBackend(context).dispatch(local(), command))
      .rejects.toMatchObject({ code: 'REMOTE_BACKEND_BAD_COMMAND' });
    expect(captures).toHaveLength(0);
  });

  test('refuses the wrong backend kind before spawning', async () => {
    await expect(createLocalProcessBackend(context).dispatch(docker(), 'uptime'))
      .rejects.toMatchObject({ code: 'REMOTE_BACKEND_KIND_MISMATCH' });
    expect(captures).toHaveLength(0);
  });
});

describe('Docker backend', () => {
  test('passes remote shell args verbatim and enables stdin only when supplied', async () => {
    const result = await createDockerBackend(context).dispatch(docker(), 'echo', { args: ['a b', '$HOME'], stdin: 'fixture stdin' });
    expect(captures[0]?.args).toEqual(['docker', 'exec', '-i', 'web', 'sh', '-c', 'echo a b $HOME']);
    expect(captures[0]?.stdin).toEqual(['fixture stdin']);
    expect(result.exitCode).toBe(0);
  });

  test('resolves the host reference into env only, never argv', async () => {
    await createDockerBackend(context).dispatch(docker('goodvibes://secrets/goodvibes/HOST'), 'uptime');
    expect(resolutions).toEqual(['goodvibes://secrets/goodvibes/HOST']);
    expect((captures[0]?.options.env as Record<string, unknown>).DOCKER_HOST).toBe('fixture-resolved-host');
    expect(captures[0]?.args).toEqual(['docker', 'exec', 'web', 'sh', '-c', 'uptime']);
    expect(captures[0]?.args.join(' ')).not.toContain('fixture-resolved-host');
    expect(captures[0]?.args.join(' ')).not.toContain('goodvibes://');
  });

  test('passes a plain socket address without resolving credentials', async () => {
    await createDockerBackend(context).dispatch(docker('unix:///fixture/docker.sock'), 'uptime');
    expect(resolutions).toEqual([]);
    expect((captures[0]?.options.env as Record<string, unknown>).DOCKER_HOST).toBe('unix:///fixture/docker.sock');
  });

  test('an unresolved host refuses before spawning', async () => {
    const backend = createDockerBackend({ ...context, credentials: { resolveRef: async () => null } });
    await expect(backend.dispatch(docker('goodvibes://secrets/goodvibes/HOST'), 'uptime'))
      .rejects.toMatchObject({ code: 'REMOTE_BACKEND_CREDENTIAL_MISSING' });
    expect(captures).toHaveLength(0);
  });

  test('refuses a wrong-kind peer or blank command before spawning', async () => {
    const backend = createDockerBackend(context);
    await expect(backend.dispatch(local(), 'uptime')).rejects.toMatchObject({ code: 'REMOTE_BACKEND_KIND_MISMATCH' });
    await expect(backend.dispatch(docker(), ' ')).rejects.toMatchObject({ code: 'REMOTE_BACKEND_BAD_COMMAND' });
    expect(captures).toHaveLength(0);
  });
});
