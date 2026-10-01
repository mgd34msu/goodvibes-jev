/**
 * renderHelpOverlay, the help modal (`?` or /help): keyboard shortcuts plus
 * the slash-command list, drawn with the modal surface kit as one grouped,
 * filterable kit list (✦ group headers, each entry's description on the left
 * and its key or command right-aligned, muted). The search row is always
 * live; ↑↓ and PgUp/PgDn scroll.
 *
 * The keyboard shortcuts modal (/shortcuts) lives in shortcuts-overlay.ts.
 */

import type { SlashCommand } from '../input/command-registry.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';
import type { OverlayFilter } from '../input/overlay-filter.ts';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { activeTokens } from './theme.ts';
import {
  beginModal,
  finishModal,
  searchRow,
  scrollCountText,
  type KitHint,
  type SurfaceLayer,
} from './surface-kit.ts';
import { drawList, listScrollEnd, type KitRow } from './surface-kit-list.ts';
import { drawTextBlock } from './surface-kit-extra.ts';
import { SHORTCUT_OVERLAY_STATIC_TEXT } from './shortcuts-overlay.ts';

export { renderShortcutsOverlay } from './shortcuts-overlay.ts';

const FEATURED_HELP_COMMANDS: Array<[name: string, argHint: string, desc: string]> = [
  ['agent',        '',           'Open workspace; press / there to search every action'],
  ['agent',        'knowledge',  'Open isolated Agent Knowledge workspace actions'],
  ['agent',        'voice', 'Open voice, image, and media workspace actions'],
  ['setup',        '',           'Open the Agent workspace'],
  ['knowledge',    'status',     'Inspect isolated Agent Knowledge readiness'],
  ['memory',       '',           'Manage Agent-local memory records'],
  ['personas',     '',           'Manage serial Agent operating personas'],
  ['skills',       '',           'Manage Agent-local skills and bundles'],
  ['routines',     '',           'Manage reusable main-conversation routines'],
  ['approval',     '',           'Review and explicitly act on approvals'],
  ['automation',   '',           'Run confirmed connected-host automation actions'],
  ['schedule',     'remind',     'Create confirmed reminders or inspect schedules'],
  ['delegate',     '',           'Explicitly hand build/fix/review work to GoodVibes TUI'],
  ['mcp',          '',           'Inspect MCP servers and tool readiness'],
  ['provider',     '',           'Choose provider or model family'],
  ['model',        '',           'Select the active model route'],
  ['subscription', '',           'Review provider logins and subscriptions'],
  ['secrets',      '',           'Manage secret references without printing values'],
  ['bundle',       'inspect',    'Inspect Agent support bundles from the TUI'],
  ['compat',       '',           'Inspect connected-host and Agent Knowledge compatibility'],
  ['health',       '',           'Run Agent runtime and setup diagnostics'],
];

const HELP_OVERLAY_STATIC_TEXT = [
  'Core Navigation',
  'Scroll / history recall',
  'Scroll by full page',
  'Search conversation (Ctrl+F)',
  'Prompt And Editing',
  'Submit message',
  'Insert newline',
  'Paste (image priority)',
  'Undo / redo',
  'Overlays And Workspace',
  'Toggle help',
  'Full keyboard shortcuts',
  'Open the Agent operator workspace',
  'Search all Agent workspace actions',
  'Open selected action or form',
  'Quick Start',
  'Available Slash Commands',
  'More Commands',
  'Hidden power commands still work, run /commands for the full catalog.',
  'Essentials',
  'Show this help overlay',
  'Keyboard shortcut reference',
  'Select LLM model',
  'Clear conversation',
] as const;


export function renderHelpOverlayPackageText(): string {
  return [
    ...HELP_OVERLAY_STATIC_TEXT,
    'Help',
    'Filter commands and shortcuts',
    'Nothing matches "<query>".',
    'scroll',
    'close',
    ...FEATURED_HELP_COMMANDS.flatMap(([name, argHint, desc]) => [
      argHint ? `/${name} ${argHint}` : `/${name}`,
      desc,
    ]),
    ...SHORTCUT_OVERLAY_STATIC_TEXT,
  ].join('\n');
}

interface HelpGroup {
  readonly title: string;
  readonly entries: Array<{ readonly label: string; readonly right: string }>;
}

/** The preferred order of the "Available Slash Commands" group. */
const PREFERRED_COMMANDS = [
  'agent', 'setup', 'knowledge', 'memory', 'personas', 'skills', 'routines', 'approval', 'schedule', 'delegate',
  'mcp', 'provider', 'model', 'subscription', 'secrets', 'health', 'settings', 'security', 'policy', 'tasks',
] as const;

/** Every help group for the live keybindings and registry. */
function helpGroups(keybindingsManager: KeybindingsManager, commands?: SlashCommand[]): HelpGroup[] {
  const kb = (action: Parameters<typeof keybindingsManager.getComboLabel>[0]) => keybindingsManager.getComboLabel(action);
  const hasCommand = (name: string): boolean => {
    if (!commands) return false;
    for (const command of commands) {
      // A broken plugin may expose a throwing `aliases` getter; skip it rather than crash the modal.
      try {
        if (command.name === name || (command.aliases ?? []).includes(name)) return true;
      } catch { /* skip this command */ }
    }
    return false;
  };

  const groups: HelpGroup[] = [
    {
      title: 'Core Navigation',
      entries: [
        { right: 'Up / Down', label: 'Scroll / history recall' },
        { right: 'PageUp / PageDn', label: 'Scroll by full page' },
        { right: kb('search'), label: 'Search conversation (Ctrl+F)' },
      ],
    },
    {
      title: 'Prompt And Editing',
      entries: [
        { right: 'Enter', label: 'Submit message' },
        { right: 'Shift+Enter', label: 'Insert newline' },
        { right: kb('paste'), label: 'Paste (image priority)' },
        { right: `${kb('undo')} / ${kb('redo')}`, label: 'Undo / redo' },
      ],
    },
    {
      title: 'Overlays And Workspace',
      entries: [
        { right: '?', label: 'Toggle help' },
        { right: '/shortcuts', label: 'Full keyboard shortcuts' },
        { right: kb('workspace-picker'), label: 'Open the Agent operator workspace' },
        { right: 'Workspace /', label: 'Search all Agent workspace actions' },
        { right: 'Workspace Enter', label: 'Open selected action or form' },
      ],
    },
  ];

  const quickStart: HelpGroup = { title: 'Quick Start', entries: [] };
  const featured = (name: string, argHint: string, desc: string): { label: string; right: string } => ({ label: desc, right: argHint ? `/${name} ${argHint}` : `/${name}` });
  try {
    for (const [name, argHint, desc] of FEATURED_HELP_COMMANDS) {
      if (hasCommand(name)) quickStart.entries.push(featured(name, argHint, desc));
    }
  } catch (err) {
    // A plugin command getter threw during registry traversal; fall back to the unfiltered list.
    logger.warn(`[help-overlay] registry traversal error during command filter; using unfiltered list: ${err}`);
    quickStart.entries.length = 0;
    for (const [name, argHint, desc] of FEATURED_HELP_COMMANDS) quickStart.entries.push(featured(name, argHint, desc));
  }
  groups.push(quickStart);

  if (commands && commands.length > 0) {
    const available: HelpGroup = { title: 'Available Slash Commands', entries: [] };
    const seen = new Set<string>();
    for (const name of PREFERRED_COMMANDS) {
      const cmd = commands.find((entry) => entry.name === name);
      if (!cmd) continue;
      seen.add(cmd.name);
      available.entries.push({ label: cmd.description, right: `/${cmd.name}` });
    }
    groups.push(available);
    // The list scrolls, so the full remaining registry is listed.
    const more: HelpGroup = {
      title: 'More Commands',
      entries: [...commands]
        .filter((cmd) => !seen.has(cmd.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((cmd) => ({ label: cmd.description, right: `/${cmd.name}` })),
    };
    groups.push(more);
  } else if (!hasCommand('help')) {
    groups.push({
      title: 'Essentials',
      entries: [
        { right: '/help', label: 'Show this help overlay' },
        { right: '/shortcuts', label: 'Keyboard shortcut reference' },
        { right: '/model', label: 'Select LLM model' },
        { right: '/clear', label: 'Clear conversation' },
      ],
    });
  }
  return groups.filter((g) => g.entries.length > 0);
}

function filterGroups(groups: readonly HelpGroup[], query: string): HelpGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...groups];
  return groups
    .map((g) => ({
      title: g.title,
      entries: g.title.toLowerCase().includes(q)
        ? g.entries
        : g.entries.filter((e) => e.label.toLowerCase().includes(q) || e.right.toLowerCase().includes(q)),
    }))
    .filter((g) => g.entries.length > 0);
}

const HINTS: readonly KitHint[] = [['↑↓', 'scroll'], ['?', 'close']];
const NOTE = 'Hidden power commands still work, run /commands for the full catalog.';

/**
 * Render the help modal as a SurfaceLayer in screen coordinates.
 *
 * @param scrollOffset  Rows scrolled past the top of the list.
 * @param filter        The search row's query; the renderer records how far the list can scroll in it.
 */
export function renderHelpOverlay(
  screenWidth: number,
  screenHeight: number,
  keybindingsManager: KeybindingsManager,
  commands?: SlashCommand[],
  scrollOffset = 0,
  filter?: OverlayFilter,
): SurfaceLayer {
  const t = activeTokens();
  const query = filter?.query ?? '';
  const all = helpGroups(keybindingsManager, commands);
  const groups = filterGroups(all, query);
  const f = beginModal(screenWidth, screenHeight, { title: 'Help', hints: HINTS });
  const total = all.reduce((n, g) => n + g.entries.length, 0);
  const shown = groups.reduce((n, g) => n + g.entries.length, 0);
  searchRow(f, f.top, query, 'Filter commands and shortcuts', query ? `${shown} of ${total}` : `${total} entries`);

  const top = f.top + 2;
  if (groups.length === 0) {
    if (filter) filter.maxScroll = 0;
    drawTextBlock(f.canvas, f.l, top, f.r - f.l + 1, [{ text: `Nothing matches "${query}".`, style: { fg: t.textMuted } }], f.bottom);
    return finishModal(f);
  }

  const rows: KitRow[] = [];
  for (const g of groups) {
    rows.push({ header: g.title });
    for (const e of g.entries) rows.push({ label: e.label, right: e.right });
  }
  // The catalog note closes the unfiltered list (wrapped in full, never clipped).
  if (!query && commands && commands.length > 0) rows.push({ label: NOTE, labelFg: t.textFaint });
  // The furthest start that still fills the list, by drawList's own spacing rules.
  const listOptions = { rows, top, bottom: f.bottom, x0: f.l, x1: f.r };
  const maxStart = listScrollEnd(f.canvas, listOptions);
  if (filter) filter.maxScroll = maxStart;
  const res = drawList(f.canvas, { ...listOptions, scrollStart: Math.min(scrollOffset, maxStart) });
  f.hintRight = scrollCountText(res.above, res.below);
  return finishModal(f);
}
