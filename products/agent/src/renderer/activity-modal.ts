/**
 * activity-modal.ts, what the assistant is doing and what happened, as a
 * kit modal.
 *
 *   ✦ Activity  2 agents running                                      esc
 *
 *   ▏Filter activity                                           14 entries
 *
 *   ✦ now
 *   ● Searching the web for flight prices
 *   » researcher  comparing three fares                          quiet 4m
 *   ✦ needs you
 *   ! Approval needed, answer the prompt under the conversation.
 *   ✦ coming up
 *   ◷ Morning brief at 07:30
 *   ✦ recent
 *   · Reminder sent to Telegram                                     09:12
 *
 *   ↑↓ move   ⏎ open agent
 *
 * Enter on an agent this process runs opens it full screen (its transcript,
 * its own composer; shell/session-views.ts); on the processes row, or an
 * agent running elsewhere, it opens the process monitor.
 * Every item wraps in full; the search row filters every section at once.
 * Opened with Ctrl+O, /activity, or the Agent workspace's Work area.
 */

import type { ActivityEntry, ActivityKind } from '../core/activity-feed.ts';
import { activeTokens } from './theme.ts';
import { beginModal, finishModal, scrollCountText, searchRow, type KitHint, type SurfaceLayer } from './surface-kit.ts';
import { drawList, type KitRow } from './surface-kit-list.ts';
import { drawTextBlock } from './surface-kit-extra.ts';

export interface ActivityNow {
  /** True while a turn is streaming or tools are running. */
  readonly busy: boolean;
  /** Short human label for the current work, e.g. "Searching the web…". */
  readonly label?: string;
  /**
   * Background agents with their latest progress lines. `headline` is the
   * fleet read-model's per-node headline (derived from task/phase identity
   * only, replaced in place, never a feed) and wins over the raw progress
   * line when present; `quietForMs` is the fleet stall tell (pure timestamp
   * comparison), rendered as a quiet-duration marker.
   */
  readonly agents: ReadonlyArray<{
    /** Set on agents this process runs: Enter opens them full screen. */
    readonly id?: string;
    readonly label: string;
    readonly progress?: string;
    readonly headline?: string;
    readonly quietForMs?: number;
  }>;
  /** Count of running background processes. */
  readonly processes: number;
}

export interface ActivityView {
  readonly now: ActivityNow;
  /** Plain-language items waiting on the user (approvals, prompts). */
  readonly needsYou: readonly string[];
  /** Plain-language upcoming scheduled work, soonest first. */
  readonly comingUp: readonly string[];
  /** Activity feed entries, newest first. */
  readonly recent: readonly ActivityEntry[];
}

/** How many agent rows the Now section lists. */
const ACTIVITY_AGENT_ROWS = 8;

/** States a fleet node is in while it is still doing something. */
const LIVE_FLEET_STATES: ReadonlySet<string> = new Set(['running', 'starting', 'waiting', 'blocked', 'paused']);

/**
 * Build the Now section's agent rows from the active agents and the fleet
 * nodes.
 *
 * Rows this process is running come first and carry their live progress: the
 * per-node headline wins over the raw progress line, and the stall tell
 * renders as a quiet-duration marker. Agent-kind nodes the fleet carries that
 * no active agent here matches are work running elsewhere (the daemon's
 * scheduled and channel-driven runs), labeled so the two are never confused.
 */
export function buildActivityAgentRows(
  activeAgents: ReadonlyArray<{ readonly id: string; readonly label: string; readonly latestProgress?: string | undefined }>,
  fleetNodes: ReadonlyArray<{
    readonly id: string;
    readonly kind?: string | undefined;
    readonly label?: string | undefined;
    readonly state?: string | undefined;
    readonly headline?: { readonly text: string } | undefined;
    readonly stall?: { readonly quietForMs: number } | undefined;
  }>,
): ActivityNow['agents'] {
  const nodesById = new Map(fleetNodes.map((node) => [node.id, node]));
  const localIds = new Set(activeAgents.map((agent) => agent.id));
  const rows: Array<ActivityNow['agents'][number]> = activeAgents.slice(0, ACTIVITY_AGENT_ROWS).map((agent) => {
    const node = nodesById.get(agent.id);
    return {
      id: agent.id,
      label: agent.label,
      progress: agent.latestProgress?.trim() || undefined,
      headline: node?.headline?.text,
      quietForMs: node?.stall?.quietForMs,
    };
  });
  for (const node of fleetNodes) {
    if (rows.length >= ACTIVITY_AGENT_ROWS) break;
    if (localIds.has(node.id)) continue;
    if (node.kind !== 'agent') continue;
    if (node.state !== undefined && !LIVE_FLEET_STATES.has(node.state)) continue;
    rows.push({
      label: `${node.label ?? node.id} (elsewhere)`,
      headline: node.headline?.text,
      quietForMs: node.stall?.quietForMs,
    });
  }
  return rows;
}

/** Compact quiet-duration text for the stall tell, e.g. "quiet 4m". */
export function fmtQuietFor(quietForMs: number): string {
  const minutes = Math.floor(quietForMs / 60_000);
  if (minutes < 60) return `quiet ${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  return `quiet ${hours}h${minutes % 60 > 0 ? ` ${minutes % 60}m` : ''}`;
}

const KIND_GLYPHS: Record<ActivityKind, string> = {
  status: '·',
  tool: '·',
  agent: '»',
  schedule: '◷',
  delivery: '↗',
  security: '!',
  system: '·',
};

function kindColor(kind: ActivityKind): string {
  const t = activeTokens();
  switch (kind) {
    case 'agent': return t.info;
    case 'schedule': return t.accent;
    case 'delivery': return t.success;
    case 'security': return t.warning;
    default: return t.textFaint;
  }
}

function fmtClock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** One item of the modal, before selection is applied. */
export interface ActivityItem {
  readonly section: 'Now' | 'Needs you' | 'Coming up' | 'Recent';
  readonly row: KitRow;
  /** Enter on this item opens the process monitor. */
  readonly opensProcesses?: boolean;
  /** Enter on this item opens this agent full screen (the process monitor when it cannot). */
  readonly agentId?: string;
}

/** Every item of the view, in section order, filtered by the query. */
export function activityItems(view: ActivityView, query: string): ActivityItem[] {
  const t = activeTokens();
  const items: ActivityItem[] = [];
  if (view.now.busy) items.push({ section: 'Now', row: { label: view.now.label ?? 'Working…', mark: '●', markFg: t.info } });
  for (const agent of view.now.agents) {
    const detail = agent.headline ?? agent.progress;
    items.push({
      section: 'Now',
      row: {
        label: agent.label,
        desc: detail,
        mark: '»',
        markFg: t.info,
        right: agent.quietForMs !== undefined ? fmtQuietFor(agent.quietForMs) : undefined,
        rightFg: t.warning,
      },
      opensProcesses: true,
      agentId: agent.id,
    });
  }
  if (view.now.processes > 0) {
    items.push({
      section: 'Now',
      row: { label: `${view.now.processes} background ${view.now.processes === 1 ? 'process' : 'processes'}`, mark: '▸', markFg: t.textMuted },
      opensProcesses: true,
    });
  }
  for (const text of view.needsYou) items.push({ section: 'Needs you', row: { label: text, mark: '!', markFg: t.warning } });
  for (const text of view.comingUp) items.push({ section: 'Coming up', row: { label: text, labelFg: t.textMuted, mark: '◷', markFg: t.accent } });
  for (const entry of view.recent) {
    items.push({
      section: 'Recent',
      row: {
        // The glyph and color carry the kind, so the leading "[Tag]" is dropped.
        label: entry.text.replace(/^\[[^\]]+\]\s*/, ''),
        labelFg: entry.priority === 'high' ? t.text : t.textMuted,
        mark: KIND_GLYPHS[entry.kind],
        markFg: kindColor(entry.kind),
        right: fmtClock(entry.at),
      },
    });
  }
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => item.section.toLowerCase().includes(q)
    || (item.row.label ?? '').toLowerCase().includes(q)
    || (item.row.desc ?? '').toLowerCase().includes(q));
}

/** What the renderer reads from the modal. */
export interface ActivityModalView {
  readonly view: ActivityView;
  readonly query: string;
  readonly selectedIndex: number;
}

/** The static strings this surface can show (checked by package verification). */
export function renderActivityModalPackageText(): string {
  return [
    'Activity',
    'Filter activity',
    '<n> entries',
    '<n> of <total>',
    'now',
    'needs you',
    'coming up',
    'recent',
    'Working…',
    '<n> background processes',
    '<n> agents running',
    'quiet <n>m',
    'Nothing yet, activity will show up here.',
    'Nothing matches "<query>".',
    'move',
    'open process monitor',
    'open agent',
  ].join('\n');
}

export function renderActivityModal(modal: ActivityModalView, screenWidth: number, screenHeight: number): SurfaceLayer {
  const t = activeTokens();
  const all = activityItems(modal.view, '');
  const items = activityItems(modal.view, modal.query);
  const selected = items[Math.max(0, Math.min(modal.selectedIndex, items.length - 1))];
  const hints: KitHint[] = selected?.agentId ? [['↑↓', 'move'], ['⏎', 'open agent']]
    : selected?.opensProcesses ? [['↑↓', 'move'], ['⏎', 'open process monitor']] : [['↑↓', 'move']];
  const agents = modal.view.now.agents.length;
  const f = beginModal(screenWidth, screenHeight, {
    title: 'Activity',
    sub: agents > 0 ? `${agents} agent${agents === 1 ? '' : 's'} running` : undefined,
    hints,
  });
  searchRow(f, f.top, modal.query, 'Filter activity', modal.query ? `${items.length} of ${all.length}` : `${all.length} entries`);
  const top = f.top + 2;
  if (items.length === 0) {
    const text = all.length === 0 ? 'Nothing yet, activity will show up here.' : `Nothing matches "${modal.query}".`;
    drawTextBlock(f.canvas, f.l, top, f.r - f.l + 1, [{ text, style: { fg: t.textMuted } }], f.bottom);
    return finishModal(f);
  }
  const rows: KitRow[] = [];
  let section: ActivityItem['section'] | null = null;
  items.forEach((item, i) => {
    if (item.section !== section) {
      section = item.section;
      rows.push({ header: section });
    }
    rows.push({ ...item.row, selected: item === selected && i === Math.max(0, Math.min(modal.selectedIndex, items.length - 1)) });
  });
  const result = drawList(f.canvas, { rows, top, bottom: f.bottom, x0: f.l, x1: f.r, scrollKey: { owner: modal, name: 'activity' } });
  f.hintRight = scrollCountText(result.above, result.below);
  return finishModal(f);
}
