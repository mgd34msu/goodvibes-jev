// ---------------------------------------------------------------------------
// fleet-steer.ts
//
// Steer-badge rendering helpers and delivery-unknown
// reconciliation pass, split out of src/input/agents-modal.ts to keep that file under
// the architecture line cap (see check-architecture.ts's 800-line gate).
// Pure functions only; the Agents modal still owns the mutable FleetTab.steerBadge
// state itself (see fleet-session-tabs.ts's SteerBadge doc) and calls into this
// module rather than duplicating the logic inline.
// ---------------------------------------------------------------------------

import { STEER_TTL_MS, type ProcessNode, type ProcessKind, type SteerResult } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import { isTerminalProcessState } from './fleet-read-model.ts';
import type { FleetTab, SteerBadge, SteerBadgeStatus } from './fleet-session-tabs.ts';
import { buildViewLine, DEFAULT_VIEW_PALETTE, type ViewPalette } from './polish.ts';
import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';

/** Linger before an explicitly resolved (consumed/dropped) steer badge is cleared from the tab. */
export const STEER_BADGE_LINGER_MS = 4_000;

export function steerBadgeGlyph(status: SteerBadgeStatus): string {
  switch (status) {
    case 'queued': return '⧗';
    case 'accepted': return '↗';
    case 'unknown': return '?';
    case 'consumed': return '✓';
    case 'dropped': return '⚠';
  }
}

export function steerBadgeTone(status: SteerBadgeStatus, palette: ViewPalette): string {
  switch (status) {
    case 'queued': return palette.warn ?? DEFAULT_VIEW_PALETTE.warn;
    case 'accepted': return palette.info;
    case 'unknown': return palette.warn ?? DEFAULT_VIEW_PALETTE.warn;
    case 'consumed': return palette.good ?? DEFAULT_VIEW_PALETTE.good;
    case 'dropped': return palette.bad ?? DEFAULT_VIEW_PALETTE.bad;
  }
}

/** Labels of the currently live, steerable agent nodes other than `excludeNodeId`, offered when a steer target has gone inactive (WO item 4). */
export function liveSteerableLabels(nodes: readonly ProcessNode[], excludeNodeId: string): string[] {
  return nodes
    .filter((node) => node.id !== excludeNodeId && node.kind === 'agent' && node.capabilities.steerable && !isTerminalProcessState(node.state))
    .map((node) => node.label);
}

/** Refusal message for a steer that could not be queued: states why + preserves the draft + suggests live targets. */
export function steerRefusalMessage(reason: string, siblingLabels: readonly string[]): string {
  const suggestion = siblingLabels.length > 0
    ? ` Draft kept: steerable now: ${siblingLabels.slice(0, 3).join(', ')}${siblingLabels.length > 3 ? '…' : ''}.`
    : ' Draft kept: no other agents are currently steerable.';
  return `${reason}.${suggestion}`;
}

/** Only receipts backed by the message bus receive its delivery/expiry tracking. */
export function steerBadgeFromReceipt(
  result: Extract<SteerResult, { readonly queued: true }>,
  kind: ProcessKind | undefined,
  now: number,
): SteerBadge {
  if (result.woke) return { messageId: result.messageId, status: 'accepted', acceptedVia: 'wake' };
  if (kind === 'acp-agent') return { messageId: result.messageId, status: 'accepted', acceptedVia: 'acp-host' };
  if (kind === 'agent' || kind === 'contract-unit') return { messageId: result.messageId, status: 'queued', queuedAt: now };
  return { messageId: result.messageId, status: 'accepted', acceptedVia: 'runtime' };
}

export function steerReceiptLabel(badge: SteerBadge, targetLabel?: string): string {
  const forTarget = targetLabel ? ` for ${targetLabel}` : '';
  if (badge.status === 'accepted') {
    const origin = badge.acceptedVia === 'acp-host' ? 'ACP host accepted the steer'
      : badge.acceptedVia === 'wake' ? 'Wake accepted' : 'Runtime accepted the steer';
    return `${origin}; delivery unknown${forTarget}.`;
  }
  if (badge.status === 'unknown') return `Steer delivery unknown: ${badge.note ?? 'awaiting consumption acknowledgement'}.`;
  if (badge.status === 'queued') return `Steer queued; the delivery badge tracks consumption${forTarget}.`;
  if (badge.status === 'consumed') return 'Steer consumed';
  return `Steer dropped: ${badge.note ?? 'no reason supplied'}`;
}

/** One receipt label shared by the actual modal and standalone line renderer. */
export function renderSteerBadgeLine(badge: SteerBadge, width: number, palette: ViewPalette, targetLabel?: string): Line {
  return buildViewLine(width, [
    [' ', palette.dim],
    [steerBadgeGlyph(badge.status), steerBadgeTone(badge.status, palette)],
    [` ${steerReceiptLabel(badge, targetLabel)}`, palette.dim],
  ]);
}

/**
 * Missing acknowledgement is not proof of non-delivery. Keep one uncertain
 * receipt per tab for a late acknowledgement, bounded by replacement/tab close.
 * Only explicit terminal receipt states use the short display linger.
 */
export function reconcileSteerBadges(
  tabs: readonly FleetTab[],
  findLiveNode: (nodeId: string) => ProcessNode | null,
  now: number,
): boolean {
  let changed = false;
  for (const tab of tabs) {
    const badge = tab.steerBadge;
    if (!badge) continue;
    if (badge.status === 'queued') {
      const node = findLiveNode(tab.nodeId);
      if (!node || isTerminalProcessState(node.state)) {
        tab.steerBadge = {
          ...badge,
          status: 'unknown',
          note: node
            ? `the ${node.kind} went ${node.state} without a consumption acknowledgement`
            : 'the target is no longer tracked',
        };
        changed = true;
      } else if (badge.queuedAt !== undefined && now - badge.queuedAt > STEER_TTL_MS) {
        // The runner can drain a message before its model call completes and
        // emits the acknowledgement. The bus TTL is not delivery evidence.
        tab.steerBadge = {
          ...badge,
          status: 'unknown',
          note: 'no consumption acknowledgement before the tracking deadline',
        };
        changed = true;
      }
    } else if ((badge.status === 'consumed' || badge.status === 'dropped') && badge.resolvedAt !== undefined && now - badge.resolvedAt > STEER_BADGE_LINGER_MS) {
      tab.steerBadge = null;
      changed = true;
    }
  }
  return changed;
}
