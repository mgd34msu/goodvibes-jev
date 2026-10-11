import { describe, expect, test } from 'bun:test';
import { McpWorkspace, handleMcpWorkspaceToken } from '../../input/mcp-workspace.ts';
import { renderMcpWorkspace } from '../../renderer/mcp-workspace.ts';
import { activeTokens } from '../../renderer/theme.ts';
import { layerText, layerTextBlock } from '../helpers/surface-frame.ts';

describe('renderMcpWorkspace (modal surface kit, list and detail)', () => {
  test('a server name cannot turn an ordinary removal prompt into an error notice', () => {
    const workspace = new McpWorkspace();
    workspace.active = true;
    workspace.requestDelete('failed-attention-quarantine');
    expect(workspace.statusTone).toBe('info');
    const layer = renderMcpWorkspace(workspace, 140, 36);
    const statusCells = layer.lines.find(line => line.map(cell => cell.char).join('').includes('Status:'));
    expect(statusCells).toBeDefined();
    if (!statusCells) throw new Error('MCP removal prompt omitted its status row');
    const label = statusCells.map(cell => cell.char).join('');
    expect(label).toContain('failed-attention-quarantine');
    expect(statusCells[label.indexOf('Status:')]?.fg).toBe(activeTokens().textMuted);
  });

  test('a runtime-only server edit is a typed warning even when its name contains failed', () => {
    const workspace = new McpWorkspace();
    workspace.active = true;
    workspace.openEditForm('failed-server');
    expect(workspace.statusTone).toBe('warning');
    const layer = renderMcpWorkspace(workspace, 140, 36);
    const statusCells = layer.lines.find(line => line.map(cell => cell.char).join('').includes('Status:'));
    if (!statusCells) throw new Error('MCP missing-config warning omitted its status row');
    const label = statusCells.map(cell => cell.char).join('');
    expect(label).toContain('failed-server');
    expect(statusCells[label.indexOf('Status:')]?.fg).toBe(activeTokens().warning);
  });

  test('browse: server and action groups on the left, the selected row\'s details in an element inset on the right', () => {
    const workspace = new McpWorkspace();
    workspace.active = true;
    const layer = renderMcpWorkspace(workspace, 120, 32);
    const rows = layerText(layer);
    const text = rows.join('\n');

    expect(layer.x + rows[0]!.length).toBeLessThanOrEqual(120);
    expect(layer.y + rows.length).toBeLessThanOrEqual(32);
    expect(rows[2]).toContain('MCP servers');
    expect(text).toContain('servers');
    expect(text).toContain('actions');
    expect(text).toContain('No configured servers');
    expect(text).toContain('Add server');
    expect(text).toContain('Write a server through the SDK config manager');
    expect(text).not.toMatch(/[┌┐└┘│]/);
    const insetCells = layer.lines.flat().filter((cell) => cell.bg === activeTokens().backgroundElement);
    expect(insetCells.length).toBeGreaterThan(0);
  });

  test('the add-server form is a sub-view: crumb in the title, fields on the left, field help in the inset', () => {
    const workspace = new McpWorkspace();
    workspace.active = true;
    workspace.openAddForm();
    const text = layerTextBlock(renderMcpWorkspace(workspace, 140, 36));
    expect(text).toContain('Add server');
    expect(text).toContain('Server name');
    expect(text).toContain('Save and reload');
    expect(text).toContain('Unique MCP server id');
    expect(text).toContain('esc  back');
  });

  test('the browser search row is always live; action letters fire only while the query is empty; Esc pops one level', () => {
    const workspace = new McpWorkspace();
    workspace.active = true;
    let escapes = 0;
    const route = (token: unknown): void => { handleMcpWorkspaceToken(workspace, token as never, () => { escapes++; }, () => {}); };

    route({ type: 'text', value: 'r' }); // reload (no context: a no-op), not typed
    expect(workspace.query).toBe('');
    route({ type: 'text', value: 'c' });
    route({ type: 'text', value: 'o' });
    route({ type: 'text', value: 'n' });
    expect(workspace.query).toBe('con');
    expect(workspace.visibleRows.map((row) => (row.type === 'action' ? row.label : ''))).toEqual(['Config locations']);
    route({ type: 'text', value: 'a' }); // typed, not "add"
    expect(workspace.mode).toBe('browse');
    expect(workspace.query).toBe('cona');
    route({ type: 'key', logicalName: 'backspace' });
    expect(workspace.query).toBe('con');

    workspace.setQuery('');
    route({ type: 'text', value: 'a' }); // add form
    expect(workspace.mode).toBe('form');
    route({ type: 'key', logicalName: 'escape' });
    expect(workspace.mode).toBe('browse');
    expect(escapes).toBe(0);
    route({ type: 'key', logicalName: 'escape' });
    expect(escapes).toBe(1);
  });
});
