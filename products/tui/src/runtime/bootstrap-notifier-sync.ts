import { Notifier, type WebhookNotifier } from '@goodvibes-jev/engine/sdk/platform/integrations';
import { readNotificationsMetadataOnly, type NotificationDelivery, type TurnNotificationFacts } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import { createUiRuntimeEvents } from '@goodvibes-jev/engine/sdk/platform/runtime/ui';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { formatTurnBudgetOutcome } from '../core/turn-budget-outcome.ts';
import type { createDomainDispatch } from './store/index.ts';

type DomainDispatch = ReturnType<typeof createDomainDispatch>;

/**
 * Reflect the notifier's outbound delivery queues into the integrations domain
 * (so the UI shows per-channel health) and attach the notifier to the runtime
 * bus when any queue exists. Extracted from bootstrap-core to keep that file
 * within the module size budget.
 */
export function syncNotifierQueueIntegrations(
  notifier: Notifier,
  runtimeBus: RuntimeEventBus,
  domainDispatch: DomainDispatch,
): () => void {
  const queueStatuses = notifier.getQueueStatus();
  if (queueStatuses.length === 0) return () => {};
  const unsubscribe = attachTypedRuntimeNotifications(notifier, runtimeBus);
  for (const queueStatus of queueStatuses) {
    domainDispatch.syncIntegration({
      id: queueStatus.channel,
      displayName: queueStatus.channel[0]!.toUpperCase() + queueStatus.channel.slice(1),
      category: 'communication',
      status: queueStatus.metrics.deadLettered > 0 ? 'degraded' : 'healthy',
      enabled: true,
      successCount: queueStatus.metrics.delivered,
      errorCount: queueStatus.metrics.deadLettered,
      ...(queueStatus.dlqEntries[0]?.deadAt ? { lastErrorAt: queueStatus.dlqEntries[0].deadAt } : {}),
      ...(queueStatus.dlqEntries[0]?.finalError ? { lastError: queueStatus.dlqEntries[0].finalError } : {}),
      meta: {
        attempts: queueStatus.metrics.totalAttempts,
        retrying: queueStatus.metrics.retrying,
        deadLetters: queueStatus.metrics.deadLettered,
        dlqSize: queueStatus.metrics.dlqSize,
        sloEnforced: queueStatus.sloEnforced,
      },
    }, 'bootstrap.notifier');
  }
  return unsubscribe;
}

/**
 * The Slack and Discord notifier, built from the configured services. Its
 * agent and workstream notices name the task unless
 * behavior.notificationsMetadataOnly is on; the setting is read at send time,
 * so a change applies without a restart.
 */
export function createRuntimeNotifier(
  serviceRegistry: Parameters<typeof Notifier.fromConfig>[0],
  configGet: (key: string) => unknown,
): Promise<Notifier> {
  return Notifier.fromConfig(serviceRegistry, {
    metadataOnly: () => readNotificationsMetadataOnly(configGet),
  });
}

/**
 * This host supplies facts to the SDK's delivery owner instead of attaching its
 * legacy string formatter. A fact's content getters run only at rich admission;
 * the SDK snapshots them synchronously and owns privacy changes across recipients,
 * retries and dead letters. No event object or getter enters a delivery queue.
 * Contract endings and agent cancellation carry no duration. They notify only
 * when this adapter observed the start, rather than inventing a zero duration.
 */
export function attachTypedRuntimeNotifications(
  notifier: Notifier | WebhookNotifier,
  runtimeBus: RuntimeEventBus,
  clock: () => number = Date.now,
): () => void {
  let active = true;
  const events = createUiRuntimeEvents(runtimeBus);
  const names = new Map<string, { readonly started: number; readonly name: () => string }>();
  const remember = (key: string, name: () => string): void => {
    if (!active) return;
    names.delete(key);
    names.set(key, { started: clock(), name });
    while (names.size > 256) names.delete(names.keys().next().value!);
  };
  const take = (key: string) => {
    const value = names.get(key);
    names.delete(key);
    return value;
  };
  const send = (facts: TurnNotificationFacts): void => {
    if (!active) return;
    const delivery: NotificationDelivery = { kind: 'turn', facts };
    const pending = 'notifyNotification' in notifier
      ? notifier.notifyNotification(delivery) : notifier.sendNotification(delivery);
    void pending.catch(() => logger.debug('runtime notification delivery failed'));
  };
  const unsubs = [
    events.agents.on('AGENT_SPAWNING', (payload) => remember(`agent:${payload.agentId}`, () => payload.task)),
    events.agents.on('AGENT_COMPLETED', (payload) => {
      const work = take(`agent:${payload.agentId}`);
      send({ outcome: 'completed', subject: 'agent', elapsedMs: payload.durationMs,
        toolCalls: payload.toolCallsMade, get name() { return work?.name() ?? payload.output; } });
    }),
    events.agents.on('AGENT_FAILED', (payload) => {
      const work = take(`agent:${payload.agentId}`);
      send({ outcome: 'failed', subject: 'agent', elapsedMs: payload.durationMs,
        get name() { return work?.name(); }, get reason() { return payload.error; } });
    }),
    events.agents.on('AGENT_CANCELLED', (payload) => {
      const work = take(`agent:${payload.agentId}`);
      if (!work) return; // The public fact contract cannot represent an unknown elapsed time.
      send({ outcome: 'cancelled', subject: 'agent', elapsedMs: Math.max(0, clock() - work.started),
        get name() { return work?.name(); }, get reason() { return payload.reason; } });
    }),
    events.contracts.on('CONTRACT_CREATED', (payload) => remember(`contract:${payload.contractId}`, () => payload.ask)),
    events.contracts.on('CONTRACT_PASSED', (payload) => {
      const work = take(`contract:${payload.contractId}`);
      if (!work) return; // The public fact contract cannot represent an unknown elapsed time.
      send({ outcome: 'completed', subject: 'contract', elapsedMs: Math.max(0, clock() - work.started),
        get name() { return work?.name(); } });
    }),
    events.contracts.on('CONTRACT_FAILED', (payload) => {
      const work = take(`contract:${payload.contractId}`);
      if (!work) return; // The public fact contract cannot represent an unknown elapsed time.
      send({ outcome: 'failed', subject: 'contract', elapsedMs: Math.max(0, clock() - work.started),
        get name() { return work?.name(); },
        get reason() {
          return payload.failureKind === 'max_turns'
            ? formatTurnBudgetOutcome({ limit: payload.turnLimit, source: payload.turnLimitSource })
            : payload.failureKind === 'transport' ? 'transient transport error' : payload.reason;
        } });
    }),
    events.contracts.on('CONTRACT_CANCELLED', (payload) => {
      const work = take(`contract:${payload.contractId}`);
      if (!work) return; // The public fact contract cannot represent an unknown elapsed time.
      send({ outcome: 'cancelled', subject: 'contract', elapsedMs: Math.max(0, clock() - work.started),
        filesChanged: payload.filesModified,
        get name() { return work?.name(); }, get reason() { return payload.reason; } });
    }),
  ];
  return () => { active = false; for (const unsubscribe of unsubs) unsubscribe(); names.clear(); };
}
