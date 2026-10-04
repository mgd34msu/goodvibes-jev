/**
 * workspace/registration/store.ts
 *
 * The daemon-side registered-workspace store (user-scoped state, injectable
 * I/O) plus the impure worktree-link probe the resolver's git metadata comes
 * from.
 *
 * PERSISTENCE follows the sibling control-plane stores (PrincipalStore,
 * ChannelProfileStore …): a versioned JSON document over the shared
 * PersistentStore, which supports a `:memory:` path for deterministic tests,
 * that is the injectable-I/O seam. The persisted `workspaces` array is
 * field-identical to the agent registry so its file migrates in.
 *
 * ROOT-GUARD. `add` refuses an absurdly broad root ($HOME, the filesystem root,
 * or the daemon state dir) via the SAME broadRootReason the checkpoint manager
 * already uses, a registration store must never let automatic coverage sweep a
 * whole home directory.
 *
 * CONCURRENCY. Every mutation here is a READ-MODIFY-WRITE: `read()` loads the
 * whole document, the method edits one array, and `persist()` replaces the
 * file. `PersistentStore.persist` is one atomic replacement, so nobody sees a
 * torn file, but it does not close the window between the read and the write,
 * which is exactly what its own header says belongs to the caller that owns the
 * read. Two registrations interleaved there lose one of the two roots outright:
 * both read the same array, both append their own record, and the second write
 * replaces the first. The lost root then has no coverage and nothing says so.
 *
 * And this store, alone among the daemon's stores, is contended ACROSS
 * PROCESSES: `goodvibes register` in a project directory writes the same
 * user-scoped file the running daemon writes, so an in-process queue on its own
 * would order this process's writes and still lose the other's. Every
 * read-modify-write therefore runs under BOTH, the in-process chain and the
 * advisory lock at `<file>.lock`, which is the shape `push/subscription-store.ts`
 * already uses for the same reason.
 */

import { PersistentStore } from '../../state/persistent-store.js';
import { confirmFileDurable } from '../../utils/atomic-json-store.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquireCrossProcessLock } from '../checkpoint/cross-process-lock.js';
import { broadRootReason } from '../checkpoint/root-guard.js';
import { normalizeWorkspaceRoot, resolveWorkspaceRegistration } from './resolution.js';
import {
  WorkspaceRegistrationError,
  NativeWorkspaceScopeError,
  type NativeWorkspaceScope,
  type DeclinedWorkspaceRecord,
  type RegisteredWorkspaceRecord,
  type ResolveWorkspaceInput,
  type WorkspaceGitMetadata,
  type WorkspaceRegistrySnapshot,
  type WorkspaceResolution,
} from './types.js';
import { probeWorktreeLink } from './worktree-link.js';

interface ScopeTombstone {
  readonly root: string;
  readonly scopeId?: string;
  readonly generation: number;
}

interface PersistedRegistry extends Record<string, unknown> {
  version: 1 | 2;
  workspaces: RegisteredWorkspaceRecord[];
  declines: DeclinedWorkspaceRecord[];
  registryId?: string;
  scopeGeneration?: number;
  scopeTombstones?: ScopeTombstone[];
}

function validate(snapshot: PersistedRegistry | null): PersistedRegistry {
  if (!snapshot) return { version: 1, workspaces: [], declines: [] };
  if ((snapshot.version !== 1 && snapshot.version !== 2) || !Array.isArray(snapshot.workspaces)) {
    throw new Error('Workspace registration store snapshot is invalid.');
  }
  if (snapshot.version === 2) {
    const generation = snapshot.scopeGeneration;
    const validGeneration = (value: unknown): value is number => typeof value === 'number'
      && Number.isSafeInteger(value) && value > 0 && value <= (generation ?? 0);
    const validRoot = (value: unknown): value is string => typeof value === 'string' && value.length > 0
      && normalizeWorkspaceRoot(value) === value;
    const validId = (value: unknown, prefix: string): value is string => typeof value === 'string'
      && new RegExp(`^${prefix}:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`).test(value);
    if (!validId(snapshot.registryId, 'workspace-registry') || !validGeneration(generation)
      || !Array.isArray(snapshot.scopeTombstones) || !Array.isArray(snapshot.declines)) {
      throw new Error('Workspace native scope metadata is invalid.');
    }
    const roots = new Set<string>();
    const ids = new Set<string>();
    for (const row of snapshot.workspaces) {
      if (!row || !validRoot(row.root) || typeof row.registeredAt !== 'string' || roots.has(row.root)) {
        throw new Error('Workspace native registration is invalid.');
      }
      roots.add(row.root);
      if (row.nativeScope !== undefined) {
        const scope = row.nativeScope;
        if (!scope || !validId(scope.id, 'workspace') || !validRoot(scope.canonicalRoot)
          || !validGeneration(scope.generation) || ids.has(scope.id)) {
          throw new Error('Workspace native incarnation is invalid.');
        }
        ids.add(scope.id);
      }
    }
    for (const tombstone of snapshot.scopeTombstones) {
      if (!tombstone || !validRoot(tombstone.root) || !validGeneration(tombstone.generation)
        || (tombstone.scopeId !== undefined && (!validId(tombstone.scopeId, 'workspace') || ids.has(tombstone.scopeId)))) {
        throw new Error('Workspace native tombstone is invalid.');
      }
      if (tombstone.scopeId) ids.add(tombstone.scopeId);
    }
    if (snapshot.declines.some((row) => !row || !validRoot(row.root) || typeof row.declinedAt !== 'string')) {
      throw new Error('Workspace native decline is invalid.');
    }
    return snapshot;
  }
  return {
    version: 1,
    // v1 never attested a native incarnation, even if a copied row contains
    // similarly named fields. Do not promote such fields on the next write.
    workspaces: snapshot.workspaces.map((row) => {
      const { nativeScope: _unattested, ...registration } = row;
      return registration;
    }),
    declines: Array.isArray(snapshot.declines) ? snapshot.declines : [],
  };
}

function canonicalDirectory(root: string): string | null {
  try {
    const canonical = normalizeWorkspaceRoot(realpathSync(root));
    return statSync(canonical).isDirectory() ? canonical : null;
  } catch { return null; }
}

/**
 * Synchronous legacy boot writers cannot wait on an async lock. They use the
 * SAME strict ownership protocol and fail immediately on contention, before
 * reading. The fully-written owner is published atomically; no age takeover.
 */
export function withWorkspaceRegistrationWriteLockSync<T>(path: string, write: () => T): T {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${lockPath}.owner-${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, token: randomBytes(8).toString('hex'), acquiredAt: Date.now() }), { mode: 0o600, flag: 'wx' });
  const identity = statSync(temporary);
  try {
    linkSync(temporary, lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw Object.assign(new Error('Workspace registry writer lock is already owned.'), { code: 'WORKSPACE_REGISTRY_BUSY' });
  } finally { unlinkSync(temporary); }
  try { return write(); } finally {
    const current = statSync(lockPath);
    if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(lockPath);
  }
}

/** Fresh prospective generation. Legacy rows remain without nativeScope. */
function advance(state: PersistedRegistry): PersistedRegistry {
  const generation = state.version === 2 ? state.scopeGeneration! + 1 : 1;
  if (!Number.isSafeInteger(generation)) throw new Error('Workspace scope generation exhausted.');
  return {
    ...state, version: 2, registryId: state.version === 2 ? state.registryId! : `workspace-registry:${randomUUID()}`,
    scopeGeneration: generation, scopeTombstones: state.version === 2 ? state.scopeTombstones! : [],
  };
}

export interface WorkspaceRegistrationStoreOptions {
  /** Persistence path (or `:memory:` for tests). */
  readonly path: string;
  /** The user's home directory, refused as a broad root. */
  readonly homeDir: string;
  /** The daemon state directory (~/.goodvibes), refused as a broad root. */
  readonly daemonStateDir: string;
  /**
   * A second path to READ from when `path` does not exist yet, the pre-split
   * location, during the one auto-update cycle before the daemon's boot fold
   * moves the register into the shared tier. Never written to: a
   * read-modify-write that started from the fallback still persists to `path`.
   * See registration/shared-register-path.ts.
   */
  readonly fallbackReadPath?: string | undefined;
  /** Injectable worktree-link probe; defaults to a real `git rev-parse` probe. */
  readonly probe?: (path: string) => WorkspaceGitMetadata;
}

export interface RegisterWorkspaceResult {
  readonly record: RegisteredWorkspaceRecord;
  readonly alreadyRegistered: boolean;
}

export class WorkspaceRegistrationStore {
  private readonly store: PersistentStore<PersistedRegistry>;
  private readonly path: string;
  private memoryState: PersistedRegistry | null = null;
  /** A failed/pending authority commit cannot be promoted by a later read in this owner. */
  private nativeDurabilityUncertain = false;
  /** Read-only source for the pre-split location; see fallbackReadPath. */
  private readonly fallbackStore: PersistentStore<PersistedRegistry> | null;
  private readonly homeDir: string;
  private readonly daemonStateDir: string;
  private readonly probe: (path: string) => WorkspaceGitMetadata;
  /** Orders read-modify-writes within this process. See the header. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: WorkspaceRegistrationStoreOptions) {
    this.path = options.path;
    this.store = new PersistentStore<PersistedRegistry>(options.path);
    this.fallbackStore = options.fallbackReadPath
      ? new PersistentStore<PersistedRegistry>(options.fallbackReadPath)
      : null;
    this.homeDir = options.homeDir;
    this.daemonStateDir = options.daemonStateDir;
    this.probe = options.probe ?? probeWorktreeLink;
  }

  /**
   * Run `fn` as the only read-modify-write against this file, in this process
   * AND across processes.
   *
   * The chain orders callers here; the advisory lock keeps the CLI's
   * registration from being clobbered by the daemon's, and vice versa. A
   * `:memory:` store has no file to contend on and takes the chain only.
   *
   * The chain tracks COMPLETION, never OUTCOME: `next.catch` keeps it alive
   * after a rejection, so one failed registration cannot wedge the store for
   * the life of the process, and the rejection still reaches the caller that
   * owns it and nobody else. `then(guarded, guarded)` rather than `then(guarded)`
   * for the same reason, a settled predecessor must run the next one either way.
   */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const guarded = async (): Promise<T> => {
      const lockPath = this.store.lockPath;
      if (!lockPath) return fn();
      const release = await acquireCrossProcessLock(lockPath, { totalTimeoutMs: 10_000, strictOwnership: true });
      try {
        return await fn();
      } finally {
        release();
      }
    };
    const next = this.queue.then(guarded, guarded);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<PersistedRegistry> {
    const primary = await this.store.load();
    // A register that has not been folded into the shared tier yet still has to
    // be visible, or an updated product would report the operator's registered
    // workspaces as gone until the daemon next booted.
    if (primary === null && this.fallbackStore !== null) {
      return validate(await this.fallbackStore.load());
    }
    return validate(primary);
  }

  private async readForMutation(): Promise<PersistedRegistry> {
    const primary = await this.store.load();
    if (primary === null && this.fallbackStore !== null) {
      const fallback = validate(await this.fallbackStore.load());
      // A vanished authority file must not be reconstituted from a stale copy.
      // Legacy v1 coverage remains importable, without native incarnations.
      if (fallback.version === 2) throw new Error('Workspace mutation refuses a native-authority fallback registry.');
      return fallback;
    }
    return validate(primary);
  }

  private async persist(state: PersistedRegistry): Promise<void> {
    validate(state);
    const durable = state.version === 2;
    // Fence before any await. Even after rename throws, the new incarnation or
    // tombstone may be visible. Never roll it back or call that visibility a
    // successful commit. Only a subsequent explicit durable mutation recovers
    // this owner; an idempotent/no-write operation does not clear the fence.
    if (durable) this.nativeDurabilityUncertain = true;
    await this.store.persist(state, { durable });
    if (this.path === ':memory:') this.memoryState = structuredClone(state);
    if (durable) this.nativeDurabilityUncertain = false;
  }

  /**
   * Strict authoritative read, deliberately without legacy fallback, corruption
   * recovery, or authority migration. No cached scope survives a removed file.
   * Worktree-link facts are not accepted as authority by this first native slice.
   */
  currentScope(root: string): NativeWorkspaceScope {
    if (this.nativeDurabilityUncertain) throw new NativeWorkspaceScopeError('unavailable');
    let state: PersistedRegistry;
    let bytes: string | undefined;
    try {
      bytes = this.path === ':memory:' ? undefined : readFileSync(this.path, 'utf-8');
      const raw = bytes === undefined ? this.memoryState : JSON.parse(bytes) as PersistedRegistry;
      if (raw === null) throw new NativeWorkspaceScopeError('unavailable');
      state = validate(raw);
    } catch { throw new NativeWorkspaceScopeError('unavailable'); }
    if (state.version !== 2) throw new NativeWorkspaceScopeError('unmigrated');
    const canonical = canonicalDirectory(root);
    if (!canonical) throw new NativeWorkspaceScopeError('unavailable');
    const registrations = state.workspaces.map((row) => ({
      ...row, root: canonicalDirectory(row.root) ?? row.root,
    }));
    const resolution = resolveWorkspaceRegistration({
      path: canonical, registrations,
      declines: state.declines.map((row) => ({ ...row, root: canonicalDirectory(row.root) ?? row.root })),
    });
    if (resolution.status !== 'covered') throw new NativeWorkspaceScopeError('unavailable');
    const matching = registrations.filter((row) => row.root === resolution.coveredBy);
    if (matching.length !== 1) throw new NativeWorkspaceScopeError('unavailable');
    const registered = matching[0]!;
    const scope = registered.nativeScope;
    if (!scope) throw new NativeWorkspaceScopeError('unmigrated');
    if (scope.canonicalRoot !== registered.root || broadRootReason(registered.root, this.homeDir, this.daemonStateDir)) {
      throw new NativeWorkspaceScopeError('changed');
    }
    if (bytes !== undefined) {
      try {
        // A new owner cannot infer that visible post-rename bytes were durably
        // acknowledged before a crash. Establish their durability before native
        // admission, including full directory ancestry. Re-read so confirmation
        // of a concurrently replaced file cannot attest the earlier snapshot.
        confirmFileDurable(this.path);
        if (readFileSync(this.path, 'utf-8') !== bytes) throw new Error('Workspace scope changed during durability confirmation.');
      } catch {
        this.nativeDurabilityUncertain = true;
        throw new NativeWorkspaceScopeError('unavailable');
      }
    }
    return Object.freeze({ root: canonical, scopeId: scope.id,
      scopeRevision: `${state.registryId!}:${state.scopeGeneration!}:${scope.generation}` });
  }

  /** Own the writer lock while the host acquires inner ownership; launch uses the synchronous validator. */
  withCurrentScope<T>(expected: NativeWorkspaceScope, callback: (assertCurrent: () => void) => T | Promise<T>): Promise<T> {
    // Copy now, before queuing, so mutation of a caller's object cannot rebind it.
    const pinned = Object.freeze({ root: expected.root, scopeId: expected.scopeId, scopeRevision: expected.scopeRevision });
    return this.run(async () => {
      let live = true;
      const assertCurrent = (): void => {
        if (!live) throw new NativeWorkspaceScopeError('callback');
        const current = this.currentScope(pinned.root);
        if (current.root !== pinned.root || current.scopeId !== pinned.scopeId || current.scopeRevision !== pinned.scopeRevision) {
          throw new NativeWorkspaceScopeError('changed');
        }
      };
      try {
        assertCurrent();
        const result = await callback(assertCurrent);
        assertCurrent();
        return result;
      } finally { live = false; }
    });
  }

  async snapshot(): Promise<WorkspaceRegistrySnapshot> {
    const state = await this.read();
    return { workspaces: state.workspaces, declines: state.declines };
  }

  /**
   * Register a root, refusing an empty or absurdly broad one. Idempotent on
   * the normalized root, but provenance UPGRADES: re-adding an existing root
   * with `origin`/`checkpointEligible` stamps those fields (this is how the
   * checkpoint-owning consumer marks its roots on boot, including records
   * migrated before provenance existed). Absent options never strip an
   * existing stamp, one surface's plain self-recording cannot demote another
   * consumer's eligibility.
   */
  async add(
    root: string,
    opts?: { readonly label?: string; readonly origin?: string; readonly checkpointEligible?: boolean },
  ): Promise<RegisterWorkspaceResult> {
    // The root guard runs OUTSIDE the lock: it rejects on the argument alone,
    // and a refusal should not queue behind another process's write.
    const target = this.requireRegistrableRoot(root);
    return this.run(async () => {
      const state = await this.readForMutation();
      const existing = state.workspaces.find((w) => w.root === target);
      if (existing) {
        const origin = opts?.origin?.trim();
        const wantsUpgrade =
          (origin !== undefined && origin !== '' && existing.origin !== origin)
          || (opts?.checkpointEligible === true && existing.checkpointEligible !== true);
        if (!wantsUpgrade) return { record: existing, alreadyRegistered: true };
        const upgraded: RegisteredWorkspaceRecord = {
          ...existing,
          ...(origin ? { origin } : {}),
          ...(opts?.checkpointEligible === true ? { checkpointEligible: true } : {}),
        };
        await this.persist({
          ...advance(state),
          workspaces: state.workspaces.map((w) => (w.root === target ? upgraded : w)),
          declines: state.declines,
        });
        return { record: upgraded, alreadyRegistered: true };
      }

      const next = advance(state);
      const canonicalRoot = canonicalDirectory(target);
      const record: RegisteredWorkspaceRecord = {
        root: target,
        registeredAt: new Date().toISOString(),
        ...(opts?.label?.trim() ? { label: opts.label.trim() } : {}),
        ...(opts?.origin?.trim() ? { origin: opts.origin.trim() } : {}),
        ...(opts?.checkpointEligible === true ? { checkpointEligible: true } : {}),
        ...(canonicalRoot === null || broadRootReason(canonicalRoot, this.homeDir, this.daemonStateDir) ? {} : {
          nativeScope: { id: `workspace:${randomUUID()}`, canonicalRoot, generation: next.scopeGeneration! },
        }),
      };
      // Registering a root clears any remembered decline at exactly that root.
      const declines = state.declines.filter((d) => d.root !== target);
      await this.persist({ ...next, workspaces: [...state.workspaces, record], declines });
      return { record, alreadyRegistered: false };
    });
  }

  /** Remove a registered root. Returns whether anything was removed (honest boolean, never a phantom). */
  async remove(root: string): Promise<{ readonly root: string; readonly removed: boolean }> {
    const target = normalizeWorkspaceRoot(root);
    return this.run(async () => {
      const state = await this.readForMutation();
      const workspaces = state.workspaces.filter((w) => w.root !== target);
      const removed = workspaces.length !== state.workspaces.length;
      if (removed) {
        const next = advance(state);
        const old = state.workspaces.find((row) => row.root === target)!;
        await this.persist({ ...next, workspaces, scopeTombstones: [...next.scopeTombstones!, {
          root: target, ...(old.nativeScope ? { scopeId: old.nativeScope.id } : {}), generation: next.scopeGeneration!,
        }] });
      }
      return { root: target, removed };
    });
  }

  /** Remember a subtree-scoped decline at a root. Idempotent. Used by prompt consumers, not a wire verb. */
  async decline(root: string): Promise<{ readonly root: string; readonly alreadyDeclined: boolean }> {
    const target = normalizeWorkspaceRoot(root);
    return this.run(async () => {
      const state = await this.readForMutation();
      if (state.declines.some((d) => d.root === target)) return { root: target, alreadyDeclined: true };
      const record: DeclinedWorkspaceRecord = { root: target, declinedAt: new Date().toISOString() };
      await this.persist({ ...advance(state), declines: [...state.declines, record] });
      return { root: target, alreadyDeclined: false };
    });
  }

  /**
   * Resolve a path against the registry. When `git` is omitted, the store probes
   * the worktree→main-repo link itself so a linked sibling worktree inherits its
   * main repo's registration.
   */
  async resolve(path: string, git?: WorkspaceGitMetadata): Promise<WorkspaceResolution> {
    const state = await this.read();
    const gitMeta = git ?? this.probe(path);
    const input: ResolveWorkspaceInput = {
      path,
      git: gitMeta,
      registrations: state.workspaces,
      declines: state.declines,
    };
    return resolveWorkspaceRegistration(input);
  }

  private requireRegistrableRoot(root: string): string {
    if (typeof root !== 'string' || root.trim().length === 0) {
      throw new WorkspaceRegistrationError('root is required');
    }
    const target = normalizeWorkspaceRoot(root);
    const broad = broadRootReason(target, this.homeDir, this.daemonStateDir);
    if (broad) {
      throw new WorkspaceRegistrationError(
        `refusing to register "${target}" because it is ${broad}: coverage flows down a root's whole subtree, ` +
          `so registering a root this broad would sweep far more than a project. Register a specific project root.`,
      );
    }
    return target;
  }
}
