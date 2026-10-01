/**
 * thinking-overlay.ts, what main is doing for the throbber (the row above the
 * input area) and its honest stall clock, extracted from main.ts's render loop.
 *
 * The SDK orchestrator surfaces no lastDeltaAtMs / reconnect signal directly, so
 * ThinkingStallClock derives a per-turn last-delta clock from streaming
 * output-token advances, a real, honest proxy that degrades gracefully with
 * zero new SDK events. buildThrobberState turns that, the running tool call,
 * a pending approval and a running compaction into the throbber's state
 * (renderer/throbber.ts); buildThinkingOverlay keeps only the opt-in partial
 * tool preview as a faint row under the transcript.
 */

import { UIFactory, type ThinkingStallInfo } from '../renderer/ui-factory.ts';
import { resolveThrobberActivity, type ThrobberState, type ThrobberToolCall } from '../renderer/throbber.ts';
import { trackActiveTool, type ActiveToolCall } from './active-tool-tracker.ts';
import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';
import type { Orchestrator } from '@goodvibes-jev/engine/sdk/platform/core';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';

/**
 * Per-turn last-delta clock. tick() seeds at turn start, then pushes the clock
 * forward whenever the streaming output-token count advances; reset() clears it
 * so the next turn re-seeds. Suppresses stall detection while a tool is active
 * (the model isn't producing tokens then, a "Stalled" label would be a false
 * positive).
 */
export class ThinkingStallClock {
  private startedAt: number | null = null;
  private lastDeltaAt = 0;
  private lastOutputTokens = 0;

  tick(streamingOutputTokens: number, toolActive: boolean, nowMs: number): ThinkingStallInfo | undefined {
    if (this.startedAt === null) {
      this.startedAt = nowMs;
      this.lastDeltaAt = nowMs;
      this.lastOutputTokens = streamingOutputTokens;
    } else if (streamingOutputTokens > this.lastOutputTokens) {
      this.lastDeltaAt = nowMs;
      this.lastOutputTokens = streamingOutputTokens;
    }
    return UIFactory.computeRenderStallInfo({ toolActive, lastDeltaAtMs: this.lastDeltaAt, nowMs });
  }

  reset(): void {
    this.startedAt = null;
  }

  /** Ms since the turn started, undefined before the first tick. */
  elapsed(nowMs: number): number | undefined {
    return this.startedAt === null ? undefined : Math.max(0, nowMs - this.startedAt);
  }
}

export interface ThinkingOverlayDeps {
  readonly orchestrator: Pick<Orchestrator,
    'isThinking' | 'getSpinner' | 'thinkingFrame' | 'streamingInputTokens' | 'streamingOutputTokens'>;
  readonly configManager: Pick<ConfigManager, 'get'>;
  /** The raw snapshot tool preview (a truthy value means a tool is executing). */
  readonly streamToolPreview: string | undefined;
  readonly streamTokenSpeed: number;
  readonly approvalPending: boolean;
  readonly width: number;
  readonly clock: ThinkingStallClock;
}

export interface ThrobberDeps extends ThinkingOverlayDeps {
  /** The permission prompt main's turn is blocked on (not one brokered for a background agent). */
  readonly pendingApproval: ThrobberToolCall | null;
  /** The tool call main is running now (active-tool-tracker.ts). */
  readonly activeTool: ActiveToolCall | null;
  /** A compaction of the main conversation is running. */
  readonly compacting: boolean;
  /** When the running compaction was first seen (epoch ms). */
  readonly compactingSinceMs?: number;
}

/**
 * The throbber's state while main works (a turn, a compaction), or null at
 * rest. An idle turn resets the stall clock so the next turn re-seeds. The
 * stall and approval signals decide the honest waiting phrase.
 */
export function buildThrobberState(deps: ThrobberDeps): ThrobberState | null {
  const now = Date.now();
  const turnActive = deps.orchestrator.isThinking;
  if (!turnActive) deps.clock.reset();
  const toolActive = !!deps.streamToolPreview || deps.activeTool !== null;
  const stallInfo = turnActive ? deps.clock.tick(deps.orchestrator.streamingOutputTokens, toolActive, now) : undefined;
  const elapsed = turnActive ? deps.clock.elapsed(now) : undefined;
  const showSpeed = deps.configManager.get('display.showTokenSpeed') as boolean;
  const activity = resolveThrobberActivity({
    turnActive,
    compacting: deps.compacting,
    compactingSinceMs: deps.compactingSinceMs,
    pendingApproval: deps.pendingApproval,
    activeTool: deps.activeTool,
    modelPhrase: UIFactory.busyPhrase(deps.orchestrator.thinkingFrame, deps.orchestrator.streamingOutputTokens, stallInfo, deps.approvalPending),
    turnStartMs: elapsed !== undefined ? now - elapsed : undefined,
    tokenSpeed: showSpeed ? deps.streamTokenSpeed : undefined,
    now,
  });
  return activity ? { spinner: deps.orchestrator.getSpinner(), frame: deps.orchestrator.thinkingFrame, activity } : null;
}

/**
 * The transcript rows a running turn adds: only the opt-in partial tool
 * preview (display.showToolPreview), faint. [] when idle or when the preview
 * is off; the spinner and phrase are the throbber's.
 */
export function buildThinkingOverlay(deps: ThinkingOverlayDeps): Line[] {
  if (!deps.orchestrator.isThinking) return [];
  const showPreview = deps.configManager.get('display.showToolPreview') as boolean;
  if (!showPreview || !deps.streamToolPreview) return [];
  return [UIFactory.createToolPreviewRow(deps.width, deps.streamToolPreview)];
}

/** A permission ask as the throbber reads it. */
interface PermissionAsk {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /** Set when the ask was brokered for a background agent (not main's own). */
  readonly attribution?: unknown;
}

/** Main's own permission ask, or null (an ask brokered for a background agent is not main's activity). */
export function mainPermissionAsk<T extends PermissionAsk>(ask: T | null): T | null {
  return ask && ask.attribution === undefined ? ask : null;
}

/** The throbber's per-frame source: the running tool call and the compaction clock, kept between frames. */
export interface ThrobberSource {
  state(deps: ThinkingOverlayDeps & { readonly pendingApproval: PermissionAsk | null }): ThrobberState | null;
  readonly unsubs: ReadonlyArray<() => void>;
}

export function createThrobberSource(tools: Parameters<typeof trackActiveTool>[0], isCompacting: () => boolean): ThrobberSource {
  const activeTool = trackActiveTool(tools);
  // When the running compaction was first seen (its elapsed time); undefined while none runs.
  let compactingSinceMs: number | undefined;
  return {
    unsubs: activeTool.unsubs,
    state: (deps) => {
      const compacting = isCompacting();
      if (compacting && compactingSinceMs === undefined) compactingSinceMs = Date.now();
      else if (!compacting) compactingSinceMs = undefined;
      if (!deps.orchestrator.isThinking) activeTool.clear();
      const ask = deps.pendingApproval;
      return buildThrobberState({
        ...deps,
        pendingApproval: ask ? { name: ask.tool, args: ask.args } : null,
        activeTool: activeTool.current(),
        compacting,
        compactingSinceMs,
      });
    },
  };
}
