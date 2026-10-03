import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { REASONING_EFFORT_SEVERITY } from '@goodvibes-jev/engine/sdk/platform/providers';
import {
  WORK_PLAN_STATUSES,
  type WorkPlanItem,
  type WorkPlanItemStatus,
  type WorkPlanStore,
} from '@goodvibes-jev/engine/sdk/platform/workflow';

export type AgentWorkPlanAction =
  | 'list'
  | 'get'
  | 'create'
  | 'update'
  | 'set_status'
  | 'dispatch_agents'
  | 'remove'
  | 'clear_completed';

export interface AgentWorkPlanToolArgs {
  readonly action?: unknown;
  readonly id?: unknown;
  readonly ids?: unknown;
  readonly title?: unknown;
  readonly status?: unknown;
  readonly owner?: unknown;
  readonly source?: unknown;
  readonly notes?: unknown;
  readonly template?: unknown;
  readonly model?: unknown;
  readonly provider?: unknown;
  readonly reasoningEffort?: unknown;
  readonly tools?: unknown;
  readonly successCriteria?: unknown;
  readonly requiredEvidence?: unknown;
  readonly writeScope?: unknown;
  readonly executionProtocol?: unknown;
  readonly reviewMode?: unknown;
  readonly communicationLane?: unknown;
  readonly cohort?: unknown;
  readonly agentContext?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

interface AgentWorkPlanToolOptions {
  readonly toolRegistry?: Pick<ToolRegistry, 'has' | 'execute'>;
}

const ACTIONS: readonly AgentWorkPlanAction[] = [
  'list',
  'get',
  'create',
  'update',
  'set_status',
  'dispatch_agents',
  'remove',
  'clear_completed',
];

function isAction(value: unknown): value is AgentWorkPlanAction {
  return typeof value === 'string' && ACTIONS.includes(value as AgentWorkPlanAction);
}

function isStatus(value: unknown): value is WorkPlanItemStatus {
  return typeof value === 'string' && WORK_PLAN_STATUSES.includes(value as WorkPlanItemStatus);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 'yes';
}

function readStringList(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.map(readString).filter((entry) => entry.length > 0);
  const text = readString(value);
  return text ? text.split(/[\n,]/).map((entry) => entry.trim()).filter((entry) => entry.length > 0) : [];
}

function failure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

function output(text: string): { readonly success: true; readonly output: string } {
  return { success: true, output: text };
}

function requireId(args: AgentWorkPlanToolArgs): string {
  const id = readString(args.id);
  if (!id) throw new Error('id is required.');
  return id;
}

function requireTitle(args: AgentWorkPlanToolArgs): string {
  const title = readString(args.title);
  if (!title) throw new Error('title is required.');
  return title;
}

function dispatchIds(args: AgentWorkPlanToolArgs): readonly string[] {
  const selected = [...readStringList(args.ids), readString(args.id)].filter((entry) => entry.length > 0);
  return [...new Set(selected)];
}

function readOptionalStatus(value: unknown): WorkPlanItemStatus | undefined {
  if (value === undefined || value === null || readString(value) === '') return undefined;
  if (!isStatus(value)) throw new Error(`Invalid status. Valid values ${WORK_PLAN_STATUSES.join(', ')}.`);
  return value;
}

function formatStatus(status: WorkPlanItemStatus): string {
  return status.replace(/_/g, ' ');
}

function formatItem(item: WorkPlanItem): string {
  const owner = item.owner ? ` owner ${item.owner}` : '';
  const source = item.source ? ` source=${item.source}` : '';
  const completed = item.completedAt ? ` completed ${new Date(item.completedAt).toISOString()}` : '';
  return `${item.id}  ${formatStatus(item.status)}${owner}${source}${completed}  ${item.title}`;
}

function routeArg(value: string): string {
  return JSON.stringify(value);
}

function agentRoute(mode: string, agentId: string): string {
  return `agent { mode: ${routeArg(mode)}, agentId: ${routeArg(agentId)} }`;
}

function workPlanRoute(action: string, id?: string, status?: WorkPlanItemStatus): string {
  return [
    `agent_work_plan action:${routeArg(action)}`,
    id ? `id:${routeArg(id)}` : '',
    status ? `status:${routeArg(status)}` : '',
  ].filter(Boolean).join(' ');
}

function linkedAgentId(item: WorkPlanItem): string {
  const value = item.linked?.agentId;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function nextRouteLine(id: string, route: string): string {
  return `    ${id} ${route}`;
}

function workPlanNextRouteLines(item: WorkPlanItem): readonly string[] {
  const agentId = linkedAgentId(item);
  const lines = [
    '  nextRoutes',
    nextRouteLine('inspectWorkItem', workPlanRoute('get', item.id)),
    nextRouteLine('markDone', workPlanRoute('set_status', item.id, 'done')),
    nextRouteLine('markBlocked', workPlanRoute('set_status', item.id, 'blocked')),
  ];
  if (agentId) {
    lines.push(
      nextRouteLine('inspectAgent', agentRoute('get', agentId)),
      nextRouteLine('waitAgent', agentRoute('wait', agentId)),
      nextRouteLine('messageAgent', agentRoute('message', agentId)),
      nextRouteLine('cancelAgent', agentRoute('cancel', agentId)),
      nextRouteLine('orchestrationDetail', `agent_harness mode:"agent_orchestration_agent" agentId:${routeArg(agentId)} includeParameters:true`),
    );
  }
  return lines;
}

function formatItemDetail(item: WorkPlanItem): string {
  return [
    formatItem(item),
    `created ${new Date(item.createdAt).toISOString()}`,
    `updated ${new Date(item.updatedAt).toISOString()}`,
    item.linked
      ? `linked ${Object.entries(item.linked).map(([key, value]) => `${key} ${String(value)}`).join(', ')}`
      : 'linked (none)',
    '',
    item.notes || '(no notes)',
    '',
    ...workPlanNextRouteLines(item),
  ].join('\n');
}

function previewText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 1))}...` : normalized;
}

function resolveItem(store: WorkPlanStore, idOrPrefix: string): WorkPlanItem {
  const needle = idOrPrefix.trim();
  if (!needle) throw new Error('id is required.');
  const items = store.listItems();
  const exact = items.find((item) => item.id === needle);
  if (exact) return exact;
  const matches = items.filter((item) => item.id.startsWith(needle));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`Work plan item id "${needle}" is ambiguous. Matches ${matches.map((item) => item.id).join(', ')}`);
  }
  throw new Error(`Work plan item not found ${needle}`);
}

function resolveDispatchItems(store: WorkPlanStore, args: AgentWorkPlanToolArgs): readonly WorkPlanItem[] {
  const ids = dispatchIds(args);
  if (ids.length === 0) throw new Error('id or ids is required for dispatch_agents.');
  return ids.map((id) => resolveItem(store, id));
}

function listOutput(store: WorkPlanStore): string {
  const plan = store.getActivePlan();
  const counts = new Map<WorkPlanItemStatus, number>(WORK_PLAN_STATUSES.map((status) => [status, 0]));
  for (const item of plan.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  const lines = [
    'Agent local work plan',
    `  plan ${plan.id}`,
    `  project ${plan.projectRoot}`,
    `  items ${plan.items.length}; pending ${counts.get('pending') ?? 0}; active ${counts.get('in_progress') ?? 0}; blocked ${counts.get('blocked') ?? 0}; done ${counts.get('done') ?? 0}`,
  ];
  if (plan.items.length === 0) {
    lines.push('', 'No local work plan items.');
    return lines.join('\n');
  }
  lines.push('', ...plan.items.slice(0, 20).map(formatItem));
  if (plan.items.length > 20) lines.push(`${plan.items.length - 20} more item(s) omitted.`);
  lines.push('', 'Visible dispatch route: agent_work_plan action:"dispatch_agents" ids:["..."] confirm:true explicitUserRequest:"..."');
  return lines.join('\n');
}

function requireDestructiveConfirmation(args: AgentWorkPlanToolArgs, action: string): string | null {
  const explicitUserRequest = readString(args.explicitUserRequest);
  if (!explicitUserRequest) return `explicitUserRequest is required before ${action}.`;
  if (!readBoolean(args.confirm)) {
    return [
      `Agent work plan ${action} preview`,
      '  policy destructive local work-plan changes require confirm:true and an explicit user request',
      `  request ${explicitUserRequest}`,
    ].join('\n');
  }
  return null;
}

function requireConfirmedDispatch(args: AgentWorkPlanToolArgs, items: readonly WorkPlanItem[], route: string): string | null {
  const explicitUserRequest = readString(args.explicitUserRequest);
  if (!explicitUserRequest) return 'explicitUserRequest is required before dispatching work plan items to visible agents.';
  if (readBoolean(args.confirm)) return null;
  return [
    'Agent work plan dispatch preview',
    '  policy visible agent dispatch requires confirm:true and an explicit user request',
    `  request ${previewText(explicitUserRequest, 160)}`,
    `  route ${route}`,
    `  selected ${items.length}`,
    ...items.map((item) => `  - ${item.id}  ${formatStatus(item.status)}  ${previewText(item.title, 120)}`),
    '  no agents were spawned and no work-plan receipts were written',
  ].join('\n');
}

function updatePatch(args: AgentWorkPlanToolArgs): Parameters<WorkPlanStore['updateItem']>[1] {
  const status = readOptionalStatus(args.status);
  return {
    ...(args.title !== undefined ? { title: requireTitle(args) } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(args.owner !== undefined ? { owner: readString(args.owner) || null } : {}),
    ...(args.source !== undefined ? { source: readString(args.source) || null } : {}),
    ...(args.notes !== undefined ? { notes: readString(args.notes) || null } : {}),
  };
}

function optionalStringProperty(value: unknown): string | undefined {
  return readString(value) || undefined;
}

function optionalStringListProperty(value: unknown): readonly string[] | undefined {
  const entries = readStringList(value);
  return entries.length > 0 ? entries : undefined;
}

function workPlanAgentContext(item: WorkPlanItem, args: AgentWorkPlanToolArgs): string {
  return [
    readString(args.agentContext),
    `Work plan item id: ${item.id}`,
    `Work plan item title: ${item.title}`,
    item.owner ? `Work plan owner: ${item.owner}` : '',
    item.source ? `Work plan source: ${item.source}` : '',
    item.notes ? `Work plan notes:\n${item.notes}` : '',
    'Keep progress visible, return evidence, and make the final status easy for the user to review.',
  ].filter((part) => part.trim().length > 0).join('\n\n');
}

function agentTaskForItem(item: WorkPlanItem, args: AgentWorkPlanToolArgs): Record<string, unknown> {
  return {
    task: item.title,
    ...(optionalStringProperty(args.template) ? { template: optionalStringProperty(args.template) } : {}),
    ...(optionalStringProperty(args.model) ? { model: optionalStringProperty(args.model) } : {}),
    ...(optionalStringProperty(args.provider) ? { provider: optionalStringProperty(args.provider) } : {}),
    ...(optionalStringProperty(args.reasoningEffort) ? { reasoningEffort: optionalStringProperty(args.reasoningEffort) } : {}),
    ...(optionalStringListProperty(args.tools) ? { tools: optionalStringListProperty(args.tools), restrictTools: true } : {}),
    ...(optionalStringListProperty(args.successCriteria) ? { successCriteria: optionalStringListProperty(args.successCriteria) } : {}),
    requiredEvidence: optionalStringListProperty(args.requiredEvidence) ?? ['result summary', 'verification or blocker', 'changed files or artifacts when applicable'],
    ...(optionalStringListProperty(args.writeScope) ? { writeScope: optionalStringListProperty(args.writeScope) } : {}),
    ...(optionalStringProperty(args.executionProtocol) ? { executionProtocol: optionalStringProperty(args.executionProtocol) } : {}),
    ...(optionalStringProperty(args.reviewMode) ? { reviewMode: optionalStringProperty(args.reviewMode) } : {}),
    ...(optionalStringProperty(args.communicationLane) ? { communicationLane: optionalStringProperty(args.communicationLane) } : {}),
    context: workPlanAgentContext(item, args),
    orchestrationNodeId: item.id,
  };
}

function parseAgentToolOutput(outputText: string): Record<string, unknown> {
  const parsed = JSON.parse(outputText) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('agent tool returned non-object output.');
  return parsed as Record<string, unknown>;
}

function agentIdsFromDispatchPayload(payload: Record<string, unknown>): readonly string[] {
  const direct = readString(payload.agentId);
  if (direct) return [direct];
  if (!Array.isArray(payload.agents)) return [];
  return payload.agents
    .map((entry) => entry && typeof entry === 'object' ? readString((entry as Record<string, unknown>).id) || readString((entry as Record<string, unknown>).agentId) : '')
    .filter((entry) => entry.length > 0);
}

function appendDispatchReceipt(notes: string | undefined, agentId: string, route: string, cohort: string, explicitUserRequest: string): string {
  const receipt = [
    `Agent dispatch receipt ${new Date().toISOString()}`,
    `agent ${agentId}`,
    `route ${route}`,
    `cohort ${cohort}`,
    `request ${previewText(explicitUserRequest, 160)}`,
  ].join('; ');
  return [notes?.trim() ?? '', receipt].filter((part) => part.length > 0).join('\n\n');
}

function dispatchNextRouteLines(receipts: readonly { readonly item: WorkPlanItem; readonly agentId: string }[]): readonly string[] {
  return [
    '  nextRoutes',
    nextRouteLine('orchestration', 'agent_harness mode:"agent_orchestration" includeParameters:true'),
    nextRouteLine('workPlan', 'agent_work_plan action:"list"'),
    ...receipts.flatMap((receipt, index) => {
      const prefix = receipts.length > 1 ? `agent${index + 1}` : 'agent';
      return [
        nextRouteLine(`${prefix}.inspect`, agentRoute('get', receipt.agentId)),
        nextRouteLine(`${prefix}.wait`, agentRoute('wait', receipt.agentId)),
        nextRouteLine(`${prefix}.message`, agentRoute('message', receipt.agentId)),
        nextRouteLine(`${prefix}.cancel`, agentRoute('cancel', receipt.agentId)),
        nextRouteLine(`${prefix}.workItem`, workPlanRoute('get', receipt.item.id)),
      ];
    }),
  ];
}

async function dispatchAgentsFromWorkPlan(
  store: WorkPlanStore,
  args: AgentWorkPlanToolArgs,
  options: AgentWorkPlanToolOptions,
): Promise<{ readonly success: true; readonly output: string } | { readonly success: false; readonly error: string }> {
  if (!options.toolRegistry || !options.toolRegistry.has('agent')) {
    return failure('agent_work_plan dispatch_agents requires the first-class agent tool to be registered.');
  }
  const items = resolveDispatchItems(store, args);
  const plan = store.getActivePlan();
  const cohort = readString(args.cohort) || `workplan-${plan.id}`;
  const route = items.length === 1 ? 'agent { mode: "spawn" }' : 'agent { mode: "batch-spawn" }';
  const denied = requireConfirmedDispatch(args, items, route);
  if (denied) return failure(denied);
  const explicitUserRequest = readString(args.explicitUserRequest);
  const commonArgs = {
    authoritativeTask: explicitUserRequest,
    cohort,
    orchestrationGraphId: `workplan:${plan.id}`,
  };
  const agentArgs = items.length === 1
    ? {
        mode: 'spawn',
        ...commonArgs,
        ...agentTaskForItem(items[0]!, args),
      }
    : {
        mode: 'batch-spawn',
        ...commonArgs,
        tasks: items.map((item) => agentTaskForItem(item, args)),
      };
  const result = await options.toolRegistry.execute(`agent-work-plan-dispatch-${Date.now()}`, 'agent', agentArgs);
  if (!result.success) return failure(result.error ?? 'Agent dispatch failed.');
  const payload = parseAgentToolOutput(result.output ?? '{}');
  const agentIds = agentIdsFromDispatchPayload(payload);
  if (agentIds.length === 0) return failure('Agent dispatch succeeded but returned no agent ids to attach to the work plan.');
  const receipts = items.map((item, index) => {
    const agentId = agentIds[Math.min(index, agentIds.length - 1)]!;
    const updated = store.updateItem(item.id, {
      status: item.status === 'done' || item.status === 'cancelled' ? item.status : 'in_progress',
      linked: { ...(item.linked ?? {}), agentId },
      notes: appendDispatchReceipt(item.notes, agentId, route, cohort, explicitUserRequest),
    });
    return { item: updated, agentId };
  });
  return output([
    'Dispatched Agent work plan items',
    `  route ${route}`,
    `  cohort ${cohort}`,
    `  saved receipts ${receipts.length}`,
    ...receipts.map((receipt) => `  - ${receipt.item.id} -> ${receipt.agentId}  ${previewText(receipt.item.title, 100)}`),
    ...dispatchNextRouteLines(receipts),
  ].join('\n'));
}

export function createAgentWorkPlanTool(store: WorkPlanStore, options: AgentWorkPlanToolOptions = {}): Tool {
  return {
    definition: {
      name: 'agent_work_plan',
      description: 'Manage and dispatch approved visible Agent work plan items.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...ACTIONS] },
          id: { type: 'string', description: 'Work plan item id or unique id prefix for get/update/set_status/remove.' },
          ids: { type: 'array', items: { type: 'string' }, description: 'Work plan item ids or unique prefixes for dispatch_agents.' },
          title: { type: 'string', description: 'Work plan item title for create/update.' },
          status: { type: 'string', enum: [...WORK_PLAN_STATUSES], description: 'Work plan item status.' },
          owner: { type: 'string', description: 'Optional owner label.' },
          source: { type: 'string', description: 'Optional source/provenance label.' },
          notes: { type: 'string', description: 'Optional work-plan notes.' },
          template: { type: 'string', description: 'Agent template for dispatch_agents.' },
          model: { type: 'string', description: 'Provider-qualified model for dispatch_agents.' },
          provider: { type: 'string', description: 'Provider id for dispatch_agents when model is provider-qualified.' },
          reasoningEffort: { type: 'string', enum: [...REASONING_EFFORT_SEVERITY], description: 'Reasoning effort for dispatch_agents; unsupported levels snap down.' },
          tools: { type: 'array', items: { type: 'string' }, description: 'Exact tool subset for dispatched agents.' },
          successCriteria: { type: 'array', items: { type: 'string' }, description: 'Success criteria for dispatched agents.' },
          requiredEvidence: { type: 'array', items: { type: 'string' }, description: 'Required evidence for dispatched agents.' },
          writeScope: { type: 'array', items: { type: 'string' }, description: 'Expected write scope for dispatched agents.' },
          executionProtocol: { type: 'string', enum: ['direct', 'gather-plan-apply'], description: 'Execution protocol for dispatch_agents.' },
          reviewMode: { type: 'string', enum: ['none', 'wrfc'], description: 'Review mode for dispatch_agents.' },
          communicationLane: { type: 'string', enum: ['parent-only', 'parent-and-children', 'cohort', 'direct'], description: 'Communication lane for dispatch_agents.' },
          cohort: { type: 'string', description: 'Agent cohort for dispatch_agents. Defaults to the work plan id.' },
          agentContext: { type: 'string', description: 'Additional context prepended to each dispatched agent task.' },
          confirm: { type: 'boolean', description: 'Required true for remove, clear_completed, and dispatch_agents.' },
          explicitUserRequest: { type: 'string', description: 'Required for remove, clear_completed, and agent dispatch.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      sideEffects: ['state', 'agent', 'workflow'],
    },
    execute: async (rawArgs: unknown) => {
      try {
        const args = rawArgs as AgentWorkPlanToolArgs;
        if (!isAction(args.action)) return failure(`Unknown Agent work plan action. Valid values ${ACTIONS.join(', ')}.`);
        if (args.action === 'list') return output(listOutput(store));
        if (args.action === 'get') return output(formatItemDetail(resolveItem(store, requireId(args))));
        if (args.action === 'dispatch_agents') return dispatchAgentsFromWorkPlan(store, args, options);
        if (args.action === 'create') {
          const item = store.addItem(requireTitle(args), {
            status: readOptionalStatus(args.status) ?? 'pending',
            owner: readString(args.owner) || 'agent',
            source: readString(args.source) || 'main-conversation',
            notes: readString(args.notes) || undefined,
          });
          return output([
            'Created Agent work plan item',
            `  id ${item.id}`,
            `  title ${item.title}`,
          ].join('\n'));
        }
        if (args.action === 'update') {
          const item = store.updateItem(requireId(args), updatePatch(args));
          return output([
            'Updated Agent work plan item',
            `  id ${item.id}`,
            `  title ${item.title}`,
          ].join('\n'));
        }
        if (args.action === 'set_status') {
          const status = readOptionalStatus(args.status);
          if (!status) throw new Error('status is required.');
          const item = store.setItemStatus(requireId(args), status);
          return output([
            'Set Agent work plan item status',
            `  id ${item.id}`,
            `  status ${formatStatus(item.status)}`,
            `  title ${item.title}`,
          ].join('\n'));
        }
        if (args.action === 'remove') {
          const denied = requireDestructiveConfirmation(args, `remove ${readString(args.id) || '(missing id)'}`);
          if (denied) return failure(denied);
          const item = store.removeItem(requireId(args));
          return output([
            'Removed Agent work plan item',
            `  id ${item.id}`,
            `  title ${item.title}`,
          ].join('\n'));
        }
        const denied = requireDestructiveConfirmation(args, 'clear completed');
        if (denied) return failure(denied);
        const count = store.clearCompleted();
        return output([
          `Cleared ${count} completed/cancelled Agent work plan items`,
          `  count ${count}`,
        ].join('\n'));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function registerAgentWorkPlanTool(registry: ToolRegistry, store: WorkPlanStore): void {
  registry.register(createAgentWorkPlanTool(store, { toolRegistry: registry }));
}
