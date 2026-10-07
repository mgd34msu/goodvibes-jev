import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
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

/** Compatibility only: the registry is never used to dispatch legacy todos. */
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
    'Local status only; done is not native verified completion.',
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

function listOutput(store: WorkPlanStore): string {
  const plan = store.getActivePlan();
  const counts = new Map<WorkPlanItemStatus, number>(WORK_PLAN_STATUSES.map((status) => [status, 0]));
  for (const item of plan.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  const lines = [
    'Agent local work plan',
    '  Local todos only. Adding or updating does not execute work; local done is not native verified completion.',
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
  lines.push('', 'Native owner route: /work submit-file <JSON-path>; submission does not start execution.');
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

export function createAgentWorkPlanTool(store: WorkPlanStore, _options: AgentWorkPlanToolOptions = {}): Tool {
  return {
    definition: {
      name: 'agent_work_plan',
      description: 'Manage local, non-executing Agent todo records. Local done is not native verified completion.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ACTIONS.filter(action => action !== 'dispatch_agents') },
          id: { type: 'string', description: 'Work plan item id or unique id prefix for get/update/set_status/remove.' },
          title: { type: 'string', description: 'Work plan item title for create/update.' },
          status: { type: 'string', enum: [...WORK_PLAN_STATUSES], description: 'Work plan item status.' },
          owner: { type: 'string', description: 'Optional owner label.' },
          source: { type: 'string', description: 'Optional source/provenance label.' },
          notes: { type: 'string', description: 'Optional work-plan notes.' },
          confirm: { type: 'boolean', description: 'Required true for remove and clear_completed.' },
          explicitUserRequest: { type: 'string', description: 'Required for remove and clear_completed; never native owner authority.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      sideEffects: ['state'],
    },
    execute: async (rawArgs: unknown) => {
      try {
        const args = rawArgs as AgentWorkPlanToolArgs;
        if (!isAction(args.action)) return failure(`Unknown Agent work plan action. Valid values ${ACTIONS.join(', ')}.`);
        if (args.action === 'list') return output(listOutput(store));
        if (args.action === 'get') return output(formatItemDetail(resolveItem(store, requireId(args))));
        if (args.action === 'dispatch_agents') return failure('Legacy work-plan dispatch is unavailable: model fields, labels, and explicitUserRequest are not original owner authority. Keep this as a local todo, or have the owner submit exact source through /work submit-file <JSON-path> (recover with /work submission-status or /work submission-retry). Submission does not start execution.');
        if (args.action === 'create') {
          const item = store.addItem(requireTitle(args), {
            status: readOptionalStatus(args.status) ?? 'pending',
            owner: readString(args.owner) || 'agent',
            source: readString(args.source) || 'main-conversation',
            notes: readString(args.notes) || undefined,
          });
          return output([
            'Created Agent work plan item',
            '  Local todo only; no native work was submitted or executed.',
            `  id ${item.id}`,
            `  title ${item.title}`,
          ].join('\n'));
        }
        if (args.action === 'update') {
          const item = store.updateItem(requireId(args), updatePatch(args));
          return output([
            'Updated Agent work plan item',
            '  Local record only; no execution. Local done is not native verified completion.',
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
            '  Local status only; done is not native verified completion.',
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
  registry.register(createAgentWorkPlanTool(store));
}
