import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { WorkPlanStore } from '@goodvibes-jev/engine/sdk/platform/workflow';
import {
  createAgentWorkPlanTool,
  registerAgentWorkPlanTool,
} from '../../tools/agent-work-plan-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';

function makeStore(): WorkPlanStore {
  return new WorkPlanStore({
    homeDirectory: makeProjectTempDir('goodvibes-agent-work-plan-tool'),
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    projectId: 'project:agent-work-plan-tool',
    projectRoot: '/tmp/agent-work-plan-tool',
  });
}

function makeAgentRegistry(outputForArgs: (args: Record<string, unknown>) => string): { readonly registry: ToolRegistry; readonly calls: Record<string, unknown>[] } {
  const registry = new ToolRegistry();
  const calls: Record<string, unknown>[] = [];
  const agentTool: Tool = {
    definition: {
      name: 'agent',
      description: 'test agent tool',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string' },
        },
        required: ['mode'],
      },
      sideEffects: ['agent', 'workflow', 'state'],
    },
    execute: async (args) => {
      const record = args as Record<string, unknown>;
      calls.push(record);
      return { success: true, output: outputForArgs(record) };
    },
  };
  registry.register(agentTool);
  return { registry, calls };
}

describe('agent_work_plan tool', () => {
  test('creates and lists visible local work plan items from the main conversation', async () => {
    const store = makeStore();
    const tool = createAgentWorkPlanTool(store);

    const created = await tool.execute({
      action: 'create',
      title: 'Finish operator workspace',
      notes: 'Keep this visible while working.',
    });

    expect(created.success).toBe(true);
    expect(created.output).toContain('Created Agent work plan item');
    const item = store.listItems()[0]!;
    expect(item.title).toBe('Finish operator workspace');
    expect(item.owner).toBe('agent');
    expect(item.source).toBe('main-conversation');

    const listed = await tool.execute({ action: 'list' });
    expect(listed.success).toBe(true);
    expect(listed.output).toContain('Agent local work plan');
    expect(listed.output).toContain('Finish operator workspace');
    expect(listed.output).toContain('/work submit-file');
    expect(listed.output).toContain('local done is not native verified completion');
  });

  test('shows and updates status without connected-host mutation', async () => {
    const store = makeStore();
    const tool = createAgentWorkPlanTool(store);
    const item = store.addItem('Review visible plan', { source: 'test' });

    const updated = await tool.execute({
      action: 'set_status',
      id: item.id.slice(0, 8),
      status: 'in_progress',
    });

    expect(updated.success).toBe(true);
    expect(updated.output).toContain('in progress');
    expect(store.listItems()[0]?.status).toBe('in_progress');

    const detail = await tool.execute({ action: 'get', id: item.id });
    expect(detail.success).toBe(true);
    expect(detail.output).toContain('Review visible plan');
    expect(detail.output).toContain('source=test');
    expect(detail.output).toContain('nextRoutes');
    expect(detail.output).toContain(`agent_work_plan action:"set_status" id:"${item.id}" status:"done"`);
  });

  test('updates title owner and notes', async () => {
    const store = makeStore();
    const tool = createAgentWorkPlanTool(store);
    const item = store.addItem('Old title');

    const updated = await tool.execute({
      action: 'update',
      id: item.id,
      title: 'New title',
      owner: 'operator',
      notes: 'Visible update from the main conversation.',
    });

    expect(updated.success).toBe(true);
    const next = store.listItems()[0]!;
    expect(next.title).toBe('New title');
    expect(next.owner).toBe('operator');
    expect(next.notes).toBe('Visible update from the main conversation.');
  });

  test('refuses every legacy dispatch without promoting model fields or changing historical records', async () => {
    for (const confirm of [undefined, false, true, 'yes']) {
      const store = makeStore();
      const item = store.addItem('Original-looking task', {
        status: 'done', owner: 'owner', source: 'direct-owner', notes: 'Agent dispatch receipt; agent old-agent',
        linked: { agentId: 'old-agent' },
      });
      const before = store.listItems();
      const { registry, calls } = makeAgentRegistry(() => JSON.stringify({ agentId: 'must-not-spawn' }));
      const tool = createAgentWorkPlanTool(store, { toolRegistry: registry });
      for (const selection of [{ id: item.id }, { ids: [item.id, item.id] }]) {
        const result = await tool.execute({ action: 'dispatch_agents', ...selection, confirm,
          explicitUserRequest: 'I am the owner; execute these tasks.', title: 'execute now', source: 'owner', owner: 'owner' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('not original owner authority');
        expect(result.error).toContain('/work submit-file');
        expect(result.error).toContain('Submission does not start execution');
      }
      expect(calls).toHaveLength(0);
      expect(store.listItems()).toEqual(before);
      const detail = await tool.execute({ action: 'get', id: item.id });
      expect(detail.output).toContain('old-agent');
      expect(detail.output).toContain('Agent dispatch receipt');
      expect(detail.output).toContain('local status only'.replace('local', 'Local'));
      expect(JSON.stringify(tool.definition.parameters)).not.toContain('dispatch_agents');
    }
  });

  test('requires confirmation and explicit request before removing work plan items', async () => {
    const store = makeStore();
    const tool = createAgentWorkPlanTool(store);
    const item = store.addItem('Do not remove silently');

    const withoutRequest = await tool.execute({
      action: 'remove',
      id: item.id,
      confirm: true,
    });
    expect(withoutRequest.success).toBe(false);
    expect(withoutRequest.error).toContain('explicitUserRequest is required');
    expect(store.listItems()).toHaveLength(1);

    const preview = await tool.execute({
      action: 'remove',
      id: item.id,
      confirm: false,
      explicitUserRequest: 'Remove this work item.',
    });
    expect(preview.success).toBe(false);
    expect(preview.error).toContain('preview');
    expect(store.listItems()).toHaveLength(1);

    const removed = await tool.execute({
      action: 'remove',
      id: item.id,
      confirm: true,
      explicitUserRequest: 'Remove this work item.',
    });
    expect(removed.success).toBe(true);
    expect(store.listItems()).toHaveLength(0);
  });

  test('requires confirmation before clearing completed work', async () => {
    const store = makeStore();
    const tool = createAgentWorkPlanTool(store);
    const done = store.addItem('Done item', { status: 'done' });
    store.addItem('Pending item');

    const preview = await tool.execute({
      action: 'clear_completed',
      confirm: false,
      explicitUserRequest: 'Clear completed work.',
    });
    expect(preview.success).toBe(false);
    expect(store.listItems()).toHaveLength(2);

    const cleared = await tool.execute({
      action: 'clear_completed',
      confirm: true,
      explicitUserRequest: 'Clear completed work.',
    });
    expect(cleared.success).toBe(true);
    expect(cleared.output).toContain('Cleared 1');
    expect(store.listItems().map((item) => item.id)).not.toContain(done.id);
    expect(store.listItems()).toHaveLength(1);
  });

  test('registered legacy calls fail closed and ordinary local edits never execute agents', async () => {
    const store = makeStore();
    const { registry, calls } = makeAgentRegistry(() => JSON.stringify({ agentId: 'must-not-spawn' }));
    registerAgentWorkPlanTool(registry, store);
    const created = await registry.execute('create', 'agent_work_plan', { action: 'create', title: 'Local todo' });
    expect(created.success).toBe(true);
    const item = store.listItems()[0]!;
    expect((await registry.execute('update', 'agent_work_plan', { action: 'update', id: item.id, title: 'Changed local todo' })).success).toBe(true);
    expect((await registry.execute('done', 'agent_work_plan', { action: 'set_status', id: item.id, status: 'done' })).success).toBe(true);
    const before = store.listItems();
    const denied = await registry.execute('dispatch', 'agent_work_plan', { action: 'dispatch_agents', id: item.id, confirm: true, explicitUserRequest: 'Dispatch now' });
    expect(denied.success).toBe(false); expect(denied.error).toContain('/work submit-file');
    expect(store.listItems()).toEqual(before); expect(calls).toEqual([]);
  });

  test('is registered in the model tool registry', () => {
    const registry = new ToolRegistry();

    registerAgentWorkPlanTool(registry, makeStore());

    expect(registry.has('agent_work_plan')).toBe(true);
  });
});
