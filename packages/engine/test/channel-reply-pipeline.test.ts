import { describe, expect, test } from 'bun:test';
import { ChannelPluginRegistry } from '../sdk/src/platform/channels/plugin-registry.js';
import { ChannelReplyPipeline } from '../sdk/src/platform/channels/reply-pipeline.js';
import { DaemonSurfaceDeliveryHelper } from '../sdk/src/platform/daemon/surface-delivery.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { emitAgentCompleted, emitAgentSpawning } from '../sdk/src/platform/runtime/emitters/agents.js';
import {
  emitContractChecked,
  emitContractCreated,
  emitContractPassed,
} from '../sdk/src/platform/runtime/emitters/contract.js';

/** A deliverable check over two criteria, passed or not. */
function deliverableCheck(contractId: string, passed: boolean) {
  return {
    contractId,
    scope: 'deliverable' as const,
    targetId: contractId,
    checkId: `${contractId}.k1`,
    trigger: 'completion' as const,
    result: passed ? 'pass' as const : 'nudge' as const,
    criteria: [
      { criterionId: 'c1', verdict: 'met' as const, probabilityUnmet: 0.04, outcome: 'act' as const },
      { criterionId: 'c2', verdict: passed ? 'met' as const : 'unmet' as const, probabilityUnmet: passed ? 0.06 : 0.88, outcome: 'act' as const },
    ],
    goal: { verdict: passed ? 'met' as const : 'unmet' as const, outcome: 'act' as const },
    quality: [],
    gates: [],
    decisionIds: [],
  };
}

function passedPayload(contractId: string) {
  return { contractId, criteriaMet: 2, criteriaJudged: 2, excluded: 0, nudges: 1 };
}
import { waitFor } from './_helpers/test-timeout.js';

describe('ChannelReplyPipeline', () => {
  test('routes child-agent completion status to the parent ntfy reply target', async () => {
    const runtimeBus = new RuntimeEventBus();
    const channelPlugins = new ChannelPluginRegistry();
    const delivered: string[] = [];
    channelPlugins.register({
      id: 'ntfy-test',
      surface: 'ntfy',
      displayName: 'ntfy',
      capabilities: ['egress'],
      deliverReply: async (_pending, message) => {
        delivered.push(message);
      },
    });
    const pipeline = new ChannelReplyPipeline({
      channelPlugins,
      routeBindings: {
        captureReplyTarget: async () => {},
      } as never,
      runtimeBus,
    });

    try {
      pipeline.trackPending({
        agentId: 'agent-parent',
        surfaceKind: 'ntfy',
        task: 'parent task',
        createdAt: Date.now(),
        routeId: 'route-1',
      });

      emitAgentSpawning(runtimeBus, {
        sessionId: 'agent-manager',
        traceId: 'test:spawn-child',
        source: 'test',
      }, {
        agentId: 'agent-child',
        parentAgentId: 'agent-parent',
        task: 'child task',
      });
      emitAgentCompleted(runtimeBus, {
        sessionId: 'agent-manager',
        traceId: 'test:complete-child',
        source: 'test',
      }, {
        agentId: 'agent-child',
        durationMs: 5,
        output: 'child done',
      });

      await waitFor(() => delivered.length === 1);
      // The answer is the point of the notification, on ntfy as anywhere else,
      // and it is the WHOLE notification. How long the run took is operator
      // telemetry that no channel user receives.
      expect(delivered[0]).toContain('child done');
      expect(delivered[0]).not.toContain('Agent completed in');
      expect(pipeline.has('agent-child')).toBe(false);
      expect(pipeline.has('agent-parent')).toBe(true);
    } finally {
      pipeline.dispose();
    }
  });

  test('keeps ntfy contract replies active for contract progress after the root agent completes', async () => {
    const runtimeBus = new RuntimeEventBus();
    const channelPlugins = new ChannelPluginRegistry();
    const delivered: Array<{ kind: 'reply' | 'progress'; message: string }> = [];
    channelPlugins.register({
      id: 'ntfy-test',
      surface: 'ntfy',
      displayName: 'ntfy',
      capabilities: ['egress'],
      deliverReply: async (_pending, message) => {
        delivered.push({ kind: 'reply', message });
      },
      deliverProgress: async (_pending, message) => {
        delivered.push({ kind: 'progress', message });
      },
    });
    const pipeline = new ChannelReplyPipeline({
      channelPlugins,
      routeBindings: {
        captureReplyTarget: async () => {},
      } as never,
      runtimeBus,
    });

    try {
      pipeline.trackPending({
        agentId: 'agent-root',
        surfaceKind: 'ntfy',
        task: 'phone task',
        agentTask: 'expanded contract task',
        contractId: 'ctr-1',
        // A minute in: old enough that the contract's later legs may notify.
        createdAt: Date.now() - 60_000,
        routeId: 'route-1',
      });

      emitAgentCompleted(runtimeBus, {
        sessionId: 'agent-manager',
        traceId: 'test:complete-root',
        source: 'test',
      }, {
        agentId: 'agent-root',
        durationMs: 5,
        output: 'root output the owner asked for',
      });

      await waitFor(() => delivered.some((entry) => entry.kind === 'reply'));
      expect(delivered[0]?.message).toContain('root output the owner asked for');
      expect(delivered[0]?.message).not.toContain('Agent completed in');
      expect(pipeline.has('agent-root')).toBe(true);

      emitContractChecked(runtimeBus, {
        sessionId: 's1',
        traceId: 'test:review',
        source: 'test',
      }, deliverableCheck('ctr-1', false));

      // Plain words, and no contract id: the line names the outcome, not the machinery.
      await waitFor(() => delivered.some((entry) => entry.kind === 'progress' && entry.message.includes('found things to fix')));

      emitContractPassed(runtimeBus, {
        sessionId: 's1',
        traceId: 'test:passed',
        source: 'test',
      }, passedPayload('ctr-1'));

      await waitFor(() => delivered.some((entry) => entry.kind === 'reply' && entry.message.includes('is done')));
      // The id this run correlated on never reaches the reader.
      expect(delivered.every((entry) => !entry.message.includes('ctr-1'))).toBe(true);
      expect(pipeline.has('agent-root')).toBe(false);
    } finally {
      pipeline.dispose();
    }
  });

  test('associates contract replies by agent task when CONTRACT_CREATED is observed after tracking', async () => {
    const runtimeBus = new RuntimeEventBus();
    const channelPlugins = new ChannelPluginRegistry();
    const delivered: string[] = [];
    channelPlugins.register({
      id: 'ntfy-test',
      surface: 'ntfy',
      displayName: 'ntfy',
      capabilities: ['egress'],
      deliverProgress: async (_pending, message) => {
        delivered.push(message);
      },
    });
    const pipeline = new ChannelReplyPipeline({
      channelPlugins,
      routeBindings: {
        captureReplyTarget: async () => {},
      } as never,
      runtimeBus,
    });

    try {
      pipeline.trackPending({
        agentId: 'agent-root',
        surfaceKind: 'ntfy',
        task: 'phone task',
        agentTask: 'expanded contract task',
        // A minute in. Progress notifications are withheld below the
        // MIN_PROGRESS_NOTIFICATION_AGE_MS floor, and a contract opening on a
        // run this old is exactly the case the floor is meant to let through.
        createdAt: Date.now() - 60_000,
        routeId: 'route-1',
      });

      emitContractCreated(runtimeBus, {
        sessionId: 's1',
        traceId: 'test:created',
        source: 'test',
      }, {
        contractId: 'ctr-2',
        sessionId: 's1',
        origin: 'agent-tool',
        ask: 'expanded contract task',
        ownerAgentId: 'owner-2',
      });

      await waitFor(() => delivered.some((message) => message.includes('Started work on: expanded contract task')));
      expect(delivered.every((message) => !message.includes('ctr-2'))).toBe(true);
      expect(pipeline.getPending('agent-root')?.contractId).toBe('ctr-2');
    } finally {
      pipeline.dispose();
    }
  });

  test('associates a contract with the reply tracking its owner agent, whatever the ask says', async () => {
    const runtimeBus = new RuntimeEventBus();
    const channelPlugins = new ChannelPluginRegistry();
    const delivered: string[] = [];
    channelPlugins.register({
      id: 'ntfy-test',
      surface: 'ntfy',
      displayName: 'ntfy',
      capabilities: ['egress'],
      deliverProgress: async (_pending, message) => {
        delivered.push(message);
      },
    });
    const pipeline = new ChannelReplyPipeline({
      channelPlugins,
      routeBindings: { captureReplyTarget: async () => {} } as never,
      runtimeBus,
    });
    try {
      pipeline.trackPending({
        agentId: 'owner-3',
        surfaceKind: 'ntfy',
        task: 'phone task',
        createdAt: Date.now() - 60_000,
        routeId: 'route-1',
      });
      pipeline.trackPending({
        agentId: 'agent-other',
        surfaceKind: 'ntfy',
        task: 'the ask, word for word',
        createdAt: Date.now() - 60_000,
        routeId: 'route-2',
      });
      emitContractCreated(runtimeBus, { sessionId: 's1', traceId: 'test:created-owner', source: 'test' }, {
        contractId: 'ctr-3',
        sessionId: 's1',
        origin: 'turn',
        ask: 'the ask, word for word',
        ownerAgentId: 'owner-3',
      });
      await waitFor(() => pipeline.getPending('owner-3')?.contractId === 'ctr-3');
      // The owner's own reply wins over a reply that merely shares the ask's words.
      expect(pipeline.getPending('agent-other')?.contractId).toBeUndefined();
    } finally {
      pipeline.dispose();
    }
  });

  test('daemon ntfy polling keeps contract reply tracking alive after the root agent completes', async () => {
    const runtimeBus = new RuntimeEventBus();
    const channelPlugins = new ChannelPluginRegistry();
    const delivered: Array<{ kind: 'reply' | 'progress'; message: string }> = [];
    channelPlugins.register({
      id: 'ntfy-test',
      surface: 'ntfy',
      displayName: 'ntfy',
      capabilities: ['egress'],
      deliverReply: async (_pending, message) => {
        delivered.push({ kind: 'reply', message });
      },
      deliverProgress: async (_pending, message) => {
        delivered.push({ kind: 'progress', message });
      },
    });
    const pipeline = new ChannelReplyPipeline({
      channelPlugins,
      routeBindings: {
        captureReplyTarget: async () => {},
      } as never,
      runtimeBus,
      // The helper stamps `createdAt` itself, so the clock is what moves: the
      // contract's check lands a minute into the run, past the floor below which
      // no progress notification is warranted.
      now: () => Date.now() + 60_000,
    });
    const pendingSurfaceReplies = new Map();
    const helper = new DaemonSurfaceDeliveryHelper({
      pendingSurfaceReplies,
      channelReplyPipeline: pipeline,
      configManager: { get: () => '' },
      serviceRegistry: { resolveSecret: async () => null },
      agentManager: {
        getStatus: () => ({
          id: 'agent-root',
          status: 'completed',
          task: 'expanded contract task',
          fullOutput: 'The duplicate header read is gone and the parser tests pass.',
          tools: [],
          startedAt: Date.now(),
          contractId: 'ctr-1',
        }),
      },
      sessionBroker: { completeAgent: async () => null },
      routeBindings: {},
      channelPlugins,
      authToken: () => null,
      surfaceDeliveryEnabled: () => true,
    } as unknown as ConstructorParameters<typeof DaemonSurfaceDeliveryHelper>[0]);

    try {
      helper.queueSurfaceReplyFromBinding({
        id: 'route-1',
        surfaceKind: 'ntfy',
        surfaceId: 'ntfy',
        externalId: 'goodvibes-agent',
        channelId: 'goodvibes-agent',
        metadata: {},
      } as never, {
        agentId: 'agent-root',
        task: 'phone task',
        agentTask: 'expanded contract task',
        contractId: 'ctr-1',
        sessionId: 'session-1',
      });

      await helper.pollPendingSurfaceReplies(() => {});

      // ntfy renders what every other surface renders: the agent's answer.
      // This used to assert the opposite, that the output was withheld and a
      // canned "Agent <id> finished initial work" line went out in its place,
      // which is how the owner's primary surface came to deliver everything
      // except the reply. Tracking still stays alive for the contract's later legs.
      expect(delivered[0]?.message).toContain('The duplicate header read is gone');
      expect(delivered[0]?.message).not.toContain('finished initial work');
      expect(pipeline.has('agent-root')).toBe(true);

      emitContractChecked(runtimeBus, {
        sessionId: 's1',
        traceId: 'test:review-after-poll',
        source: 'test',
      }, deliverableCheck('ctr-1', true));

      await waitFor(() => delivered.some((entry) => entry.kind === 'progress' && entry.message.includes('The check of') && entry.message.includes('passed')));
      expect(pipeline.has('agent-root')).toBe(true);

      emitContractPassed(runtimeBus, {
        sessionId: 's1',
        traceId: 'test:passed-after-poll',
        source: 'test',
      }, passedPayload('ctr-1'));

      await waitFor(() => delivered.some((entry) => entry.kind === 'reply' && entry.message.includes('is done')));
      expect(delivered.every((entry) => !entry.message.includes('ctr-1'))).toBe(true);
      expect(pipeline.has('agent-root')).toBe(false);
    } finally {
      pipeline.dispose();
    }
  });
});
