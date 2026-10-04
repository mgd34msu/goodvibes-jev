/**
 * SystemMessageRouter, routes system messages to the right surfaces.
 *
 * Every message lands in the ActivityFeed (the ambient "Recent" record shown
 * in the Activity modal). High-priority messages, errors, confirmations the
 * user explicitly caused, session lifecycle, additionally land in the main
 * conversation so they are impossible to miss.
 *
 * Two tiers:
 *   - 'high', conversation AND activity feed. Use for: fatal errors,
 *     model/provider confirmations, session save/load, compaction events.
 *   - 'low' , activity feed only. Use for: scan results, provider discovery,
 *     plugin load/unload, tool execution status, permission decisions,
 *     health events, debug/operational info.
 *
 * The `ui.systemMessages` / `ui.operationalMessages` settings keep their
 * historical values ('panel' | 'conversation' | 'both'); 'panel' now means
 * "activity feed only".
 */

import type { ConversationManager } from './conversation';
import type { ActivityFeed } from './activity-feed.ts';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import {
  classifySystemMessageKind,
  classifySystemMessagePriority,
  defaultSystemMessageTarget,
  resolveSystemMessageDelivery,
  type SystemMessageKind,
  type SystemMessageTarget,
} from '@/runtime/index.ts';
import {
  classifyNoise,
  foldProviderReplayLines,
  providerNameFromReplay,
  type NoiseGateDeps,
} from './system-message-noise.ts';

export type {
  SystemMessageKind,
  SystemMessageTarget,
} from '@/runtime/index.ts';

export type SystemMessagePriority = 'high' | 'low';

/**
 * Routes system messages to the conversation and/or the ActivityFeed
 * based on priority level and per-kind targets.
 */
export class SystemMessageRouter {
  /** Buffered provider "from last session" replay lines, folded on a microtask. */
  private providerReplayBuffer: string[] = [];
  private providerReplayScheduled = false;

  constructor(
    private readonly conversation: ConversationManager,
    private feed: ActivityFeed | null,
    private readonly getTargetForKind: (kind: SystemMessageKind) => SystemMessageTarget = defaultSystemMessageTarget,
    /** Noise-gate dependencies (WRFC terminal-chain lookup). See system-message-noise.ts. */
    private readonly noiseDeps: NoiseGateDeps = {},
  ) {}

  // ── Public API ────────────────────────────────────────────────────────────────

  routeTypedSystemMessage(
    message: string,
    priority: SystemMessagePriority,
    kind: SystemMessageKind,
  ): void {
    // Noise gate, keep first-run plumbing out of the Recent feed / transcript
    // while the information stays reachable via other live surfaces (activity
    // log, /health, /model). Dropped noise is drop-from-the-feed, not delete.
    const verdict = classifyNoise(message, this.noiseDeps);
    if (verdict.action === 'drop') return;
    if (verdict.action === 'foldProviderReplay') {
      this.bufferProviderReplay(message);
      return;
    }

    const target = this.getTargetForKind(kind);
    const delivery = resolveSystemMessageDelivery(target, this.feed !== null);
    if (delivery.toPanel) {
      this.feed?.push(message, priority);
    }
    if (delivery.toConversation) {
      this.conversation.addSystemMessage(message);
    }
  }

  /**
   * Buffer a provider "from last session" replay line and schedule a microtask
   * flush. The SDK emits the whole persisted-provider burst synchronously, so a
   * single microtask captures the full burst and folds it to one quiet line.
   */
  private bufferProviderReplay(message: string): void {
    this.providerReplayBuffer.push(message);
    if (this.providerReplayScheduled) return;
    this.providerReplayScheduled = true;
    queueMicrotask(() => this.flushProviderReplay());
  }

  /**
   * Record the folded provider-replay summary to the activity log and reset the
   * buffer. The boot-only "— from last session" burst stays out of the Recent
   * feed; the persisted-provider set it summarizes is reachable on demand via
   * /health and /model, and the fold line is logged for diagnosis. Only the
   * boot burst folds, mid-session provider-discovery lines never match
   * PROVIDER_REPLAY_RE, so they still reach the feed as live product signal.
   */
  flushProviderReplay(): void {
    this.providerReplayScheduled = false;
    if (this.providerReplayBuffer.length === 0) return;
    const summary = foldProviderReplayLines(this.providerReplayBuffer);
    const providerNames = this.providerReplayBuffer.map(providerNameFromReplay);
    this.providerReplayBuffer = [];
    logger.info(summary, { count: providerNames.length, providers: providerNames });
  }

  routeSystemMessage(message: string, priority: SystemMessagePriority): void {
    this.routeTypedSystemMessage(message, priority, classifySystemMessageKind(message));
  }

  /**
   * Automatically classify the message priority by content and route.
   * Drop-in replacement for conversation.addSystemMessage().
   */
  async routeAuto(message: string): Promise<void> {
    const priority: SystemMessagePriority = await classifySystemMessagePriority(message);
    this.routeTypedSystemMessage(message, priority, classifySystemMessageKind(message));
  }

  /** High-priority shortcut, conversation + activity feed. */
  high(message: string): void {
    this.routeSystemMessage(message, 'high');
  }

  /** Direct response to a user action, always visible on the main screen once. */
  userAction(message: string): void {
    this.conversation.addSystemMessage(message);
    this.feed?.push(message, 'high');
  }

  /** Low-priority shortcut, activity feed only. */
  low(message: string): void {
    this.routeSystemMessage(message, 'low');
  }

  contract(message: string, priority: SystemMessagePriority = 'high'): void {
    this.routeTypedSystemMessage(message, priority, 'contract');
  }

  /** Returns the current activity feed reference. */
  getFeed(): ActivityFeed | null {
    return this.feed;
  }

  /**
   * Replace the feed reference after construction (late binding).
   * Pass null to detach.
   */
  setFeed(feed: ActivityFeed | null): void {
    this.feed = feed;
  }
}

/**
 * Create a SystemMessageRouter wired to the given conversation and feed.
 *
 * @param conversation - The ConversationManager for high-priority messages.
 * @param feed         - The ActivityFeed for ambient traffic. Can be null
 *                       (router still works; feed routing is dropped until
 *                       a feed is attached).
 */
export function createSystemMessageRouter(
  conversation: ConversationManager,
  feed: ActivityFeed | null = null,
  getTargetForKind: (kind: SystemMessageKind) => SystemMessageTarget = defaultSystemMessageTarget,
  noiseDeps: NoiseGateDeps = {},
): SystemMessageRouter {
  return new SystemMessageRouter(conversation, feed, getTargetForKind, noiseDeps);
}
