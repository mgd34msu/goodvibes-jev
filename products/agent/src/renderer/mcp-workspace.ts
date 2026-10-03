/**
 * renderMcpWorkspace, the MCP server workspace as a kit modal with two panes:
 * the server and action list on the left (✦ servers / actions groups, a ● or
 * ○ connection marker, the selected row as the gradient) and the selected
 * row's details in an element panel on the right (connection, trust, launch
 * command, allowed paths and hosts, quarantine, the server's tools, and the
 * status line). The add/edit form and the remove and reload confirmations
 * are sub-views of the same modal: Esc returns from them to the browser.
 */

import type { McpWorkspace, McpWorkspaceRow, McpWorkspaceServerRow } from '../input/mcp-workspace.ts';
import { activeTokens } from './theme.ts';
import {
  beginModal,
  finishModal,
  searchRow,
  scrollCountText,
  type KitHint,
  type ModalFrame,
  type SurfaceLayer,
} from './surface-kit.ts';
import { drawList, type KitRow } from './surface-kit-list.ts';
import { panel } from './surface-kit-parts.ts';
import { drawTextBlock, splitPanes, textBlockHeight, type TextLine } from './surface-kit-extra.ts';

const MCP_WORKSPACE_FORM_WRITE_CONFIRMATION = 'Workspace writes require explicit confirmation. Type yes on the Confirm field, then save from here.';
const MCP_WORKSPACE_FORM_CONFIG_LOCATIONS = 'Project/global config locations are shown for review. The workspace dispatches confirmed MCP changes through the shell-owned command router.';
const MCP_WORKSPACE_REMOVE_HELP = 'Press y to remove through the shell-owned command router, n or Esc to cancel.';
const MCP_WORKSPACE_RELOAD_HELP = 'Press y to reload the MCP runtime from the current config through the shell-owned command router, n or Esc to cancel.';

function serverOriginLabel(source: McpWorkspaceServerRow['source']): string {
  switch (source) {
    case 'project': return 'project config';
    case 'global': return 'global config';
    case 'external': return 'external config';
    case 'runtime': return 'runtime';
  }
}

function hintsFor(workspace: McpWorkspace): KitHint[] {
  if (workspace.mode === 'form') return [['↑↓', 'field'], ['←→', 'cycle'], ['type', 'edit'], ['⏎', 'save or cancel row'], ['esc', 'back']];
  if (workspace.mode === 'delete-confirm') return [['y', 'remove'], ['n', 'cancel'], ['esc', 'back']];
  if (workspace.mode === 'reload-confirm') return [['y', 'reload'], ['n', 'cancel'], ['esc', 'back']];
  return [['↑↓', 'move'], ['⏎', 'view or run'], ['a', 'add'], ['d', 'remove'], ['r', 'reload'], ['t', 'tools']];
}

/** The static strings this surface can show (checked by package verification). */
export function renderMcpWorkspacePackageText(): string {
  return [
    'MCP servers',
    'Filter servers and actions',
    '<n> of <total>',
    '<n> tools',
    'Servers',
    'Actions',
    '<connected>/<servers> connected',
    'No configured servers',
    'No servers match',
    'quarantined',
    'offline',
    'project config',
    'global config',
    'external config',
    'runtime',
    'Add server',
    'Edit server',
    'Remove server',
    'Reload MCP runtime',
    'Adding an MCP server',
    'Editing server: <server>',
    MCP_WORKSPACE_FORM_WRITE_CONFIRMATION,
    MCP_WORKSPACE_FORM_CONFIG_LOCATIONS,
    MCP_WORKSPACE_REMOVE_HELP,
    MCP_WORKSPACE_RELOAD_HELP,
    'No MCP rows available.',
    'No rows match "<query>".',
    '(runtime only; no launch config found)',
    '(none)',
    '(empty)',
    'Status: <status>',
    'Tools: loading',
    'Tools for <server>: <count>',
    'Tools: <count>',
    'Loading the tool list from connected MCP servers.',
    'No tools cached for the selected server. Press t to refresh.',
    'Cancel and return to the server browser',
    '<n> more lines',
    ...(['browse', 'form', 'delete-confirm', 'reload-confirm'] as const)
      .flatMap((mode) => hintsFor({ mode } as McpWorkspace).map(([, action]) => action)),
  ].join('\n');
}

function statusColor(text: string): string {
  const t = activeTokens();
  if (text.includes('failed')) return t.error;
  if (text.includes('attention') || text.includes('quarantine')) return t.warning;
  return t.textMuted;
}

function browseRows(workspace: McpWorkspace): KitRow[] {
  const t = activeTokens();
  const rows: KitRow[] = [];
  const visible = workspace.visibleRows;
  const servers = visible.filter((row) => row.type === 'server');
  rows.push({ header: 'Servers', headerRight: `${workspace.servers.filter((s) => s.connected).length}/${workspace.servers.length} connected` });
  if (servers.length === 0) {
    rows.push({ label: workspace.servers.length === 0 ? 'No configured servers' : 'No servers match', muted: true });
  }
  let sawAction = false;
  visible.forEach((row: McpWorkspaceRow, index) => {
    const selected = workspace.mode === 'browse' && index === workspace.selectedIndex;
    if (row.type === 'server') {
      rows.push({
        label: row.server.name,
        desc: serverOriginLabel(row.server.source),
        mark: row.server.connected ? '●' : '○',
        markFg: row.server.connected ? t.success : t.warning,
        right: row.server.quarantineReason ? 'quarantined' : row.server.connected ? '' : 'offline',
        rightFg: row.server.quarantineReason ? t.error : t.textFaint,
        selected,
      });
      return;
    }
    if (!sawAction) {
      rows.push({ header: 'Actions' });
      sawAction = true;
    }
    rows.push({ label: row.label, mark: '+', markFg: t.info, selected });
  });
  return rows;
}

function detailLines(workspace: McpWorkspace): TextLine[] {
  const t = activeTokens();
  const title = (text: string): TextLine => ({ text, style: { fg: t.text, bold: true } });
  const body = (text: string): TextLine => ({ text, style: { fg: t.textMuted } });
  const lines: TextLine[] = [];
  const selected = workspace.selectedRow;
  if (!selected) {
    lines.push(body(workspace.query ? `No rows match "${workspace.query}".` : 'No MCP rows available.'));
  } else if (selected.type === 'action') {
    lines.push(title(selected.label), body(selected.detail));
  } else {
    const server = selected.server;
    lines.push(
      title(server.name),
      { text: `${server.connected ? 'connected' : 'offline'} · ${serverOriginLabel(server.source)} · config ${server.freshness}`, style: { fg: server.connected ? t.success : t.warning } },
      { text: '' },
      body(`Role ${server.role} · trust ${server.trustMode}`),
      body(`Command ${server.command ? `${server.command}${server.args?.length ? ` ${server.args.join(' ')}` : ''}` : '(runtime only; no launch config found)'}`),
      body(`Allowed paths ${server.allowedPaths.length > 0 ? server.allowedPaths.join(', ') : '(none)'}`),
      body(`Allowed hosts ${server.allowedHosts.length > 0 ? server.allowedHosts.join(', ') : '(none)'}`),
    );
    if (server.quarantineReason) {
      lines.push({ text: `Quarantine: ${server.quarantineReason}${server.quarantineDetail ? ` - ${server.quarantineDetail}` : ''}`, style: { fg: t.error } });
    }
  }
  lines.push({ text: '' });
  const server = workspace.selectedServer?.name;
  const tools = server ? workspace.tools.filter((tool) => tool.serverName === server) : workspace.tools;
  lines.push(title(workspace.loadingTools ? 'Tools: loading' : server ? `Tools for ${server}: ${tools.length}` : `Tools: ${tools.length}`));
  if (tools.length === 0) {
    lines.push(body(workspace.loadingTools ? 'Loading the tool list from connected MCP servers.' : 'No tools cached for the selected server. Press t to refresh.'));
  } else {
    for (const tool of tools) {
      lines.push({ text: `${tool.toolName}${server ? '' : ` (${tool.serverName})`}${tool.description ? `  ${tool.description}` : ''}`, style: { fg: t.textMuted } });
    }
  }
  return lines;
}

function formRows(workspace: McpWorkspace): KitRow[] {
  const t = activeTokens();
  return workspace.formFields.map((field, index) => {
    const selected = index === workspace.formIndex;
    const isAction = field.id === 'save' || field.id === 'cancel';
    const value = isAction ? undefined : field.value.length > 0 ? field.value : '(empty)';
    return {
      label: field.label,
      desc: value !== undefined && selected && field.editable ? `${field.value}▏` : value,
      right: !isAction && !field.editable ? '←→' : undefined,
      labelFg: field.id === 'save' ? t.success : field.id === 'cancel' ? t.warning : undefined,
      bold: isAction,
      selected,
    };
  });
}

function formLines(workspace: McpWorkspace): TextLine[] {
  const t = activeTokens();
  const field = workspace.formFields[workspace.formIndex];
  // The selected field's help leads: it is what the user needs right now.
  return [
    ...(field ? [{ text: field.label, style: { fg: t.text, bold: true } }, { text: field.help, style: { fg: t.textMuted } }, { text: '' }] : []),
    { text: workspace.editingServerName ? `Editing server: ${workspace.editingServerName}` : 'Adding an MCP server', style: { fg: t.text, bold: true } },
    { text: MCP_WORKSPACE_FORM_WRITE_CONFIRMATION, style: { fg: t.textMuted } },
    { text: '' },
    { text: MCP_WORKSPACE_FORM_CONFIG_LOCATIONS, style: { fg: t.textFaint } },
  ];
}

function drawPanel(f: ModalFrame, split: ReturnType<typeof splitPanes>, lines: readonly TextLine[]): void {
  const t = activeTokens();
  const p = panel(f.canvas, split.panelX, split.panelY, split.panelW, split.panelH);
  const width = p.r - p.l + 1;
  const need = textBlockHeight(lines, width);
  const room = p.bottom - p.top + 1;
  if (need <= room) {
    drawTextBlock(f.canvas, p.l, p.top, width, lines, p.bottom);
    return;
  }
  // Keep the last panel row for an honest count of what did not fit.
  drawTextBlock(f.canvas, p.l, p.top, width, lines, p.bottom - 1);
  f.canvas.put(p.l, p.bottom, `${need - room + 1} more lines`, { fg: t.textFaint });
}

export function renderMcpWorkspace(workspace: McpWorkspace, screenWidth: number, screenHeight: number): SurfaceLayer {
  const t = activeTokens();
  const crumbs = workspace.mode === 'form'
    ? [workspace.editingServerName ? 'Edit server' : 'Add server']
    : workspace.mode === 'delete-confirm' ? ['Remove server']
    : workspace.mode === 'reload-confirm' ? ['Reload MCP runtime'] : [];
  const f = beginModal(screenWidth, screenHeight, { title: 'MCP servers', crumbs, hints: hintsFor(workspace) });

  // Status sits under both panes, wrapped in full.
  const status: TextLine[] = [{ text: `Status: ${workspace.status}`, style: { fg: statusColor(workspace.status) } }];
  const statusRows = textBlockHeight(status, f.r - f.l + 1);
  const bodyBottom = f.bottom - statusRows - 1;
  drawTextBlock(f.canvas, f.l, bodyBottom + 2, f.r - f.l + 1, status, f.bottom);

  let top = f.top;
  if (workspace.mode === 'browse') {
    const total = workspace.rows.length;
    searchRow(f, top, workspace.query, 'Filter servers and actions', workspace.query ? `${workspace.visibleRows.length} of ${total}` : `${workspace.tools.length} tools`);
    top += 2;
  }

  if (workspace.mode === 'delete-confirm') {
    const split = splitPanes(f.l, f.r, top, bodyBottom, 0.45, 3);
    drawList(f.canvas, {
      rows: [
        { label: `Remove ${workspace.editingServerName ?? '(unknown)'}`, danger: true, selected: true, mark: '✕', markFg: t.error, right: 'y' },
        { label: 'Cancel and return to the server browser', right: 'n' },
      ],
      top: split.top, bottom: split.bottom, x0: split.x0, x1: split.x1,
    });
    drawPanel(f, split, [
      { text: `Remove configured server: ${workspace.editingServerName ?? '(unknown)'}`, style: { fg: t.text, bold: true } },
      { text: 'This removes the selected writable project or global config entry and reloads the MCP runtime.', style: { fg: t.textMuted } },
      { text: '' },
      { text: MCP_WORKSPACE_REMOVE_HELP, style: { fg: t.warning } },
    ]);
    return finishModal(f);
  }

  if (workspace.mode === 'reload-confirm') {
    const split = splitPanes(f.l, f.r, top, bodyBottom, 0.45, 3);
    drawList(f.canvas, {
      rows: [
        { label: 'Reload the MCP runtime', selected: true, mark: '↻', right: 'y' },
        { label: 'Cancel and return to the server browser', right: 'n' },
      ],
      top: split.top, bottom: split.bottom, x0: split.x0, x1: split.x1,
    });
    drawPanel(f, split, [
      { text: 'Reload MCP runtime', style: { fg: t.text, bold: true } },
      { text: 'Reconnects every configured MCP server from the current project and global config.', style: { fg: t.textMuted } },
      { text: '' },
      { text: MCP_WORKSPACE_RELOAD_HELP, style: { fg: t.warning } },
    ]);
    return finishModal(f);
  }

  const rows = workspace.mode === 'form' ? formRows(workspace) : browseRows(workspace);
  const split = splitPanes(f.l, f.r, top, bodyBottom, 0.45);
  const res = drawList(f.canvas, { rows, top: split.top, bottom: split.bottom, x0: split.x0, x1: split.x1 });
  f.hintRight = scrollCountText(res.above, res.below);
  drawPanel(f, split, workspace.mode === 'form' ? formLines(workspace) : detailLines(workspace));
  return finishModal(f);
}
