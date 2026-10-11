import { createHash, randomUUID } from 'node:crypto';
import type { AutomationJob, ManagedAutomationJob } from './jobs.js';
import type { MutationPublication } from '../utils/file-mutation.js';

const ownedJobs = new WeakSet<AutomationJob>();
function freezeRecord(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeRecord(child, seen);
  Object.freeze(value);
}

export function ownedAutomationJob(job: AutomationJob, revision: string = randomUUID()): ManagedAutomationJob {
  const owned = { ...structuredClone(job), mutationRevision: revision };
  freezeRecord(owned); ownedJobs.add(owned);
  return owned;
}

export function hasOwnedAutomationRevision(job: AutomationJob): boolean { return ownedJobs.has(job); }

export interface RetainedAutomationJobTarget {
  readonly job: ManagedAutomationJob;
  readonly assertCurrent: () => void;
}

export interface AutomationJobMutationOptions {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  readonly withPublication?: MutationPublication | undefined;
}

export class AutomationJobMutationStaleError extends Error {
  readonly code = 'AUTOMATION_JOB_STALE';
  readonly status = 409;
  constructor() { super('The selected automation job changed. Read its current revision before updating.'); }
}

export class AutomationJobCommitIndeterminateError extends Error {
  readonly code = 'AUTOMATION_COMMIT_INDETERMINATE';
  readonly status = 503;
  constructor(cause: unknown) {
    super('Automation job bytes were published, but commit confirmation failed. Read the job before retrying.', { cause });
  }
}

export function automationJobRevision(job: AutomationJob): string {
  return job.mutationRevision ?? `legacy:${createHash('sha256').update(JSON.stringify(job)).digest('hex')}`;
}

/** Internal writers share this map; each actual replacement advances only that job. */
export class AutomationJobMap extends Map<string, ManagedAutomationJob> {
  override set(id: string, job: AutomationJob): this {
    const previous = super.get(id);
    if (previous === job || previous && JSON.stringify(previous) === JSON.stringify(job)) return this;
    return super.set(id, ownedAutomationJob(job));
  }
  restore(job: AutomationJob): void {
    super.set(job.id, ownedAutomationJob(job, automationJobRevision(job)));
  }
  publish(job: ManagedAutomationJob): void { super.set(job.id, job); }
}

export function retainAutomationMutation(options: AutomationJobMutationOptions): () => void {
  const signal = options.signal, assertCurrent = options.assertCurrent, withPublication = options.withPublication;
  return () => {
    if (options.signal !== signal || options.assertCurrent !== assertCurrent || options.withPublication !== withPublication) throw new AutomationJobMutationStaleError();
    signal?.throwIfAborted();
    const result: unknown = assertCurrent?.();
    if (result !== undefined) {
      if (result instanceof Promise) void result.catch(() => undefined);
      throw new Error('Automation ownership checks must return undefined synchronously.');
    }
    signal?.throwIfAborted();
    if (options.signal !== signal || options.assertCurrent !== assertCurrent || options.withPublication !== withPublication) throw new AutomationJobMutationStaleError();
  };
}
