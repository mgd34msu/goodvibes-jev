/**
 * Failure transience before every retry, cooldown or dead-letter in the
 * integration delivery queue and in automation: structured facts decide
 * first, then one reading of the wording through the engine failure battery,
 * composed in code. No message text is pattern-matched.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import {
  forgetFailureReadings,
  HttpStatusError,
  installJudgmentPort,
  JudgmentPortMissingError,
} from '@goodvibes-jev/engine/errors';
import {
  classifyDeliveryError,
  DeliveryError,
  DeliveryQueue,
  readFailureTransience,
  structuredTransience,
  type TransienceBasis,
} from '../sdk/src/platform/integrations/delivery.ts';
import { AutomationDeliveryManager } from '../sdk/src/platform/automation/delivery-manager.ts';
import {
  readAutomationRunTransience,
  scheduleAutomationFailureFollowUp,
} from '../sdk/src/platform/automation/manager-runtime-delivery.ts';
import { AutomationManager } from '../sdk/src/platform/automation/manager-runtime.ts';
import type { AutomationJob } from '../sdk/src/platform/automation/jobs.ts';
import type { AutomationRun } from '../sdk/src/platform/automation/runs.ts';
import type { AutomationJobStore } from '../sdk/src/platform/automation/store/jobs.ts';
import type { AutomationRunStore } from '../sdk/src/platform/automation/store/runs.ts';
import type { RouteBindingManager } from '../sdk/src/platform/channels/index.ts';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A port that reads every failure as `category`, answering yes only to the named questions; counts requests. */
function readingPort(category: string, yes: readonly string[] = [], confidence = 0.95) {
  return fakePort((name: string, question: Question) => {
    if (name === 'category') return choiceAnswer(question, category, confidence);
    return noulAnswer(yes.includes(name) ? 0.95 : 0.05);
  });
}

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  forgetFailureReadings();
  previous = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previous);
  forgetFailureReadings();
});

function connectionRefused(): TypeError {
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
  return new TypeError('fetch failed', { cause });
}

describe('structure decides without a reading', () => {
  test('explicit class, Retry-After, status, errno and timeout class, with no port installed', async () => {
    const cases: Array<[unknown, 'retryable' | 'terminal', TransienceBasis]> = [
      [new DeliveryError('rejected upstream', 'terminal'), 'terminal', 'explicit'],
      [new HttpStatusError('SlackIntegration.postMessage failed (404): channel_not_found', { status: 404 }), 'terminal', 'status'],
      [new HttpStatusError('HTTP 503: upstream unavailable', { status: 503 }), 'retryable', 'status'],
      [new HttpStatusError('HTTP 429: slow down', { status: 429 }), 'retryable', 'status'],
      [Object.assign(new Error('secondary rate limit'), { status: 403, retryAfterMs: 60_000 }), 'retryable', 'retry-after'],
      [Object.assign(new Error('Payment Required'), { statusCode: 402 }), 'terminal', 'status'],
      [connectionRefused(), 'retryable', 'errno'],
      [new DOMException('The operation timed out.', 'TimeoutError'), 'retryable', 'error-type'],
    ];
    for (const [error, failureClass, basis] of cases) {
      const decided = await readFailureTransience(error, 'test.structure');
      expect({ failureClass: decided.failureClass, basis: decided.basis }).toEqual({ failureClass, basis });
      expect(await classifyDeliveryError(error)).toBe(failureClass);
    }
  });

  test('a status only in the message text is not parsed: it needs a reading', async () => {
    expect(structuredTransience(new Error('HTTP 400: bad request'))).toBeUndefined();
    await expect(readFailureTransience(new Error('HTTP 400: bad request'), 'test.text')).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });

  test('a failure with no wording is retried without a request', async () => {
    const { port, requests } = readingPort('unknown');
    installJudgmentPort(port);
    const decided = await readFailureTransience(new Error(''), 'test.empty');
    expect(decided).toEqual({ failureClass: 'retryable', basis: 'no-wording', detail: 'the failure carries no wording' });
    expect(requests).toHaveLength(0);
  });
});

describe('the reading, composed in code', () => {
  test('a Slack API error with no status is read, once per wording', async () => {
    const { port, requests } = readingPort('not_found');
    installJudgmentPort(port);
    const error = new Error('SlackIntegration.postMessage API error: channel_not_found');
    const first = await readFailureTransience(error, 'test.slack');
    const second = await readFailureTransience(error, 'test.slack');
    expect(first).toEqual({ failureClass: 'terminal', basis: 'reading', detail: 'read as not_found' });
    expect(second).toEqual(first);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.state).toBe('Message: SlackIntegration.postMessage API error: channel_not_found');
    expect(requests[0]!.context?.site).toBe('test.slack');
  });

  test('the cause\'s wording and the error class go to the reading', async () => {
    const { port, requests } = readingPort('network', ['transient_network', 'before_response']);
    installJudgmentPort(port);
    const error = new TypeError('fetch failed', { cause: new Error('other side closed') });
    expect((await readFailureTransience(error, 'test.cause')).failureClass).toBe('retryable');
    expect(requests[0]!.state).toBe('Error type: TypeError\nMessage: fetch failed\nCaused by: other side closed');
  });

  test('a spent account is permanent even when it reads as a rate limit', async () => {
    installJudgmentPort(readingPort('rate_limit', ['billing', 'rate_limited']).port);
    expect(await readFailureTransience(new Error('You exceeded your current quota, insufficient_quota'), 'test.billing'))
      .toEqual({ failureClass: 'terminal', basis: 'reading', detail: 'the account cannot pay for the request' });
  });

  test('a transient network fault is retried whatever category it reads as', async () => {
    installJudgmentPort(readingPort('bad_request', ['transient_network']).port);
    expect((await readFailureTransience(new Error('socket hang up'), 'test.network')).failureClass).toBe('retryable');
  });

  test('a service or protocol failure is retried; a bad request is not', async () => {
    installJudgmentPort(readingPort('protocol').port);
    expect((await readFailureTransience(new Error('Unexpected end of JSON input'), 'test.protocol')).failureClass).toBe('retryable');
    forgetFailureReadings();
    installJudgmentPort(readingPort('bad_request').port);
    expect((await readFailureTransience(new Error('Failed to parse URL from ht!tp://x'), 'test.bad')).failureClass).toBe('terminal');
  });

  test('a reading too weak to settle anything is retried', async () => {
    installJudgmentPort(readingPort('bad_request', [], 0.3).port);
    expect(await readFailureTransience(new Error('something odd happened'), 'test.weak'))
      .toEqual({ failureClass: 'retryable', basis: 'reading', detail: 'the wording does not settle it' });
  });
});

describe('DeliveryQueue', () => {
  test('a terminal failure dead-letters on the first attempt', async () => {
    const queue = new DeliveryQueue({ maxRetries: 3, initialDelayMs: 1 });
    const outcome = await queue.enqueue('slack', 'agent.done', 'hello', async () => {
      throw new HttpStatusError('SlackIntegration.postWebhook failed (403): invalid_token', { status: 403 });
    });
    expect(outcome).toBe('dead_letter');
    expect(queue.getDlq()).toHaveLength(1);
    expect(queue.getDlq()[0]).toMatchObject({ attempts: 1, failureClass: 'terminal' });
    queue.dispose();
  });

  test('a read-transient failure is queued for retry', async () => {
    installJudgmentPort(readingPort('service').port);
    const queue = new DeliveryQueue({ maxRetries: 3, initialDelayMs: 60_000, maxDelayMs: 60_000 });
    const outcome = await queue.enqueue('discord', 'agent.done', 'hello', async () => {
      throw new Error('Discord gateway reported the service is temporarily unavailable');
    });
    expect(outcome).toBe('retrying');
    expect(queue.getMetrics().retrying).toBe(1);
    queue.dispose();
  });

  test('no reading means no decision: the enqueue rejects with both errors', async () => {
    const queue = new DeliveryQueue({ maxRetries: 3 });
    const attempt = queue.enqueue('webhook', 'agent.done', 'hello', async () => {
      throw new Error('delivery went wrong somehow');
    });
    await expect(attempt).rejects.toBeInstanceOf(AggregateError);
    expect(queue.getMetrics()).toMatchObject({ retrying: 0, deadLettered: 0 });
    queue.dispose();
  });
});

function makeJob(overrides: Partial<AutomationJob> = {}): AutomationJob {
  const now = Date.now();
  return {
    id: 'job-1',
    labels: [],
    createdAt: now,
    updatedAt: now,
    name: 'Nightly digest',
    status: 'enabled',
    enabled: true,
    schedule: { kind: 'every', intervalMs: 3_600_000 },
    execution: { target: { kind: 'background' }, prompt: 'write the digest', maxAttempts: 3 },
    delivery: {
      mode: 'surface',
      targets: [{ kind: 'surface', surfaceKind: 'webhook', address: 'https://example.test/hook' }],
      fallbackTargets: [],
      includeSummary: false,
      includeTranscript: false,
      includeLinks: false,
    },
    failure: {
      action: 'retry',
      maxConsecutiveFailures: 5,
      cooldownMs: 60_000,
      retryPolicy: { maxAttempts: 3, delayMs: 0, strategy: 'fixed' },
    },
    source: { id: 'source-1', kind: 'manual', label: 'test', enabled: true, createdAt: now, updatedAt: now, metadata: {} },
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    deleteAfterRun: false,
    ...overrides,
  } as AutomationJob;
}

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  const now = Date.now();
  return {
    id: 'run-1',
    labels: [],
    createdAt: now,
    updatedAt: now,
    jobId: 'job-1',
    status: 'failed',
    triggeredBy: { id: 'source-1', kind: 'manual', label: 'test', enabled: true, createdAt: now, updatedAt: now, metadata: {} },
    target: { kind: 'background' },
    execution: { target: { kind: 'background' }, prompt: 'write the digest' },
    queuedAt: now,
    forceRun: false,
    dueRun: false,
    attempt: 1,
    deliveryIds: [],
    ...overrides,
  } as AutomationRun;
}

const allFlags = { isEnabled: () => true };
const routeBindings = {
  start: async () => undefined,
  getBinding: () => undefined,
  captureReplyTarget: async () => undefined,
} as unknown as RouteBindingManager;

function deliveryManagerThrowing(error: () => Error): { manager: AutomationDeliveryManager; sends: () => number } {
  let sends = 0;
  const manager = new AutomationDeliveryManager({
    routeBindings,
    featureFlags: allFlags,
    deliveryRouter: {
      setControlPlaneGateway() {},
      deliver: async () => {
        sends += 1;
        throw error();
      },
    } as never,
  });
  return { manager, sends: () => sends };
}

describe('automation delivery attempts', () => {
  test('a 404 fails after one send', async () => {
    const { manager, sends } = deliveryManagerThrowing(() => new HttpStatusError('Webhook delivery failed HTTP 404', { status: 404 }));
    const attempts = await manager.deliverJobRun(makeJob(), makeRun({ status: 'completed' }));
    expect(attempts.map((attempt) => attempt.status)).toEqual(['failed']);
    expect(sends()).toBe(1);
  });

  test('a read-transient failure uses every attempt, then dead-letters', async () => {
    installJudgmentPort(readingPort('network', ['transient_network']).port);
    const { manager, sends } = deliveryManagerThrowing(() => new Error('socket hang up'));
    const attempts = await manager.deliverJobRun(makeJob(), makeRun({ status: 'completed' }));
    expect(attempts.map((attempt) => attempt.status)).toEqual(['dead_lettered']);
    expect(sends()).toBe(3);
  });

  test('a read-permanent failure stops after one send', async () => {
    installJudgmentPort(readingPort('not_found').port);
    const { manager, sends } = deliveryManagerThrowing(() => new Error('SlackIntegration.postMessage API error: channel_not_found'));
    const attempts = await manager.deliverJobRun(makeJob(), makeRun({ status: 'completed' }));
    expect(attempts.map((attempt) => attempt.status)).toEqual(['failed']);
    expect(sends()).toBe(1);
  });
});

describe('automation run follow-up', () => {
  const ids = { jobId: 'job-1', runId: 'run-1' };

  test('a known transience needs no reading; a failure with no port yields none', async () => {
    const known = { failureClass: 'retryable', basis: 'explicit', detail: 'lost to a restart' } as const;
    expect(await readAutomationRunTransience({ known }, 'test.run', ids)).toBe(known);
    expect(await readAutomationRunTransience({ error: 'model refused the task' }, 'test.run', ids)).toBeUndefined();
  });

  test('a failure text is read', async () => {
    installJudgmentPort(readingPort('authentication').port);
    expect((await readAutomationRunTransience({ error: 'invalid x-api-key' }, 'test.run', ids))?.failureClass).toBe('terminal');
  });

  function followUpContext(job: AutomationJob) {
    return {
      jobs: new Map([[job.id, job]]),
      retryTimers: new Map<string, ReturnType<typeof setTimeout>>(),
      deliveryManager: null,
      activeRunCount: () => 0,
      maxConcurrentRuns: () => 1,
      executeJob: async () => makeRun(),
      saveJobs: async () => undefined,
      scheduleJob: () => undefined,
      deliverFailureNotice: () => undefined,
      emitRunFailed: () => undefined,
    };
  }

  test('a retry policy retries only a failure another attempt could fix', () => {
    const job = makeJob();
    const refused = followUpContext(job);
    scheduleAutomationFailureFollowUp(refused, job, makeRun(), false);
    expect(refused.retryTimers.size).toBe(0);

    const allowed = followUpContext(job);
    scheduleAutomationFailureFollowUp(allowed, job, makeRun(), true);
    expect(allowed.retryTimers.size).toBe(1);
    for (const timer of allowed.retryTimers.values()) clearTimeout(timer);
  });

  test('a cooldown policy moves the next run out either way', () => {
    const job = makeJob({ failure: { ...makeJob().failure, action: 'cooldown' } });
    const context = followUpContext(job);
    const before = Date.now();
    scheduleAutomationFailureFollowUp(context, job, makeRun(), false);
    expect(context.jobs.get(job.id)!.nextRunAt).toBeGreaterThanOrEqual(before + 60_000);
  });
});

describe('AutomationManager reconcile', () => {
  async function reconcileFailedAgent(agentError: string): Promise<boolean[]> {
    const dir = mkdtempSync(join(tmpdir(), 'gv-transience-'));
    const now = Date.now();
    const job = makeJob({ execution: { target: { kind: 'background' }, prompt: 'write the digest', maxAttempts: 1 } });
    const run = makeRun({ status: 'running', agentId: 'agent-1', startedAt: now - 1_000 });
    const bus = new RuntimeEventBus();
    const retryable: boolean[] = [];
    bus.onDomain('automation', (envelope) => {
      const payload = envelope.payload as { type: string; retryable?: boolean };
      if (payload.type === 'AUTOMATION_RUN_FAILED') retryable.push(payload.retryable === true);
    });
    const manager = new AutomationManager({
      configManager: new ConfigManager({ configDir: dir }),
      routeBindings,
      sessionBroker: {} as never,
      featureFlags: allFlags,
      runtimeBus: bus,
      jobStore: { load: async () => ({ version: 1, jobs: [job] }), save: async () => undefined } as unknown as AutomationJobStore,
      runStore: { load: async () => ({ version: 1, runs: [run] }), save: async () => undefined } as unknown as AutomationRunStore,
      agentStatusProvider: { getStatus: () => ({ id: 'agent-1', status: 'failed', error: agentError, completedAt: now }) as never },
    });
    try {
      await manager.start();
      for (let i = 0; i < 20 && retryable.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(manager.getRun('run-1')?.status).toBe('failed');
      return retryable;
    } finally {
      manager.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('an agent failure is read before the run-failed event', async () => {
    installJudgmentPort(readingPort('network', ['transient_network']).port);
    expect(await reconcileFailedAgent('socket hang up')).toEqual([true]);
  });

  test('a permanent agent failure is reported as not retryable', async () => {
    installJudgmentPort(readingPort('authentication').port);
    expect(await reconcileFailedAgent('invalid x-api-key')).toEqual([false]);
  });
});
