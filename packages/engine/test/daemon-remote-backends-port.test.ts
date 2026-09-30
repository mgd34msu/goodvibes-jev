import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, spyOn } from 'bun:test';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { runProcess } from '../sdk/src/platform/runtime/remote/host/backends/process-runner.ts';
import {
  tokenizeCommand,
  createLocalProcessBackend,
} from '../sdk/src/platform/runtime/remote/host/backends/local-process.ts';
import { createSshBackend } from '../sdk/src/platform/runtime/remote/host/backends/ssh.ts';
import { createCloudTerminalBackend } from '../sdk/src/platform/runtime/remote/host/backends/cloud-terminal.ts';
import {
  type BackendContext,
  BackendDispatchError,
  buildRemoteShellCommand,
} from '../sdk/src/platform/runtime/remote/host/backends/types.ts';
import type { RemoteHostCredentialStore as DaemonCredentialStore } from '../sdk/src/platform/runtime/remote/host/context.ts';
import type { RemoteHostLogger as HandlerLogger } from '../sdk/src/platform/runtime/remote/host/context.ts';
import type { PeerRecord } from '../sdk/src/platform/runtime/remote/host/peer-registry.ts';

const noopLogger: HandlerLogger = { info: () => {}, warn: () => {}, error: () => {} };
const stubCredentials: DaemonCredentialStore = {
  resolveRef: async () => null,
};
const ctx: BackendContext = { credentials: stubCredentials, logger: noopLogger, homeDirectory: '/tmp' };

function localPeer(allowedCommands?: string[]): PeerRecord {
  return {
    peerId: 'local',
    displayName: 'Local',
    backendKind: 'local-process',
    backendConfig: { kind: 'local-process', ...(allowedCommands ? { allowedCommands } : {}) },
  };
}

describe('tokenizeCommand', () => {
  it('splits plain words', () => {
    expect(tokenizeCommand('git status --short')).toEqual(['git', 'status', '--short']);
  });

  it('honors single and double quotes', () => {
    expect(tokenizeCommand('echo "hello world" \'a b\'')).toEqual(['echo', 'hello world', 'a b']);
  });

  it('honors backslash escapes outside single quotes', () => {
    expect(tokenizeCommand('echo a\\ b')).toEqual(['echo', 'a b']);
  });

  it('throws on an unterminated quote', () => {
    expect(() => tokenizeCommand('echo "open')).toThrow(BackendDispatchError);
  });
});

describe('runProcess', () => {
  it('captures stdout and a zero exit code', async () => {
    const result = await runProcess({ args: ['printf', 'hi'], timeoutMs: 5_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hi');
    expect(result.timedOut).toBe(false);
  });

  it('reports a non-zero exit code without throwing', async () => {
    const result = await runProcess({ args: ['sh', '-c', 'exit 3'], timeoutMs: 5_000 });
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('SIGKILLs and reaps a process that exceeds the timeout', async () => {
    const start = Date.now();
    const result = await runProcess({ args: ['sleep', '10'], timeoutMs: 200 });
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    // The await resolves on child.exited (post-SIGKILL), so it returns promptly
    // rather than waiting the full sleep, no orphaned child is left running.
    //
    // The threshold used to be 5_000 with no per-test budget, which is bun's
    // own default: the assertion could never fail, because the test died of the
    // timeout at exactly the moment `elapsed` reached the number it was being
    // compared against. A measurement that cannot fail its own assertion proves
    // nothing. The budget now sits above the threshold, so the assertion is
    // what fails, and the threshold is still two orders of magnitude below the
    // 10 s sleep this guards against waiting out.
    expect(elapsed).toBeLessThan(5_000);
  }, 30_000);

  it('pipes stdin to the child', async () => {
    const result = await runProcess({ args: ['cat'], stdin: 'piped-input', timeoutMs: 5_000 });
    expect(result.stdout).toBe('piped-input');
  });
});

describe('buildRemoteShellCommand', () => {
  it('returns the bare command when there are no args', () => {
    expect(buildRemoteShellCommand('uptime')).toBe('uptime');
    expect(buildRemoteShellCommand('uptime', [])).toBe('uptime');
  });

  it('joins positional args onto the command with single spaces (remote-shell semantics)', () => {
    expect(buildRemoteShellCommand('ls', ['-l', '/tmp'])).toBe('ls -l /tmp');
  });

  it('does NOT shell-escape args: the joined string is handed verbatim to the remote shell', () => {
    // An arg containing a space stays unquoted on purpose, the remote shell
    // re-splits it. Callers needing a literal arg must pre-quote it themselves.
    expect(buildRemoteShellCommand('echo', ['a b'])).toBe('echo a b');
  });
});

describe('backend teardown preserves unowned legacy scratch', () => {
  it('ssh teardown preserves legacy files without ownership proof', async () => {
    const home = makeProjectTempDir('ssh-teardown-home');
    const keyDir = join(home, '.goodvibes', 'tui', 'operator', 'ssh-keys');
    mkdirSync(keyDir, { recursive: true });
    // A leftover key file from a prior invocation (word-style fake, not a ref).
    writeFileSync(join(keyDir, 'peer.cafef00d.key'), 'word-style-fake-private-key-not-a-ref');
    expect(existsSync(keyDir)).toBe(true);

    const backend = createSshBackend({ credentials: stubCredentials, logger: noopLogger, homeDirectory: home });
    await backend.teardown?.();
    expect(readFileSync(join(keyDir, 'peer.cafef00d.key'), 'utf8')).toBe('word-style-fake-private-key-not-a-ref');
  });

  it('cloud-terminal teardown preserves legacy files without ownership proof', async () => {
    const home = makeProjectTempDir('cloud-teardown-home');
    const credDir = join(home, '.goodvibes', 'tui', 'operator', 'cloud-creds');
    mkdirSync(credDir, { recursive: true });
    writeFileSync(join(credDir, 'peer.deadbeef.cred'), 'wordfake-cloud-credential');
    expect(existsSync(credDir)).toBe(true);

    const backend = createCloudTerminalBackend({ credentials: stubCredentials, logger: noopLogger, homeDirectory: home });
    await backend.teardown?.();
    expect(readFileSync(join(credDir, 'peer.deadbeef.cred'), 'utf8')).toBe('wordfake-cloud-credential');
  });

  it('teardown is a safe no-op when nothing was written to disk', async () => {
    const home = makeProjectTempDir('noop-teardown-home');
    const backend = createSshBackend({ credentials: stubCredentials, logger: noopLogger, homeDirectory: home });
    await expect(backend.teardown?.()).resolves.toBeUndefined();
  });
});

// The port no longer guesses that every file in a shared root is stale.
// Crash cleanup requires the marker written by the shared owned-dir helper.
const DEAD_PID = 2147483646;
function deadOwner(root: string): string {
  const name = `owner-${DEAD_PID}-abcdefghijklmnop`;
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'owner.json'), JSON.stringify({ kind: 'goodvibes-remote-credential-owner', version: 1, pid: DEAD_PID, directory: name }));
  writeFileSync(join(path, 'fixture.key'), 'dummy stale credential');
  return path;
}
function deadProbe() {
  const original = process.kill;
  return spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === DEAD_PID && signal === 0) throw Object.assign(new Error('fixture dead owner'), { code: 'ESRCH' });
    return original(pid, signal);
  });
}
describe('backend construction sweeps only proven crashed owners', () => {
  it('ssh waits for owned stale cleanup before a credential refusal', async () => {
    const home = makeProjectTempDir('ssh-crash-sweep-home');
    const stale = deadOwner(join(home, '.goodvibes', 'tui', 'operator', 'ssh-keys'));
    const probe = deadProbe();
    const backend = createSshBackend({ credentials: stubCredentials, logger: noopLogger, homeDirectory: home });
    try {
      const peer: PeerRecord = { peerId: 'p1', displayName: 'P1', backendKind: 'ssh', backendConfig: { kind: 'ssh', sshHost: 'h', sshUser: 'u', identityRef: 'goodvibes://secrets/x' } };
      await expect(backend.dispatch(peer, 'true')).rejects.toMatchObject({ code: 'REMOTE_BACKEND_CREDENTIAL_MISSING' });
      expect(existsSync(stale)).toBe(false);
    } finally { await backend.teardown?.(); probe.mockRestore(); }
  });
  it('cloud stale cleanup finishes before a mocked provider command', async () => {
    const home = makeProjectTempDir('cloud-crash-sweep-home');
    const stale = deadOwner(join(home, '.goodvibes', 'tui', 'operator', 'cloud-creds'));
    const probe = deadProbe();
    const spawn = spyOn(Bun, 'spawn').mockImplementation((() => ({
      stdout: new Blob([]).stream(), stderr: new Blob([]).stream(), stdin: null, exited: Promise.resolve(0), kill() {},
    })) as unknown as typeof Bun.spawn);
    const backend = createCloudTerminalBackend({ credentials: { resolveRef: async () => 'dummy cloud credential' }, logger: noopLogger, homeDirectory: home });
    try {
      const peer: PeerRecord = { peerId: 'p2', displayName: 'P2', backendKind: 'cloud-terminal', backendConfig: { kind: 'cloud-terminal', provider: 'gcp', instance: 'cloudshell', credentialRef: 'goodvibes://secrets/y' } };
      await backend.dispatch(peer, 'true');
      expect(existsSync(stale)).toBe(false);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally { await backend.teardown?.(); spawn.mockRestore(); probe.mockRestore(); }
  });
});

describe('createLocalProcessBackend', () => {
  it('runs a permitted command and returns captured stdout', async () => {
    const backend = createLocalProcessBackend(ctx);
    const result = await backend.dispatch(localPeer(['printf']), 'printf done');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('done');
  });

  it('denies a command outside the allowlist', async () => {
    const backend = createLocalProcessBackend(ctx);
    await expect(backend.dispatch(localPeer(['printf']), 'rm -rf /'))
      .rejects.toMatchObject({ code: 'REMOTE_BACKEND_COMMAND_DENIED' });
  });

  it('rejects a peer of the wrong backend kind', async () => {
    const backend = createLocalProcessBackend(ctx);
    const wrong: PeerRecord = {
      peerId: 'x', displayName: 'X', backendKind: 'docker',
      backendConfig: { kind: 'docker', containerName: 'c' },
    };
    await expect(backend.dispatch(wrong, 'ls'))
      .rejects.toMatchObject({ code: 'REMOTE_BACKEND_KIND_MISMATCH' });
  });

  it('maps a timeout to exit code 124 with a timeout note on stderr', async () => {
    const backend = createLocalProcessBackend(ctx);
    const result = await backend.dispatch(localPeer(['sleep']), 'sleep 10', { timeoutMs: 200 });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out');
  });
});
