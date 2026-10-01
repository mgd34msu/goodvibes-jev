/**
 * conversation-render-context.ts, the inputs a transcript row render reads,
 * and the small pure derivations over them.
 *
 * Kept apart from conversation-rendering.ts (which draws) so that both the
 * drawing module and the per-row modules that hang off it can depend on the
 * SHAPE of a render without depending on each other. Every import here is
 * type-only, which is what makes this a leaf of the import graph.
 */

import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';
import type { SplashOptions } from '../utils/splash-lines.ts';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ConversationMessageSnapshot } from '@goodvibes-jev/engine/sdk/platform/core';
import type { BlockMeta } from './conversation-types.ts';
import type { WorkTreeSources } from './work-tree-sources.ts';
import type { TreeGlyphSetName } from '../renderer/lane-graph/glyphs.ts';

type Message = ConversationMessageSnapshot;

/**
 * How a tool call settled, as read from the result message it produced.
 *
 * The transcript stores a failure as content leading with `Error: ` (see the
 * SDK's ConversationManager.addToolResults), and a per-call user cancellation
 * as the more specific `Error: cancelled by user`. Reading the outcome,
 * rather than only "did a result arrive", is what lets the CALL row show
 * ✓ / ✕ / ⊘ honestly instead of a ✓ that means nothing more than "it finished".
 */
export type ToolCallOutcome = 'ok' | 'error' | 'cancelled';

function outcomeOfToolContent(content: string): ToolCallOutcome {
  if (/^Error: cancelled by user\b/.test(content)) return 'cancelled';
  if (/^Error: /.test(content)) return 'error';
  return 'ok';
}

/**
 * Collect, per tool-call id, how that call settled, for the calls that have a
 * matching tool-result message in this slice. A call absent from the map has
 * not run yet and renders in flight.
 */
export function collectToolCallOutcomes(messages: readonly Message[]): Map<string, ToolCallOutcome> {
  const outcomes = new Map<string, ToolCallOutcome>();
  for (const message of messages) {
    if (message.role === 'tool' && message.callId) {
      outcomes.set(message.callId, outcomeOfToolContent(message.content));
    }
  }
  return outcomes;
}

/**
 * Ids of tool calls that have a matching tool-result message in this slice,
 * the calls that actually ran. Everything else is still in flight. Derived
 * from collectToolCallOutcomes so the two can never disagree about "ran".
 */
export function collectCompletedToolCallIds(messages: readonly Message[]): Set<string> {
  return new Set(collectToolCallOutcomes(messages).keys());
}

export interface ConversationRenderContext {
  readonly history: {
    addLine: (line: Line) => void;
    addLines: (lines: Line[]) => void;
    getLineCount: () => number;
  };
  readonly blockRegistry: BlockMeta[];
  readonly collapseState: Map<string, boolean>;
  readonly errorLineRegistry: number[];
  readonly configManager: ConfigManager | null;
  readonly splashOptions: SplashOptions;
  /**
   * 'elsewhere' for the main transcript: its system notices ([WRFC] …,
   * [Agents] …, compaction receipts) are toasts and notification-history
   * entries (core/notices.ts), so no row is drawn for them. Absent (an agent
   * view drawing a sub-agent's own conversation): drawn after the turn.
   */
  readonly systemNotices?: 'elsewhere' | undefined;
  /**
   * Tool-call ids that have a matching tool-result message (i.e. the call
   * actually ran). A call whose id is NOT in this set has not settled yet and
   * renders with the pending glyph instead of the completed ✓, so a turn in
   * progress looks in progress. Undefined (single-message callers with no
   * sibling context) renders every call as done, the prior behaviour.
   */
  readonly completedToolCallIds?: ReadonlySet<string>;
  /**
   * How each settled tool call turned out, keyed by call id (see
   * collectToolCallOutcomes). Lets a call row show ✕ for a failure and ⊘ for a
   * cancellation instead of a blanket ✓ the moment any result arrives. When
   * undefined the row falls back to completedToolCallIds' ran/not-ran split.
   */
  readonly toolCallOutcomes?: ReadonlyMap<string, ToolCallOutcome>;
  /**
   * Live facts the work tree draws that the transcript does not carry: call
   * and turn timings, spawned agents' lanes, the call a permission prompt is
   * holding. Undefined draws the work tree without them (no times, no agent
   * lanes).
   */
  readonly workTreeSources?: WorkTreeSources;
  /** Glyph set for the work tree (display.treeGlyphs, ascii on a limited terminal). */
  readonly treeGlyphSet?: TreeGlyphSetName;
  /** Focused work-tree row id while the keyboard is in the work tree. */
  readonly focusId?: string | null;
  /** Spinner frame for running beads. */
  readonly frame?: number;
}
