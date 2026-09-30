import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { SshBackendConfig } from '../peer-registry.js';
import { type Backend, type BackendContext, BackendDispatchError, resolveTimeout, buildRemoteShellCommand } from './types.js';
import { runProcess } from './process-runner.js';
import { tokenizeCommand } from './local-process.js';
import { BackendLifetime } from './backend-lifetime.js';
import { OwnedCredentialDirectory } from './owned-credential-directory.js';
import { redactOwnedCredential } from './credential-output.js';

interface Identity {
  keyPath: string;
  controlPath: string | null;
  target: string;
  credential: string;
}
interface Slot {
  binding: string;
  identity: Promise<Identity>;
  users: number;
  retired: boolean;
  cleanup?: Promise<void>;
}

/** SSH keys and multiplexed connections belong to one backend lifetime. */
export function createSshBackend(ctx: BackendContext): Backend {
  const lifetime = new BackendLifetime();
  const scratch = new OwnedCredentialDirectory({
    rootDirectory: join(ctx.homeDirectory, '.goodvibes', 'tui', 'operator', 'ssh-keys'), logger: ctx.logger,
  });
  const pool = new Map<string, Slot>();
  const slots = new Set<Slot>();
  let cleanupFailed = false;

  async function createIdentity(peerId: string, config: SshBackendConfig): Promise<Identity> {
    await scratch.prepare();
    let key: string | null;
    try { key = await lifetime.waitFor(() => ctx.credentials.resolveRef(config.identityRef)); }
    catch {
      lifetime.assertOpen();
      throw new BackendDispatchError(`Could not read SSH identity for peer '${peerId}'.`, 'REMOTE_BACKEND_CREDENTIAL_FAILED');
    }
    if (typeof key !== 'string' || key.length === 0) {
      throw new BackendDispatchError(`Could not resolve SSH identity for peer '${peerId}'.`, 'REMOTE_BACKEND_CREDENTIAL_MISSING');
    }
    const keyPath = await scratch.write(key.endsWith('\n') ? key : `${key}\n`, 'key');
    const proposedControlPath = join(dirname(keyPath), `m${randomBytes(4).toString('hex')}`);
    // An explicit conservative Unix-socket path budget. Long configured homes
    // still execute correctly, with connection sharing disabled and disclosed.
    const controlPath = Buffer.byteLength(proposedControlPath) <= 100 ? proposedControlPath : null;
    if (!controlPath) ctx.logger.warn('SSH connection sharing disabled because the owned socket path is too long');
    return { keyPath, controlPath, target: `${config.sshUser}@${config.sshHost}`, credential: key };
  }

  async function cleanIdentity(identity: Identity): Promise<void> {
    let failed = false;
    try {
      if (identity.controlPath) {
        let socket = false;
        try { socket = (await lstat(identity.controlPath)).isSocket(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (socket) {
          // -O exit controls the existing local multiplexing master. -F none
          // prevents cleanup from consulting unrelated user/system SSH config.
          const result = await runProcess({
            args: ['ssh', '-F', 'none', '-S', identity.controlPath, '-O', 'exit', '--', identity.target],
            timeoutMs: 1000,
          });
          failed = result.timedOut || result.exitCode !== 0;
        }
      }
    } catch { failed = true; }
    try { await scratch.remove(identity.keyPath); }
    finally { identity.credential = ''; }
    if (failed) throw new BackendDispatchError('SSH connection cleanup did not complete.', 'REMOTE_BACKEND_CLEANUP_FAILED');
  }

  function retire(slot: Slot): void {
    slot.retired = true;
    if (slot.users !== 0 || slot.cleanup) return;
    // A failed identity lookup created no identity to clean. A real cleanup
    // failure is recorded and surfaced by teardown, without logging its data.
    slot.cleanup = slot.identity.then(cleanIdentity, () => {}).catch(() => {
      cleanupFailed = true;
      try { ctx.logger.warn('SSH identity cleanup did not complete'); } catch {}
    }).finally(() => { slots.delete(slot); });
  }

  async function acquire(peerId: string, config: SshBackendConfig): Promise<{ identity: Identity; release(): void }> {
    const binding = JSON.stringify([config.identityRef, config.sshHost, config.sshUser, config.sshPort ?? 22]);
    let slot = pool.get(peerId);
    if (!slot || slot.binding !== binding) {
      const previous = slot;
      slot = { binding, identity: createIdentity(peerId, config), users: 0, retired: false };
      pool.set(peerId, slot);
      slots.add(slot);
      if (previous) retire(previous);
    }
    // Reserve the lease before awaiting key creation, so a destination change
    // cannot remove a key that an earlier concurrent dispatch still needs.
    slot.users += 1;
    const leased = slot;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      leased.users -= 1;
      if (leased.retired) retire(leased);
    };
    try { return { identity: await slot.identity, release }; }
    catch (error) {
      release();
      if (pool.get(peerId) === slot) pool.delete(peerId);
      retire(slot);
      throw error;
    }
  }

  return {
    kind: 'ssh',
    dispatch(peer, command, payload) {
      return lifetime.run(async (signal) => {
        if (peer.backendConfig.kind !== 'ssh') {
          throw new BackendDispatchError(`Peer '${peer.peerId}' is not an ssh peer.`, 'REMOTE_BACKEND_KIND_MISMATCH');
        }
        if (tokenizeCommand(command).length === 0) {
          throw new BackendDispatchError('Empty command.', 'REMOTE_BACKEND_BAD_COMMAND');
        }
        const config = { ...peer.backendConfig };
        const lease = await acquire(peer.peerId, config);
        try {
          lifetime.assertOpen();
          const identity = lease.identity;
          const args = ['ssh', '-i', identity.keyPath, '-p', String(config.sshPort ?? 22),
            '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
          if (identity.controlPath) args.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${identity.controlPath}`, '-o', 'ControlPersist=60');
          else args.push('-o', 'ControlMaster=no', '-o', 'ControlPath=none');
          args.push('--', identity.target, buildRemoteShellCommand(command, payload?.args));
          ctx.logger.info('remote ssh dispatch', { peerId: peer.peerId, host: config.sshHost, port: config.sshPort ?? 22 });
          let result;
          try {
            result = await runProcess({
              args, timeoutMs: resolveTimeout(payload), signal,
              ...(payload?.env !== undefined ? { env: payload.env } : {}),
              ...(payload?.stdin !== undefined ? { stdin: payload.stdin } : {}),
            });
          } catch {
            lifetime.assertOpen();
            throw new BackendDispatchError(`Could not execute SSH for peer '${peer.peerId}'.`);
          }
          const stderr = redactOwnedCredential(result.stderr, identity.credential);
          return { exitCode: result.timedOut ? 124 : result.exitCode,
            stdout: redactOwnedCredential(result.stdout, identity.credential),
            stderr: result.timedOut ? `${stderr}\n[remote] ssh command timed out` : stderr };
        } finally { lease.release(); }
      });
    },
    teardown: () => lifetime.close(async () => {
      pool.clear();
      for (const slot of slots) retire(slot);
      await Promise.all([...slots].map((slot) => slot.cleanup));
      await scratch.close();
      if (cleanupFailed) throw new BackendDispatchError('SSH identity cleanup did not complete.', 'REMOTE_BACKEND_CLEANUP_FAILED');
    }),
  };
}
