import { describe, expect, test } from 'bun:test';
import { forgetFailureReadings, HttpStatusError, installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { useFailureReadings } from './_helpers/failure-readings.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { DEFAULT_CONFIG } from '../sdk/src/platform/config/schema.js';
import { DaemonBatchManager, MAX_BATCH_SUBMIT_ATTEMPTS } from '../sdk/src/platform/batch/manager.js';
import type { LLMProvider, ProviderBatchChatRequest, ProviderBatchResult } from '../sdk/src/platform/providers/interface.js';
import type { ProviderRegistry } from '../sdk/src/platform/providers/registry.js';

function makeConfigManager(): ConfigManager {
  const configDir = join(tmpdir(), `gv-batch-test-${Date.now()}-${crypto.randomUUID()}`);
  mkdirSync(configDir, { recursive: true });
  return new ConfigManager({ configDir });
}

function makeProvider(): LLMProvider & { readonly submitted: ProviderBatchChatRequest[] } {
  const submitted: ProviderBatchChatRequest[] = [];
  return {
    name: 'openai',
    models: ['gpt-test'],
    submitted,
    isConfigured: () => true,
    async chat() {
      throw new Error('not used');
    },
    batch: {
      kind: 'provider-batch',
      endpoints: ['/v1/chat/completions'],
      async createChatBatch(input) {
        submitted.push(...input.requests);
        return { providerBatchId: 'provider-batch-1', status: 'submitted' };
      },
      async retrieveBatch(providerBatchId) {
        return { providerBatchId, status: 'completed', resultAvailable: true };
      },
      async getResults() {
        return submitted.map((request): ProviderBatchResult => ({
          customId: request.customId,
          status: 'succeeded',
          response: {
            content: 'batched response',
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 2 },
            stopReason: 'completed',
          },
        }));
      },
    },
  };
}

function makeRegistry(provider: LLMProvider): Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'getRegistered' | 'listProviders'> {
  return {
    getCurrentModel: () => ({
      id: 'gpt-test',
      provider: 'openai',
      registryKey: 'openai:gpt-test',
      displayName: 'GPT Test',
      description: 'test model',
      capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
      contextWindow: 128_000,
      selectable: true,
      tier: 'standard',
    }),
    getForModel: () => provider,
    getRegistered: () => provider,
    listProviders: () => [provider],
  };
}

describe('daemon batch defaults', () => {
  test('batch and Cloudflare are off by default', () => {
    const config = DEFAULT_CONFIG as unknown as Record<string, Record<string, unknown>>;
    const batch = config.batch;
    const cloudflare = config.cloudflare;
    expect(batch).toBeDefined();
    expect(cloudflare).toBeDefined();
    expect(batch!.mode).toBe('off');
    expect(batch!.queueBackend).toBe('local');
    expect(cloudflare!.enabled).toBe(false);
    expect(cloudflare!.freeTierMode).toBe(true);
  });
});

describe('DaemonBatchManager', () => {
  test('rejects job creation when batch mode is off', async () => {
    const configManager = makeConfigManager();
    const provider = makeProvider();
    const manager = new DaemonBatchManager({
      configManager,
      providerRegistry: makeRegistry(provider),
    });

    await expect(manager.createJob({
      request: { messages: [{ role: 'user', content: 'hi' }] },
    })).rejects.toThrow('Daemon batch mode is off');
  });

  test('queues, submits, polls, and completes provider batch jobs', async () => {
    const configManager = makeConfigManager();
    configManager.set('batch.mode', 'explicit');
    configManager.set('batch.maxDelayMs', 0);
    const provider = makeProvider();
    const manager = new DaemonBatchManager({
      configManager,
      providerRegistry: makeRegistry(provider),
    });

    const queued = await manager.createJob({
      provider: 'openai',
      model: 'gpt-test',
      request: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(queued.status).toBe('queued');

    const tick = await manager.tick({ forceSubmit: true });
    expect(tick.submittedJobs).toBe(1);
    expect(tick.completedJobs).toBe(1);

    const completed = await manager.getJob(queued.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.result?.content).toBe('batched response');
    expect(provider.submitted[0]?.customId).toBe(queued.id);
  });
});

/** A provider whose batch calls fail with the given errors (create, then retrieve), until told to succeed. */
function makeFailingProvider(failures: { create?: () => unknown; retrieve?: () => unknown }) {
  const provider = makeProvider();
  const batch = provider.batch!;
  return {
    ...provider,
    batch: {
      ...batch,
      async createChatBatch(input: Parameters<typeof batch.createChatBatch>[0]) {
        if (failures.create) throw failures.create();
        return batch.createChatBatch(input);
      },
      async retrieveBatch(id: string) {
        if (failures.retrieve) throw failures.retrieve();
        return batch.retrieveBatch(id);
      },
    },
  } as LLMProvider;
}

async function managerWith(provider: LLMProvider) {
  const configManager = makeConfigManager();
  configManager.set('batch.mode', 'explicit');
  configManager.set('batch.maxDelayMs', 0);
  const manager = new DaemonBatchManager({ configManager, providerRegistry: makeRegistry(provider) });
  const job = await manager.createJob({
    provider: 'openai',
    model: 'gpt-test',
    request: { messages: [{ role: 'user', content: 'hi' }] },
  });
  return { manager, job };
}

describe('provider batch failures: whether another attempt could succeed', () => {
  const readings = useFailureReadings([
    ['You exceeded your current quota', { category: 'rate_limit', billing: true, rateLimited: true }],
    ['socket hang up', { category: 'network', transientNetwork: true }],
    ['model gpt-test does not support batch', { category: 'bad_request' }],
  ]);

  test('a submission failing with a status a retry can clear leaves the job queued, without a reading', async () => {
    const { manager, job } = await managerWith(makeFailingProvider({ create: () => new HttpStatusError('HTTP 503: overloaded', { status: 503 }) }));
    const tick = await manager.tick({ forceSubmit: true });
    const after = await manager.getJob(job.id);
    expect(after?.status).toBe('queued');
    expect(after?.attempts).toBe(1);
    expect(after?.error?.message).toContain('503');
    expect(tick.failedJobs).toBe(0);
    expect(readings.requests).toHaveLength(0);
  });

  test('a submission rejected with a status no retry clears is dead-lettered', async () => {
    const { manager, job } = await managerWith(makeFailingProvider({ create: () => new HttpStatusError('HTTP 401: invalid api key', { status: 401 }) }));
    const tick = await manager.tick({ forceSubmit: true });
    expect((await manager.getJob(job.id))?.status).toBe('dead_lettered');
    expect(tick.failedJobs).toBe(1);
  });

  test("a provider's 429 is read for billing: a spent account is dead-lettered", async () => {
    const { manager, job } = await managerWith(makeFailingProvider({
      create: () => new HttpStatusError('HTTP 429: You exceeded your current quota, please check your plan', { status: 429 }),
    }));
    await manager.tick({ forceSubmit: true });
    expect((await manager.getJob(job.id))?.status).toBe('dead_lettered');
    expect(readings.requests).toHaveLength(1);
  });

  test('wording with no status is read: a dropped connection is retried, an unsupported request is not', async () => {
    const dropped = await managerWith(makeFailingProvider({ create: () => new Error('socket hang up') }));
    await dropped.manager.tick({ forceSubmit: true });
    expect((await dropped.manager.getJob(dropped.job.id))?.status).toBe('queued');

    const unsupported = await managerWith(makeFailingProvider({ create: () => new Error('model gpt-test does not support batch') }));
    await unsupported.manager.tick({ forceSubmit: true });
    expect((await unsupported.manager.getJob(unsupported.job.id))?.status).toBe('dead_lettered');
  });

  test('a job whose transient failures reach the attempt cap is dead-lettered', async () => {
    const { manager, job } = await managerWith(makeFailingProvider({ create: () => new HttpStatusError('HTTP 502', { status: 502 }) }));
    for (let i = 1; i < MAX_BATCH_SUBMIT_ATTEMPTS; i += 1) {
      await manager.tick({ forceSubmit: true });
      expect((await manager.getJob(job.id))?.status).toBe('queued');
    }
    await manager.tick({ forceSubmit: true });
    const after = await manager.getJob(job.id);
    expect(after?.status).toBe('dead_lettered');
    expect(after?.attempts).toBe(MAX_BATCH_SUBMIT_ATTEMPTS);
  });

  test('a poll failure a retry can clear keeps the provider batch for the next poll', async () => {
    const failures: { retrieve?: () => unknown } = { retrieve: () => new Error('socket hang up') };
    const { manager, job } = await managerWith(makeFailingProvider(failures));
    await manager.tick({ forceSubmit: true });
    const kept = await manager.getJob(job.id);
    expect(kept?.status).toBe('submitted');
    expect(kept?.providerBatchId).toBe('provider-batch-1');

    delete failures.retrieve;
    await manager.tick();
    expect((await manager.getJob(job.id))?.status).toBe('completed');
  });

  test('a poll failure no retry clears dead-letters the jobs', async () => {
    const { manager, job } = await managerWith(makeFailingProvider({ retrieve: () => new HttpStatusError('HTTP 404: batch not found', { status: 404 }) }));
    const tick = await manager.tick({ forceSubmit: true });
    expect((await manager.getJob(job.id))?.status).toBe('dead_lettered');
    expect(tick.failedJobs).toBe(1);
  });
});

describe('provider batch failure with no judgment port', () => {
  test('a failure only wording can settle fails the tick and leaves the job as it was', async () => {
    forgetFailureReadings();
    const previous = installJudgmentPort(undefined);
    try {
      const { manager, job } = await managerWith(makeFailingProvider({ create: () => new Error('something unusual happened') }));
      await expect(manager.tick({ forceSubmit: true })).rejects.toBeInstanceOf(JudgmentPortMissingError);
      const after = await manager.getJob(job.id);
      expect(after?.status).toBe('queued');
      expect(after?.attempts).toBe(0);
    } finally {
      installJudgmentPort(previous);
    }
  });
});
