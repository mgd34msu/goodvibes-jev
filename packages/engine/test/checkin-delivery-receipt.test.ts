import { expect, spyOn, test } from 'bun:test';
import { CheckinService } from '../sdk/src/platform/checkin/service.js';
import { executeCheckinJob } from '../sdk/src/platform/automation/checkin-execution.js';
import type { AutomationManagerExecutionContext } from '../sdk/src/platform/automation/manager-runtime-execution.js';
import type { AutomationJob } from '../sdk/src/platform/automation/jobs.js';
import { CheckinReceiptStore } from '../sdk/src/platform/checkin/receipts.js';

for (const confirmed of [false, true]) {
  test(`revocation after delivery entry preserves confirmation honesty: confirmed=${confirmed}`, async () => {
    let enabled = true, sendInvocations = 0;
    const controller = new AbortController();
    const receipts = new CheckinReceiptStore(':memory:');
    const service = new CheckinService({
      config: { get: key => key === 'checkin.enabled' ? enabled : '', set() {} },
      stateReader: { snapshot: async () => ({ runningSessions: 0, blockedSessions: 1, unreadChannelItems: 0, recentCompletions: 0, needsAttention: ['Owner decision needed'] }) },
      judge: { decide: async () => ({ contact: true, reason: 'Synthetic typed seam', message: 'Owner decision needed' }) },
      deliverer: { async deliver(_channel, _message, lifetime) {
        lifetime!.assertCurrent(); sendInvocations++;
        enabled = false; controller.abort();
        if (!confirmed) throw new Error('Synthetic response interrupted after transport entry');
        return 'confirmed-receipt';
      } }, receipts,
    });
    const result = await service.evaluate('manual', undefined, controller.signal);
    expect(sendInvocations).toBe(1);
    expect(result.outcome).toBe(confirmed ? 'delivered' : 'error');
    const receipt = (await receipts.list())[0]!;
    expect(receipt.outcome).toBe(confirmed ? 'delivered' : 'error');
    if (confirmed) expect(receipt.deliveryId).toBe('confirmed-receipt');
    else { expect(receipt.deliveryId).toBeUndefined(); expect(receipt.error).toContain('not confirmed'); }
  });
}

test('receipt persistence failure retains known delivery acceptance and ID without relabeling or retrying send', async () => {
  const receipts = new CheckinReceiptStore(':memory:');
  const append = spyOn(receipts, 'append').mockRejectedValueOnce(new Error('Synthetic persistence unavailable'));
  let sends = 0;
  const service = new CheckinService({ config: { get: key => key === 'checkin.enabled' ? true : '', set() {} },
    stateReader: { snapshot: async () => ({ runningSessions: 0, blockedSessions: 1, unreadChannelItems: 0, recentCompletions: 0, needsAttention: ['Owner decision needed'] }) },
    judge: { decide: async () => ({ contact: true, reason: 'Synthetic typed seam', message: 'Owner decision needed' }) },
    deliverer: { async deliver() { sends++; return 'known-accepted-id'; } }, receipts });
  try {
    const result = await service.evaluate('manual');
    expect(result).toMatchObject({ outcome: 'delivered', deliveryId: 'known-accepted-id', error: 'Check-in receipt persistence failed' });
    expect(result.summary).toContain('delivery was confirmed'); expect(result.summary).not.toContain('not confirmed');
    const jobs = new Map<string, AutomationJob>();
    let evaluations = 0;
    const context = { jobs, runs: new Map(), saveJobs: async () => {}, saveRuns: async () => {}, pruneRunHistory() {},
      syncRunToRuntime() {}, syncJobToRuntime() {}, emitRunQueued() {}, emitRunStarted() {}, emitRunCompleted() {}, emitRunFailed() {},
    } as unknown as AutomationManagerExecutionContext;
    const job = { id: 'receipt-job', kind: 'checkin', source: {}, execution: { target: { kind: 'isolated' } },
      schedule: { kind: 'cron', expression: '0 */4 * * *' }, failure: { mode: 'retry' }, runCount: 0, successCount: 0, failureCount: 0,
    } as unknown as AutomationJob;
    const run = await executeCheckinJob(context, async () => { evaluations++; return result; }, job, 'scheduled', true, 1);
    expect(run.status).toBe('completed'); expect(run.deliveryIds).toEqual(['known-accepted-id']);
    expect(run.error).toBe('Check-in receipt persistence failed'); expect(jobs.get(job.id)?.failureCount).toBe(0);
    expect(evaluations).toBe(1); expect(sends).toBe(1); expect(append).toHaveBeenCalledTimes(1);
  } finally { append.mockRestore(); }
});
