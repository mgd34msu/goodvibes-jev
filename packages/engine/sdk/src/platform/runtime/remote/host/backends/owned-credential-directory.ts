import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, rm, chmod } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { RemoteHostLogger } from '../context.js';
import { BackendDispatchError } from './types.js';

const MARKER = 'owner.json';
const OWNER_KIND = 'goodvibes-remote-credential-owner';
const OWNED_NAME = /^owner-(\d+)-[A-Za-z0-9_-]{16}$/;
export type CredentialOwnerStatus = 'alive' | 'dead' | 'unknown';

/** Only ESRCH is affirmative stale-owner evidence. Other failures preserve data. */
export function probeCredentialOwner(pid: number): CredentialOwnerStatus {
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'; }
}

function sameDirectory(stat: Stats, expected: Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === expected.dev && stat.ino === expected.ino;
}

/** Reject symlinked existing components before any traversal/write/removal. */
async function assertRealPath(path: string): Promise<void> {
  for (let current = resolve(path); ; current = dirname(current)) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Credential scratch path contains a symlink.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (dirname(current) === current) return;
  }
}

export interface OwnedCredentialDirectoryOptions {
  readonly rootDirectory: string;
  readonly logger: RemoteHostLogger;
  readonly probeOwner?: (pid: number) => CredentialOwnerStatus;
}

/** Private per-instance scratch; unmarked legacy files are never adopted/deleted. */
export class OwnedCredentialDirectory {
  private readonly root: string;
  private readonly ready: Promise<void>;
  private preparationFailed = false;
  private directoryPromise: Promise<string> | null = null;
  private owned: { path: string; stat: Stats; rootStat: Stats } | null = null;
  private readonly writes = new Set<Promise<string>>();
  private readonly files = new Set<string>();
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(private readonly options: OwnedCredentialDirectoryOptions) {
    this.root = resolve(options.rootDirectory);
    this.ready = this.sweep().catch(() => { this.preparationFailed = true; });
  }

  private assertOpen(): void {
    if (this.closed) throw new BackendDispatchError('Credential scratch is closed.', 'REMOTE_BACKEND_CLOSED');
  }

  private async sweep(): Promise<void> {
    await assertRealPath(this.root);
    let rootStat: Stats;
    try { rootStat = await lstat(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!rootStat.isDirectory()) throw new Error('Credential scratch root is not a directory.');
    let retained = 0;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      const match = entry.name.match(OWNED_NAME);
      if (!entry.isDirectory() || !match) { retained += 1; continue; }
      const path = join(this.root, entry.name);
      try {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) { retained += 1; continue; }
        const marker = join(path, MARKER);
        if (!(await lstat(marker)).isFile() || (await lstat(marker)).isSymbolicLink()) { retained += 1; continue; }
        const handle = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
        let owner: { kind?: unknown; version?: unknown; pid?: unknown; directory?: unknown };
        try {
          const file = await handle.stat();
          if (!file.isFile() || file.size > 1024) { retained += 1; continue; }
          owner = JSON.parse(await handle.readFile('utf8')) as typeof owner;
        } finally { await handle.close(); }
        if (!owner || owner.kind !== OWNER_KIND || owner.version !== 1 || owner.directory !== entry.name
          || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0 || String(owner.pid) !== match[1]) {
          retained += 1; continue;
        }
        if ((this.options.probeOwner ?? probeCredentialOwner)(Number(owner.pid)) !== 'dead') continue;
        await assertRealPath(path);
        if (!sameDirectory(await lstat(this.root), rootStat) || !sameDirectory(await lstat(path), stat)) continue;
        await rm(path, { recursive: true, force: true });
      } catch { retained += 1; }
    }
    if (retained > 0) this.options.logger.warn('remote credential scratch entries without stale ownership proof were retained', { entries: retained });
  }

  directory(): Promise<string> {
    this.assertOpen();
    this.directoryPromise ??= this.create();
    return this.directoryPromise;
  }

  async prepare(): Promise<void> {
    await this.ready;
    this.assertOpen();
    if (this.preparationFailed) throw new BackendDispatchError('Credential scratch could not be prepared.', 'REMOTE_BACKEND_CREDENTIAL_STORAGE_FAILED');
  }

  private async create(): Promise<string> {
    await this.prepare();
    await assertRealPath(this.root);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await assertRealPath(this.root);
    const rootStat = await lstat(this.root);
    if (!rootStat.isDirectory()) throw new Error('Credential scratch root is not a directory.');
    await chmod(this.root, 0o700);
    this.assertOpen();
    const name = `owner-${process.pid}-${randomBytes(12).toString('base64url')}`;
    const path = join(this.root, name);
    await mkdir(path, { mode: 0o700 });
    this.owned = { path, stat: await lstat(path), rootStat };
    const owner = { kind: OWNER_KIND, version: 1, pid: process.pid, directory: name };
    const handle = await open(join(path, MARKER), 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(owner)); } finally { await handle.close(); }
    this.assertOpen();
    return path;
  }

  write(contents: string, extension: 'key' | 'cred'): Promise<string> {
    const pending = Promise.resolve().then(async () => {
      this.assertOpen();
      if (extension !== 'key' && extension !== 'cred') throw new Error('Unknown credential scratch file kind.');
      const directory = await this.directory();
      this.assertOpen();
      await assertRealPath(directory);
      const path = join(directory, `${randomUUID()}.${extension}`);
      const handle = await open(path, 'wx', 0o600);
      this.files.add(path);
      try {
        await handle.writeFile(contents);
      } catch (error) {
        await handle.close();
        await rm(path, { force: true });
        this.files.delete(path);
        throw error;
      }
      await handle.close();
      return path;
    });
    this.writes.add(pending);
    void pending.then(() => { this.writes.delete(pending); }, () => { this.writes.delete(pending); });
    return pending;
  }

  /** Remove only a file this instance created, never an arbitrary caller path. */
  async remove(path: string): Promise<void> {
    if (!this.files.has(path)) throw new Error('Credential scratch file is not owned by this instance.');
    if (this.owned) {
      await assertRealPath(this.owned.path);
      try {
        if (!sameDirectory(await lstat(this.root), this.owned.rootStat)
          || !sameDirectory(await lstat(this.owned.path), this.owned.stat)) {
          throw new Error('Credential scratch directory identity changed.');
        }
        await rm(path, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    this.files.delete(path);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.resolve().then(async () => {
      await Promise.allSettled([this.ready, this.directoryPromise, ...this.writes]);
      if (!this.owned) return;
      await assertRealPath(this.owned.path);
      try {
        if (!sameDirectory(await lstat(this.root), this.owned.rootStat)
          || !sameDirectory(await lstat(this.owned.path), this.owned.stat)) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      await rm(this.owned.path, { recursive: true, force: true });
      this.owned = null;
    });
    return this.closing;
  }
}
