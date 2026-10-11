import { PersistentStore } from '../../state/persistent-store.js';
import { StoreWriteQueue } from '../../state/store-write-queue.js';
import type { MutationPublication } from '../../utils/file-mutation.js';
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { AutomationJob, ManagedAutomationJob } from '../jobs.js';
import { automationJobRevision, hasOwnedAutomationRevision, ownedAutomationJob, AutomationJobCommitIndeterminateError, AutomationJobMutationStaleError, retainAutomationMutation, type AutomationJobMutationOptions } from '../job-mutations.js';
import { resolveAutomationStorePath, type AutomationStorePathConfig } from './paths.js';

interface AutomationJobsSnapshot extends Record<string, unknown> {
  version: 1;
  jobs: AutomationJob[];
}

function defaultSnapshot(): AutomationJobsSnapshot {
  return {
    version: 1,
    jobs: [],
  };
}

function validateSnapshot(snapshot: AutomationJobsSnapshot | null): AutomationJobsSnapshot {
  if (!snapshot) return defaultSnapshot();
  if (snapshot.version !== 1 || !Array.isArray(snapshot.jobs)) {
    throw new Error('Automation jobs store snapshot is invalid.');
  }
  const ids = new Set<string>();
  for (const job of snapshot.jobs) {
    if (!job || typeof job.id !== 'string' || !job.id.trim() || ids.has(job.id)
        || job.mutationRevision !== undefined && (typeof job.mutationRevision !== 'string' || !job.mutationRevision.trim())) throw new Error('Automation jobs store contains an invalid or duplicate job identity.');
    ids.add(job.id);
  }
  return {
    version: 1,
    jobs: snapshot.jobs,
  };
}

export interface AutomationJobStoreConfig {
  readonly path?: string | undefined;
  readonly configManager?: AutomationStorePathConfig | undefined;
}

export class AutomationJobStore {
  private readonly store: PersistentStore<AutomationJobsSnapshot>;
  /** Whole-file writes run one at a time, in call order. See StoreWriteQueue. */
  private readonly writes = new StoreWriteQueue();
  private readonly path: string;
  private readonly anchor: string | null;
  private readonly anchorIdentity: string | null;
  private readonly parents = new Map<string, string | null>();
  private committed = new Map<string, AutomationJob>();
  private requested = new Map<string, AutomationJob>();
  private requestedInitialized = false;
  private readonly failed = new Set<string>();
  private initialized = false;
  private identity: string | null = null;

  constructor(config: string | AutomationJobStoreConfig = {}) {
    const path = typeof config === 'string'
      ? config
      : config.path ?? resolveAutomationStorePath('automation-jobs.json', config.configManager ?? {});
    this.store = new PersistentStore<AutomationJobsSnapshot>(path);
    this.path = path;
    let anchor = dirname(resolve(path));
    while (!existsSync(anchor) && dirname(anchor) !== anchor) anchor = dirname(anchor);
    this.anchor = path === ':memory:' ? null : anchor;
    this.anchorIdentity = this.directoryIdentity();
    if (this.anchor) {
      let parent = this.anchor;
      for (const part of relative(this.anchor, dirname(resolve(path))).split(sep).filter(Boolean)) {
        parent = join(parent, part); this.parents.set(parent, null);
      }
    }
  }

  async load(): Promise<AutomationJobsSnapshot> {
    const before = this.fileIdentity();
    if (this.initialized && before !== this.identity) throw new AutomationJobMutationStaleError();
    const snapshot = validateSnapshot(await this.store.load());
    if (this.fileIdentity() !== before) throw new AutomationJobMutationStaleError();
    if (!this.initialized) {
      this.committed = new Map(snapshot.jobs.map(job => [job.id, structuredClone(job)]));
      if (!this.requestedInitialized) this.requested = new Map(this.committed);
      this.identity = before;
      this.initialized = true;
    }
    return snapshot;
  }

  /** Merge this snapshot's job changes in call order, preserving unrelated conditional commits. */
  async save(jobs: readonly AutomationJob[]): Promise<void> {
    // Capture the changes requested by this call. A later whole-map snapshot
    // must not restore a different job that a conditional commit just updated.
    const previous = this.requested;
    const next = new Map(jobs.map(job => {
      const prior = previous.get(job.id);
      const { mutationRevision: ignored, ...fields } = job;
      const { mutationRevision: priorIgnored, ...priorFields } = prior ?? {};
      const unchanged = prior && !hasOwnedAutomationRevision(job) && JSON.stringify(fields) === JSON.stringify(priorFields);
      return [job.id, structuredClone(unchanged ? prior : hasOwnedAutomationRevision(job) ? job : ownedAutomationJob(job))] satisfies [string, AutomationJob];
    }));
    this.requested = next;
    this.requestedInitialized = true;
    const changes = new Map<string, AutomationJob | null>();
    for (const [id, job] of next) {
      if (JSON.stringify(previous.get(id)) !== JSON.stringify(job)) changes.set(id, job);
    }
    for (const id of previous.keys()) if (!next.has(id)) changes.set(id, null);
    await this.writes.run(async () => {
      if (!this.initialized) await this.load();
      for (const id of this.failed) changes.set(id, next.get(id) ?? null);
      if (!changes.size) return;
      const merged = new Map(this.committed);
      for (const [id, job] of changes) {
        if (job) merged.set(id, job);
        else merged.delete(id);
      }
      try {
        await this.persist(merged, () => undefined);
        for (const id of changes.keys()) this.failed.delete(id);
      } catch (error) {
        for (const id of changes.keys()) this.failed.add(id);
        throw error;
      }
    });
  }

  async commit(
    jobId: string,
    expectedMutationRevision: string | null,
    next: ManagedAutomationJob | null,
    options: AutomationJobMutationOptions = {},
  ): Promise<void> {
    const current = retainAutomationMutation(options);
    if (next && next.id !== jobId) throw new AutomationJobMutationStaleError();
    const staged = next ? ownedAutomationJob(next, hasOwnedAutomationRevision(next) ? next.mutationRevision : undefined) : null;
    current();
    await this.writes.run(async () => {
      current();
      if (!this.initialized) await this.load();
      const selected = this.committed.get(jobId);
      if ((selected ? automationJobRevision(selected) : null) !== expectedMutationRevision) throw new AutomationJobMutationStaleError();
      const merged = new Map(this.committed);
      if (staged) merged.set(jobId, staged);
      else merged.delete(jobId);
      await this.persist(merged, current, options.withPublication);
      this.failed.delete(jobId);
      // Update only this baseline entry. Unrelated calls already queued their
      // own deltas and retain their independent records.
      if (JSON.stringify(this.requested.get(jobId)) === JSON.stringify(selected)) {
        if (staged) this.requested.set(jobId, staged);
        else this.requested.delete(jobId);
      }
    });
  }

  assertCurrent(): void {
    if (this.initialized && this.fileIdentity() !== this.identity) throw new AutomationJobMutationStaleError();
  }

  private fileIdentity(): string | null {
    if (this.path === ':memory:') return null;
    if (this.directoryIdentity() !== this.anchorIdentity) throw new AutomationJobMutationStaleError();
    for (const [parent, identity] of this.parents) if (this.parentIdentity(parent) !== identity) throw new AutomationJobMutationStaleError();
    try {
      const stat = lstatSync(this.path, { bigint: true });
      if (!stat.isFile()) throw new AutomationJobMutationStaleError();
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  private directoryIdentity(): string | null {
    if (!this.anchor) return null;
    const stat = statSync(this.anchor, { bigint: true });
    if (!stat.isDirectory()) throw new AutomationJobMutationStaleError();
    return `${realpathSync(this.anchor)}:${stat.dev}:${stat.ino}`;
  }

  private parentIdentity(parent: string): string | null {
    try {
      const stat = lstatSync(parent, { bigint: true });
      if (!stat.isDirectory()) throw new AutomationJobMutationStaleError();
      return `${realpathSync(parent)}:${stat.dev}:${stat.ino}`;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  private async persist(jobs: Map<string, AutomationJob>, assertCurrent: () => void, withPublication?: MutationPublication): Promise<void> {
    let published = false;
    const current = () => {
      assertCurrent();
      if (this.fileIdentity() !== this.identity) throw new AutomationJobMutationStaleError();
    };
    try {
      current();
      // Create only the descendants whose absence this owner retained. A
      // request cannot substitute a new directory or link before mkdir.
      for (const [parent, identity] of this.parents) {
        if (identity !== null) continue;
        current(); mkdirSync(parent, { mode: 0o700 });
        this.parents.set(parent, this.parentIdentity(parent)); current();
      }
      await this.store.persist({ version: 1, jobs: [...jobs.values()] }, {
        durable: true,
        synchronousPublish: true,
        withPublication,
        assertCurrent: current,
        afterPublish: () => {
          published = true;
          this.identity = this.fileIdentity();
          this.committed = jobs;
        },
      });
      current();
      this.committed = jobs;
    } catch (error) {
      if (published) throw new AutomationJobCommitIndeterminateError(error);
      throw error;
    }
  }
}
