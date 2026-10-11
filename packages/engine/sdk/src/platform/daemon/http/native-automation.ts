import type { AutomationManager } from '../../automation/manager.js';
import type { ManagedAutomationJob } from '../../automation/jobs.js';
import type { AutomationScheduleDefinition } from '../../automation/schedules.js';
import { AutomationJobCommitIndeterminateError, AutomationJobMutationStaleError } from '../../automation/job-mutations.js';
import type { GatewayMethodCatalog } from '../../control-plane/method-catalog.js';
import { HandlerError, registerCatalogHandler } from '../../control-plane/host-handlers.js';
import { requestsNativeAdmission, retainNativeMutationRequest, runNativeMutation, type NativeMutationHost } from '../../control-plane/native-mutation.js';
import { isRecord } from '../../utils/record-coerce.js';
import { normalizeAtSchedule, normalizeCronSchedule, normalizeEverySchedule } from '../../automation/schedules.js';
import { parseCreateAutomationJobInput, parseUpdateAutomationJobInput } from './runtime-routes.js';

function nativeClockMeaning(value: number | undefined): string | { readonly iso: string; readonly fractionalMillisecond: number } | undefined {
  if (value === undefined) return undefined;
  const iso = new Date(value).toISOString(), whole = Date.parse(iso);
  return whole === value ? iso : { iso, fractionalMillisecond: value - whole };
}

function nativeScheduleMeaning(schedule: AutomationScheduleDefinition) {
  return schedule.kind === 'at' ? { ...schedule, at: nativeClockMeaning(schedule.at) }
    : schedule.kind === 'every' ? { ...schedule, anchorAt: nativeClockMeaning(schedule.anchorAt) }
    : schedule;
}

function nativeJobMeaning(job: ManagedAutomationJob) {
  const { id, mutationRevision, lastRunId, ...meaning } = job;
  const { id: sourceId, ...source } = job.source;
  return { ...meaning, schedule: nativeScheduleMeaning(job.schedule),
    createdAt: nativeClockMeaning(job.createdAt), updatedAt: nativeClockMeaning(job.updatedAt),
    nextRunAt: nativeClockMeaning(job.nextRunAt), lastRunAt: nativeClockMeaning(job.lastRunAt), archivedAt: nativeClockMeaning(job.archivedAt),
    source: { ...source, createdAt: nativeClockMeaning(source.createdAt), updatedAt: nativeClockMeaning(source.updatedAt), lastSeenAt: nativeClockMeaning(source.lastSeenAt) },
  };
}

/** Bind the authentic gateway invocation before REST's legacy route fallback. */
export function registerNativeAutomationGatewayMethods(catalog: GatewayMethodCatalog, input: {
  readonly manager: AutomationManager;
  readonly host: NativeMutationHost;
}): () => void {
  const disposals = [registerCatalogHandler<unknown, unknown>(catalog, 'automation.jobs.update', async ({ body, context }) => {
    if (!isRecord(body) || typeof body.jobId !== 'string' || !body.jobId.trim()) throw new HandlerError('An automation job id is required.', 'INVALID_ARGUMENT', 400);
    if (body.expectedMutationRevision !== undefined && (typeof body.expectedMutationRevision !== 'string' || !body.expectedMutationRevision.trim())) throw new HandlerError('expectedMutationRevision must be a nonempty string.', 'INVALID_ARGUMENT', 400);
    const autonomous = requestsNativeAdmission(body);
    if (autonomous && typeof body.expectedMutationRevision !== 'string') throw new HandlerError('Autonomous updates require the selected job revision.', 'AUTOMATION_JOB_REVISION_REQUIRED', 409);
    const jobId = body.jobId;
    const manager = input.manager, host = input.host, update = manager.updateJob, retainTarget = manager.retainJobTarget;
    const requestCurrent = retainNativeMutationRequest(body);
    const current = () => {
      context.signal?.throwIfAborted(); requestCurrent();
      if (input.manager !== manager || input.host !== host || manager.updateJob !== update || manager.retainJobTarget !== retainTarget) throw new AutomationJobMutationStaleError();
    };
    try {
      current();
      const patch = parseUpdateAutomationJobInput(body);
      const expected = patch.expectedMutationRevision;
      const selected = expected ? retainTarget.call(manager, jobId, expected) : undefined;
      const updated = await runNativeMutation({ host, method: 'automation.jobs.update', body, context,
        automationTarget: selected,
        target: selected ? nativeJobMeaning(selected.job) : { jobId },
        scopes: ['write:automation'], confirmation: 'none',
        assertTargetCurrent: () => { current(); selected?.assertCurrent(); },
        mutate: (assertCurrent, _admission, withPublication) => update.call(manager, jobId, patch, { signal: context.signal, assertCurrent: () => { current(); assertCurrent(); }, withPublication }),
      });
      if (!updated) throw new HandlerError('Automation job not found.', 'NOT_FOUND', 404);
      return updated;
    } catch (error) {
      if (error instanceof AutomationJobMutationStaleError || error instanceof AutomationJobCommitIndeterminateError) throw new HandlerError(error.message, error.code, error.status);
      throw error;
    }
  })];
  for (const method of ['automation.jobs.create', 'automation.schedules.create']) {
    disposals.push(registerCatalogHandler<unknown, unknown>(catalog, method, async ({ body, context }) => {
      if (!isRecord(body) || typeof body.prompt !== 'string' || !body.prompt.trim()) throw new HandlerError('An automation prompt is required.', 'INVALID_ARGUMENT', 400);
      const manager = input.manager, host = input.host, create = manager.createJob;
      const requestCurrent = retainNativeMutationRequest(body);
      const current = () => {
        context.signal?.throwIfAborted(); requestCurrent();
        if (input.manager !== manager || input.host !== host || manager.createJob !== create) throw new AutomationJobMutationStaleError();
      };
      current();
      const schedule = isRecord(body.schedule) && body.schedule.kind !== undefined ? body.schedule
        : body.kind === 'every' ? normalizeEverySchedule(typeof body.every === 'string' ? body.every : '')
        : body.kind === 'at' ? normalizeAtSchedule(typeof body.at === 'number' ? body.at : Date.parse(String(body.at)))
        : normalizeCronSchedule(typeof body.cron === 'string' ? body.cron : isRecord(body.schedule) && typeof body.schedule.expression === 'string' ? body.schedule.expression : '', typeof body.timezone === 'string' ? body.timezone : undefined, body.staggerMs ?? body.stagger);
      const patch = parseCreateAutomationJobInput({ ...body, name: typeof body.name === 'string' ? body.name : body.prompt.slice(0, 40), schedule });
      try {
        const created = await runNativeMutation({ host, method, body, context, target: { schedule: nativeScheduleMeaning(patch.schedule) }, scopes: ['write:automation'], confirmation: 'none', assertTargetCurrent: current,
          mutate: (assertCurrent, _admission, withPublication) => create.call(manager, patch, { signal: context.signal, assertCurrent: () => { current(); assertCurrent(); }, withPublication }),
        });
        return Response.json(created, { status: 201 });
      } catch (error) {
        if (error instanceof AutomationJobMutationStaleError || error instanceof AutomationJobCommitIndeterminateError) throw new HandlerError(error.message, error.code, error.status);
        throw error;
      }
    }));
  }
  for (const method of ['automation.jobs.enable', 'automation.jobs.disable', 'automation.jobs.delete', 'automation.schedules.enable', 'automation.schedules.disable', 'automation.schedules.delete']) {
    disposals.push(registerCatalogHandler<unknown, unknown>(catalog, method, async ({ body, context }) => {
      const key = method.startsWith('automation.jobs.') ? 'jobId' : 'scheduleId';
      if (!isRecord(body) || typeof body[key] !== 'string' || !body[key].trim()) throw new HandlerError('An automation job id is required.', 'INVALID_ARGUMENT', 400);
      const jobId = body[key], revision = body.expectedMutationRevision;
      if (revision !== undefined && (typeof revision !== 'string' || !revision.trim())) throw new HandlerError('expectedMutationRevision must be a nonempty string.', 'INVALID_ARGUMENT', 400);
      if (requestsNativeAdmission(body) && typeof revision !== 'string') throw new HandlerError('Autonomous mutations require the selected job revision.', 'AUTOMATION_JOB_REVISION_REQUIRED', 409);
      const manager = input.manager, host = input.host, remove = manager.removeJob, toggle = manager.setEnabled, retainTarget = manager.retainJobTarget;
      const requestCurrent = retainNativeMutationRequest(body);
      const current = () => {
        context.signal?.throwIfAborted(); requestCurrent();
        if (input.manager !== manager || input.host !== host || manager.removeJob !== remove || manager.setEnabled !== toggle || manager.retainJobTarget !== retainTarget) throw new AutomationJobMutationStaleError();
      };
      try {
        current();
        const selected = typeof revision === 'string' ? retainTarget.call(manager, jobId, revision) : undefined;
        return await runNativeMutation({ host, method, body, context, target: selected ? nativeJobMeaning(selected.job) : { jobId }, scopes: ['write:automation'], confirmation: 'none',
          automationTarget: selected,
          assertTargetCurrent: () => { current(); selected?.assertCurrent(); },
          mutate: async (assertCurrent, _admission, withPublication) => {
            const options = { signal: context.signal, assertCurrent: () => { current(); assertCurrent(); }, withPublication };
            if (method.endsWith('.delete')) {
              const removed = await remove.call(manager, jobId, options);
              if (!removed) throw new HandlerError('Automation job not found.', 'NOT_FOUND', 404);
              return { id: jobId, removed };
            }
            const enabled = method.endsWith('.enable');
            const updated = await toggle.call(manager, jobId, enabled, options);
            if (!updated) throw new HandlerError('Automation job not found.', 'NOT_FOUND', 404);
            return { id: jobId, enabled };
          },
        });
      } catch (error) {
        if (error instanceof AutomationJobMutationStaleError || error instanceof AutomationJobCommitIndeterminateError) throw new HandlerError(error.message, error.code, error.status);
        throw error;
      }
    }));
  }
  return () => { for (const dispose of disposals.reverse()) dispose(); };
}
