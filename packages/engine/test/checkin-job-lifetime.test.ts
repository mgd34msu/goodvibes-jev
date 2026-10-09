import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { CheckinService } from '../sdk/src/platform/checkin/service.js';
import { CheckinReceiptStore } from '../sdk/src/platform/checkin/receipts.js';
import { createProviderBackedCheckinJudge } from '../sdk/src/platform/checkin/judge.js';
import { executeCheckinJob } from '../sdk/src/platform/automation/checkin-execution.js';
import type { AutomationJob } from '../sdk/src/platform/automation/jobs.js';
import type { AutomationRun } from '../sdk/src/platform/automation/runs.js';
import type { AutomationManagerExecutionContext } from '../sdk/src/platform/automation/manager-runtime-execution.js';
import type { CheckinServiceDeps } from '../sdk/src/platform/checkin/service.js';
import type { ProviderRegistry } from '../sdk/src/platform/providers/registry.js';
let previous: JudgmentPort | undefined;
let log: SqliteDecisionLog;
beforeEach(() => {
  log = new SqliteDecisionLog(':memory:');
  previous = installJudgmentPort(withDecisionLog(fakePort((name, question) => name === 'contact' ? noulAnswer(0.99) : choiceAnswer(question, 'supports', 0.99)).port, log));
});
afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); });
function fixture() {
  const job = { id: 'scheduled-checkin', kind: 'checkin', name: 'Check-in', enabled: true, status: 'enabled',
    createdAt: 1, updatedAt: 1, createdBy: 'owner-a', labels: [],
    source: { id: 'source-a', kind: 'manual', enabled: true, createdAt: 1, updatedAt: 1, label: 'Owner', metadata: { owner: 'owner-a' } },
    execution: { target: { kind: 'isolated' }, prompt: '(check-in)' }, schedule: { kind: 'cron', expression: '0 */4 * * *' },
    runCount: 0, successCount: 0, failureCount: 0 } as unknown as AutomationJob;
  const jobs = new Map([[job.id, job]]), runs = new Map<string, AutomationRun>();
  const synced: AutomationJob[] = [];
  const context = { jobs, runs, saveJobs: async () => {}, saveRuns: async () => {}, pruneRunHistory: () => {},
    syncRunToRuntime: () => {}, syncJobToRuntime: (job: AutomationJob) => synced.push(job),
    emitRunQueued: () => {}, emitRunStarted: () => {}, emitRunCompleted: () => {}, emitRunFailed: () => {} } as unknown as AutomationManagerExecutionContext;
  return { job, jobs, runs, context, synced };
}
type Change = 'disable' | 'remove' | 'owner' | 'disable-reenable';
function changeJob(f: ReturnType<typeof fixture>, change: Change) {
  const current = f.jobs.get(f.job.id)!;
  if (change === 'remove') f.jobs.delete(f.job.id);
  else if (change === 'owner') f.jobs.set(f.job.id, { ...current, createdBy: 'owner-b', source: { ...current.source, id: 'source-b', metadata: { owner: 'owner-b' } }, updatedAt: current.updatedAt + 1 });
  else f.jobs.set(f.job.id, { ...current, enabled: change === 'disable-reenable', status: change === 'disable-reenable' ? 'enabled' : 'paused', updatedAt: change === 'disable-reenable' ? current.updatedAt : current.updatedAt + 2 });
}
for (const change of ['disable', 'remove', 'owner', 'disable-reenable'] as const) {
  test(`scheduled ${change} while note waits prevents send and terminalization preserves current job`, async () => {
    const f = fixture(), entered = Promise.withResolvers<void>(), held = Promise.withResolvers<{ content: string }>();
    const provider = { getCurrentModel: () => ({ id: 'synthetic', registryKey: 'synthetic', provider: 'synthetic' }),
      getForModel: () => ({ async chat() { entered.resolve(); return held.promise; } }) } as unknown as Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel'>;
    const automation = { listJobs: () => [...f.jobs.values()] } as CheckinServiceDeps['automation'];
    const receipts = new CheckinReceiptStore(':memory:'); let sent = 0;
    const service = new CheckinService({ config: { get: (key) => key === 'checkin.enabled' ? true : '', set() {} },
      stateReader: { snapshot: async () => ({ runningSessions: 0, blockedSessions: 1, unreadChannelItems: 0, recentCompletions: 0, needsAttention: ['Release needs an owner choice.'] }) },
      judge: createProviderBackedCheckinJudge(provider), receipts, automation,
      deliverer: { async deliver(_channel, _message, lifetime) { lifetime!.assertCurrent(); sent++; return 'sent'; } } });
    const pending = executeCheckinJob(f.context, job => service.evaluate('scheduled', job.id), f.job, 'scheduled', true, 1);
    await entered.promise; changeJob(f, change);
    const changed = f.jobs.get(f.job.id); held.resolve({ content: 'The release needs your choice.' });
    const run = await pending;
    expect(run.result).toMatchObject({ checkin: 'skipped' }); expect(sent).toBe(0);
    expect((await receipts.list())[0]!.outcome).toBe('skipped-stale');
    const current = f.jobs.get(f.job.id);
    if (change === 'remove') { expect(current).toBeUndefined(); expect(f.synced).toHaveLength(0); }
    else {
      expect(current?.enabled).toBe(changed!.enabled); expect(current?.status).toBe(changed!.status);
      expect(current?.createdBy).toBe(changed!.createdBy); expect(current?.source).toEqual(changed!.source);
      if (change === 'owner') expect(current).toEqual(changed);
    }
  });
}
for (const change of ['disable', 'remove', 'owner'] as const) {
  test(`throwing pending evaluator does not restore ${change} job in error terminalization`, async () => {
    const f = fixture(), entered = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
    const pending = executeCheckinJob(f.context, async () => { entered.resolve(); await held.promise; throw new Error('synthetic failure'); }, f.job, 'scheduled', true, 1);
    await entered.promise; changeJob(f, change); const changed = f.jobs.get(f.job.id); held.resolve();
    expect((await pending).status).toBe('failed');
    const current = f.jobs.get(f.job.id);
    if (change === 'remove') expect(current).toBeUndefined();
    else { expect(current?.enabled).toBe(changed!.enabled); expect(current?.source).toEqual(changed!.source); expect(current?.createdBy).toBe(changed!.createdBy); }
  });
}
