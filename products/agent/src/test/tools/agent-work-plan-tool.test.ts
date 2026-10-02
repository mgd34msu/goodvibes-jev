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
    expect(listed.output).toContain('agent_work_plan action:"dispatch_agents"');
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

  test('previews visible agent dispatch without spawning or writing receipts', async () => {
    const store = makeStore();
    const first = store.addItem('Map auth risks', { notes: 'Need source review.' });
    const second = store.addItem('Check browser setup');
    const { registry, calls } = makeAgentRegistry(() => JSON.stringify({ agents: [] }));
    const tool = createAgentWorkPlanTool(store, { toolRegistry: registry });

    const preview = await tool.execute({
      action: 'dispatch_agents',
      ids: [first.id, second.id],
      explicitUserRequest: 'Dispatch these two work items to visible agents.',
    });

    expect(preview.success).toBe(false);
    expect(preview.error).toContain('Agent work plan dispatch preview');
    expect(preview.error).toContain('agent { mode: "batch-spawn" }');
    expect(calls).toHaveLength(0);
    expect(store.listItems()[0]?.linked?.agentId).toBeUndefined();
    expect(store.listItems()[0]?.notes).toBe('Need source review.');
  });

  test('dispatches one selected work plan item through first-class spawn and saves a receipt', async () => {
    const store = makeStore();
    const item = store.addItem('Fix provider selector', { status: 'pending', notes: 'Keep model routing stable.' });
    const { registry, calls } = makeAgentRegistry(() => JSON.stringify({
      agentId: 'agent-single',
      status: 'spawned',
      template: 'engineer',
      task: 'Fix provider selector',
    }));
    const tool = createAgentWorkPlanTool(store, { toolRegistry: registry });

    const dispatched = await tool.execute({
      action: 'dispatch_agents',
      id: item.id,
      template: 'engineer',
      tools: ['read', 'find'],
      requiredEvidence: ['diff', 'tests'],
      confirm: true,
      explicitUserRequest: 'Dispatch the provider selector work item.',
    });

    expect(dispatched.success).toBe(true);
    expect(dispatched.output).toContain('Dispatched Agent work plan items');
    expect(dispatched.output).toContain('agent-single');
    expect(dispatched.output).toContain('nextRoutes');
    expect(dispatched.output).toContain('agent { mode: "wait", agentId: "agent-single" }');
    expect(dispatched.output).toContain(`agent_work_plan action:"get" id:"${item.id}"`);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.mode).toBe('spawn');
    expect(calls[0]?.task).toBe('Fix provider selector');
    expect(calls[0]?.authoritativeTask).toBe('Dispatch the provider selector work item.');
    expect(calls[0]?.tools).toEqual(['read', 'find']);
    expect(calls[0]?.restrictTools).toBe(true);
    expect(String(calls[0]?.context)).toContain(item.id);
    const updated = store.listItems()[0]!;
    expect(updated.status).toBe('in_progress');
    expect(updated.linked?.agentId).toBe('agent-single');
    expect(updated.notes).toContain('Agent dispatch receipt');
    expect(updated.notes).toContain('agent-single');

    const detail = await tool.execute({ action: 'get', id: item.id });
    expect(detail.success).toBe(true);
    expect(detail.output).toContain('linked agentId agent-single');
    expect(detail.output).toContain('agent { mode: "message", agentId: "agent-single" }');
    expect(detail.output).toContain('agent_harness mode:"agent_orchestration_agent" agentId:"agent-single" includeParameters:true');
  });

  test('dispatches multiple selected work plan items through first-class batch-spawn and links returned agents', async () => {
    const store = makeStore();
    const first = store.addItem('Audit channel routing');
    const second = store.addItem('Verify reminder receipts');
    const { registry, calls } = makeAgentRegistry(() => JSON.stringify({
      agents: [
        { id: 'agent-alpha', status: 'spawned', task: 'Audit channel routing' },
        { id: 'agent-beta', status: 'spawned', task: 'Verify reminder receipts' },
      ],
      count: 2,
      cohort: 'release-plan',
    }));
    const tool = createAgentWorkPlanTool(store, { toolRegistry: registry });

    const dispatched = await tool.execute({
      action: 'dispatch_agents',
      ids: [first.id, second.id],
      cohort: 'release-plan',
      agentContext: 'Release readiness slice.',
      successCriteria: ['Each item has a user-facing outcome.'],
      confirm: true,
      explicitUserRequest: 'Dispatch the approved release plan items.',
    });

    expect(dispatched.success).toBe(true);
    expect(dispatched.output).toContain('saved receipts 2');
    expect(dispatched.output).toContain('agent1.inspect agent { mode: "get", agentId: "agent-alpha" }');
    expect(dispatched.output).toContain('agent2.cancel agent { mode: "cancel", agentId: "agent-beta" }');
    expect(dispatched.output).toContain(`agent2.workItem agent_work_plan action:"get" id:"${second.id}"`);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.mode).toBe('batch-spawn');
    expect(calls[0]?.cohort).toBe('release-plan');
    const tasks = calls[0]?.tasks as readonly Record<string, unknown>[];
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.task).toBe('Audit channel routing');
    expect(tasks[0]?.successCriteria).toEqual(['Each item has a user-facing outcome.']);
    expect(String(tasks[0]?.context)).toContain('Release readiness slice.');
    const updated = store.listItems();
    expect(updated[0]?.linked?.agentId).toBe('agent-alpha');
    expect(updated[1]?.linked?.agentId).toBe('agent-beta');
    expect(updated[0]?.notes).toContain('cohort release-plan');
    expect(updated[1]?.status).toBe('in_progress');
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

  test('is registered in the model tool registry', () => {
    const registry = new ToolRegistry();

    registerAgentWorkPlanTool(registry, makeStore());

    expect(registry.has('agent_work_plan')).toBe(true);
  });
});
