import { describe, expect, test } from 'bun:test';
import { McpWorkspace } from '../../input/mcp-workspace.ts';
import { renderMcpWorkspace } from '../../renderer/mcp-workspace.ts';
import { layerText, layerTextBlock } from '../helpers/surface-frame.ts';

describe('renderMcpWorkspace', () => {
  test('is a kit modal with the server and action list, a live search row and keycap hints', () => {
    const workspace = new McpWorkspace();
    workspace.active = true;
    const layer = renderMcpWorkspace(workspace, 120, 32);
    const text = layerTextBlock(layer);

    expect(layer.dim).toBe(true);
    expect(layer.x + layer.lines[0]!.length).toBeLessThanOrEqual(120);
    expect(layerText(layer)[2]).toContain('MCP servers');
    expect(text).toContain('✦ servers');
    expect(text).toContain('✦ actions');
    expect(text).toContain('Add or update server');
    expect(text).toContain('▏Filter servers and actions');
    expect(text).toContain('a  add');
    expect(text).toContain('r  reload');
  });

  test('typing filters the rows instead of firing an action letter once a query exists', () => {
    const workspace = new McpWorkspace();
    workspace.active = true;
    workspace.setQuery('reload');
    const text = layerTextBlock(renderMcpWorkspace(workspace, 120, 32));
    expect(text).toContain('reload▏');
    expect(text).toContain('Reload runtime');
    expect(text).not.toContain('Config locations');
  });

  test('renders the add-server form as a sub-view of the same modal', () => {
    const workspace = new McpWorkspace();
    workspace.active = true;
    workspace.openAddForm();
    const layer = renderMcpWorkspace(workspace, 140, 36);
    const text = layerTextBlock(layer);

    expect(layerText(layer)[2]).toContain('MCP servers › Add server');
    expect(text).toContain('Server name');
    expect(text).toContain('Save server');
    expect(text).toContain('Adding an MCP server');
    expect(text).toContain('esc  back');
  });

  test('renders reload confirmation as a workspace action instead of prompt guidance', () => {
    const workspace = new McpWorkspace();
    workspace.active = true;
    workspace.requestReload();
    const layer = renderMcpWorkspace(workspace, 120, 32);
    const text = layerTextBlock(layer);

    expect(layerText(layer)[2]).toContain('Reload MCP runtime');
    expect(text).toContain('Reload the MCP runtime');
    expect(text).toContain('y  reload');
    expect(text).not.toContain('from the prompt');
  });
});
