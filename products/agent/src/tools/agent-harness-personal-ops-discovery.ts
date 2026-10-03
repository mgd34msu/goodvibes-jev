import { getOperatorContract } from '@goodvibes-jev/engine/sdk/contracts';
import type { CommandContext } from '../input/command-registry.ts';
import type { McpSchemaSummary, McpToolRecord, McpToolSchema, OperatorContractMethod, PersonalOpsConnectorSignal, PersonalOpsConnectorTool, PersonalOpsWorkflow, PersonalOpsWorkflowStatus } from './agent-harness-personal-ops-types.ts';

export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(12, Math.trunc(parsed)));
}

export function hasAny(text: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => text.includes(token));
}

export function operatorContractMethods(): readonly OperatorContractMethod[] {
  const contract = getOperatorContract();
  const methods = Array.isArray(contract.operator?.methods)
    ? contract.operator.methods as OperatorContractMethod[]
    : [];
  return methods.filter((method) => method.id);
}

export function methodSearchText(method: OperatorContractMethod): string {
  return [
    method.id,
    method.title,
    method.description,
    method.category,
    method.http?.method,
    method.http?.path,
  ].filter(Boolean).join('\n').toLowerCase();
}

/**
 * Capability honesty: a method whose contract entry carries
 * invokable:false is cataloged but NOT dispatchable, no daemon route or
 * handler serves it. Counting it toward "workflow ready" would repeat the
 * dogfood finding (a lane card claiming readiness backed only by methods a
 * caller cannot actually invoke). Absent flag = invokable (older contracts).
 */
export function isInvokableContractMethod(method: OperatorContractMethod): boolean {
  return method.invokable !== false;
}

function matchingContractMethods(tokens: readonly string[]): readonly OperatorContractMethod[] {
  if (tokens.length === 0) return [];
  return operatorContractMethods().filter((method) => {
    const text = methodSearchText(method);
    return tokens.some((token) => text.includes(token));
  });
}

/**
 * Method ids matching the tokens that are actually DISPATCHABLE. Readiness
 * (workflowStatus, lane status, capability counts) must be computed from
 * this list only, advertised-but-unavailable methods are returned
 * separately by unavailableMethodIdsMatching for honest degraded wording.
 */
export function methodIdsMatching(tokens: readonly string[]): readonly string[] {
  return matchingContractMethods(tokens)
    .filter(isInvokableContractMethod)
    .map((method) => method.id)
    .sort((left, right) => left.localeCompare(right));
}

/** Method ids matching the tokens that are cataloged but NOT dispatchable (invokable:false). */
export function unavailableMethodIdsMatching(tokens: readonly string[]): readonly string[] {
  return matchingContractMethods(tokens)
    .filter((method) => !isInvokableContractMethod(method))
    .map((method) => method.id)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * One honest line naming advertised-but-undispatchable methods, matching the
 * degraded-ad pattern ("unavailable (route not served by this daemon)").
 * Returns null when nothing is degraded.
 */
export function unavailableMethodsNote(unavailableMethodIds: readonly string[]): string | null {
  if (unavailableMethodIds.length === 0) return null;
  return `${unavailableMethodIds.length} advertised method(s) are unavailable (route not served by this daemon) and cannot be dispatched: ${unavailableMethodIds.join(', ')}.`;
}

export function mcpServerRecords(context: CommandContext): readonly {
  readonly name: string;
  readonly connected: boolean;
  readonly trustMode: string;
  readonly role: string;
  readonly schemaFreshness: string;
  readonly allowedHosts: readonly string[];
}[] {
  const api = context.clients?.mcpApi ?? context.extensions?.mcpRegistry;
  if (!api || typeof api.listServerSecurity !== 'function') return [];
  try {
    return api.listServerSecurity();
  } catch {
    return [];
  }
}

export async function mcpToolRecords(context: CommandContext): Promise<readonly McpToolRecord[]> {
  const api = context.clients?.mcpApi ?? context.extensions?.mcpRegistry;
  if (!api || typeof (api as { readonly listAllTools?: unknown }).listAllTools !== 'function') return [];
  try {
    return await (api as { listAllTools: () => Promise<readonly McpToolRecord[]> }).listAllTools();
  } catch {
    return [];
  }
}

export function mcpSchemaReader(context: CommandContext): ((qualifiedName: string) => Promise<McpToolSchema | null>) | null {
  const api = context.clients?.mcpApi ?? context.extensions?.mcpRegistry;
  if (!api || typeof (api as { readonly getToolSchema?: unknown }).getToolSchema !== 'function') return null;
  return (qualifiedName) => (api as { getToolSchema: (qualifiedName: string) => Promise<McpToolSchema | null> }).getToolSchema(qualifiedName);
}

export function mcpToolCaller(context: CommandContext): ((qualifiedName: string, input: Readonly<Record<string, unknown>>) => Promise<unknown>) | null {
  const api = context.clients?.mcpApi ?? context.extensions?.mcpRegistry;
  if (!api || typeof (api as { readonly callTool?: unknown }).callTool !== 'function') return null;
  return (qualifiedName, input) => (api as { callTool: (qualifiedName: string, input: Readonly<Record<string, unknown>>) => Promise<unknown> }).callTool(qualifiedName, input);
}

export function qualifiedToolName(tool: McpToolRecord): string {
  return tool.qualifiedName ?? `mcp:${tool.serverName}:${tool.toolName}`;
}

export function isPersonalOpsTool(tool: McpToolRecord): boolean {
  return /(mail|email|gmail|imap|smtp|inbox|message|thread|calendar|caldav|agenda|event|freebusy|availability|meeting)/i.test([
    tool.serverName,
    tool.toolName,
    tool.description ?? '',
  ].join(' '));
}

export function schemaObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function schemaRequiredFields(schema: Record<string, unknown>): readonly string[] {
  const required = schema.required;
  if (!Array.isArray(required)) return [];
  return required.filter((field): field is string => typeof field === 'string').sort((left, right) => left.localeCompare(right));
}

export function schemaOptionalFields(schema: Record<string, unknown>, requiredFields: readonly string[]): readonly string[] {
  const properties = schemaObject(schema.properties);
  if (!properties) return [];
  const required = new Set(requiredFields);
  return Object.keys(properties).filter((field) => !required.has(field)).sort((left, right) => left.localeCompare(right));
}

export function sampleFieldValue(field: string, capability: string, effect: PersonalOpsConnectorTool['effect']): unknown {
  const normalized = field.toLowerCase();
  if (/(limit|max|count|page|size)/.test(normalized)) return 10;
  if (/(dry|preview)/.test(normalized)) return effect === 'confirmed-effect';
  if (/(unread|important|include)/.test(normalized)) return true;
  if (/(start|from|after|time_min|timemin|begin)/.test(normalized)) return capability.startsWith('calendar') ? '<start-iso>' : '<since>';
  if (/(end|to|before|time_max|timemax|until)/.test(normalized)) return capability.startsWith('calendar') ? '<end-iso>' : '<until>';
  if (/(thread|message|mail|email).*id|id$/.test(normalized)) return capability.startsWith('calendar') ? '<event-id>' : '<message-or-thread-id>';
  if (/(event).*id|calendar.*id/.test(normalized)) return '<calendar-or-event-id>';
  if (/(query|search|q|filter)/.test(normalized)) return capability.startsWith('calendar') ? 'today' : 'is:unread newer_than:7d';
  if (/(mailbox|folder|label)/.test(normalized)) return capability.startsWith('calendar') ? '<calendar-name>' : '<mailbox-or-label>';
  if (/(calendar|account|profile)/.test(normalized)) return '<account-or-calendar>';
  if (/(subject|title|summary)/.test(normalized)) return '<reviewed subject>';
  if (/(body|text|message|content|reply|draft|description|note)/.test(normalized)) return '<reviewed draft text>';
  if (/(attendee|participant|invitee)/.test(normalized)) return ['<attendee@example.com>'];
  return `<${field}>`;
}

export function sampleInputForFields(
  requiredFields: readonly string[],
  optionalFields: readonly string[],
  capability: string,
  effect: PersonalOpsConnectorTool['effect'],
): Readonly<Record<string, unknown>> {
  const fields = [...requiredFields, ...optionalFields.slice(0, Math.max(0, 4 - requiredFields.length))];
  const sample: Record<string, unknown> = {};
  for (const field of fields) sample[field] = sampleFieldValue(field, capability, effect);
  return sample;
}

export function summarizeInputSchema(
  qualifiedName: string,
  inputSchema: unknown,
  capability: string,
  effect: PersonalOpsConnectorTool['effect'],
): McpSchemaSummary | null {
  const schema = schemaObject(inputSchema);
  if (!schema) return null;
  const requiredFields = schemaRequiredFields(schema);
  const optionalFields = schemaOptionalFields(schema, requiredFields);
  return {
    schemaRoute: `mcp schema qualifiedName:"${qualifiedName}"`,
    requiredFields,
    optionalFields,
    sampleInput: sampleInputForFields(requiredFields, optionalFields, capability, effect),
  };
}

export async function mcpToolSchemas(
  context: CommandContext,
  tools: readonly McpToolRecord[],
): Promise<ReadonlyMap<string, McpToolSchema>> {
  const readSchema = mcpSchemaReader(context);
  if (!readSchema) return new Map();
  const schemas = new Map<string, McpToolSchema>();
  const candidates = tools.filter(isPersonalOpsTool).slice(0, 50);
  for (const tool of candidates) {
    const qualifiedName = qualifiedToolName(tool);
    try {
      const schema = await readSchema(qualifiedName);
      if (schema) schemas.set(qualifiedName, schema);
    } catch {
      // Schema lookup is best-effort. Personal Ops must keep connector readiness usable even when one MCP server fails schema expansion.
    }
  }
  return schemas;
}

export function toolsByServer(tools: readonly McpToolRecord[]): ReadonlyMap<string, readonly McpToolRecord[]> {
  const grouped = new Map<string, McpToolRecord[]>();
  for (const tool of tools) {
    const entries = grouped.get(tool.serverName) ?? [];
    entries.push(tool);
    grouped.set(tool.serverName, entries);
  }
  return grouped;
}

export function mcpServerSearchText(server: ReturnType<typeof mcpServerRecords>[number]): string {
  return [
    server.name,
    server.connected ? 'connected' : 'disconnected',
    server.trustMode,
    server.role,
    server.schemaFreshness,
    ...server.allowedHosts,
  ].join('\n').toLowerCase();
}

export function toolCapability(tool: McpToolRecord, lane: 'inbox' | 'calendar'): PersonalOpsConnectorTool | null {
  const text = [tool.toolName, tool.description ?? ''].join(' ').toLowerCase();
  const record = (effect: PersonalOpsConnectorTool['effect'], capability: string): PersonalOpsConnectorTool => ({
    name: tool.toolName,
    qualifiedName: qualifiedToolName(tool),
    ...(tool.description ? { description: tool.description } : {}),
    effect,
    capability,
  });
  if (lane === 'inbox') {
    if (/(send|reply|draft|compose|archive|label|delete|trash|mark|move)/.test(text)) {
      return record('confirmed-effect', 'inbox-write');
    }
    if (/(mail|email|gmail|imap|smtp|inbox|message|thread)/.test(text) && /(list|search|get|read|fetch|find|unread|query)/.test(text)) {
      return record('read-only', 'inbox-read');
    }
  } else {
    if (/(create|update|edit|delete|cancel|invite|rsvp|move|reschedule)/.test(text)) {
      return record('confirmed-effect', 'calendar-write');
    }
    if (/(calendar|caldav|agenda|event|freebusy|availability|meeting)/.test(text) && /(list|search|get|read|fetch|find|query|window|upcoming)/.test(text)) {
      return record('read-only', 'calendar-read');
    }
  }
  return null;
}

export function connectorToolSummary(tools: readonly McpToolRecord[], lane: 'inbox' | 'calendar'): {
  readonly readTools: readonly PersonalOpsConnectorTool[];
  readonly writeTools: readonly PersonalOpsConnectorTool[];
  readonly capabilityTags: readonly string[];
} {
  const classified = tools
    .map((tool) => toolCapability(tool, lane))
    .filter((tool): tool is PersonalOpsConnectorTool => tool !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
  const readTools = classified.filter((tool) => tool.effect === 'read-only');
  const writeTools = classified.filter((tool) => tool.effect === 'confirmed-effect');
  const capabilityTags = [...new Set(classified.map((tool) => tool.capability))].sort((left, right) => left.localeCompare(right));
  return { readTools, writeTools, capabilityTags };
}

export function enrichConnectorToolsWithSchemas(
  tools: readonly PersonalOpsConnectorTool[],
  schemasByQualifiedName: ReadonlyMap<string, McpToolSchema>,
): readonly PersonalOpsConnectorTool[] {
  return tools.map((tool) => {
    if (!tool.qualifiedName) return tool;
    const schema = schemasByQualifiedName.get(tool.qualifiedName);
    const summary = summarizeInputSchema(tool.qualifiedName, schema?.inputSchema, tool.capability, tool.effect);
    if (!summary) return tool;
    return {
      ...tool,
      schemaRoute: summary.schemaRoute,
      requiredFields: summary.requiredFields,
      optionalFields: summary.optionalFields,
      sampleInput: summary.sampleInput,
    };
  });
}

export function connectorSignalsMatching(
  context: CommandContext,
  tokens: readonly string[],
  options: {
    readonly lane: 'inbox' | 'calendar';
    readonly toolsByServer: ReadonlyMap<string, readonly McpToolRecord[]>;
    readonly schemasByQualifiedName: ReadonlyMap<string, McpToolSchema>;
  },
): readonly PersonalOpsConnectorSignal[] {
  if (tokens.length === 0) return [];
  return mcpServerRecords(context)
    .filter((server) => {
      const text = mcpServerSearchText(server);
      return tokens.some((token) => text.includes(token));
    })
    .map((server) => {
      const ready = server.connected && server.schemaFreshness === 'fresh' && server.trustMode !== 'blocked';
      const serverTools = options.toolsByServer.get(server.name) ?? [];
      const toolSummary = connectorToolSummary(serverTools, options.lane);
      const readTools = enrichConnectorToolsWithSchemas(toolSummary.readTools, options.schemasByQualifiedName);
      const writeTools = enrichConnectorToolsWithSchemas(toolSummary.writeTools, options.schemasByQualifiedName);
      return {
        id: `mcp:${server.name}`,
        kind: 'mcp-server' as const,
        label: server.name,
        status: ready ? 'ready' as const : 'attention' as const,
        summary: [
          `${server.connected ? 'connected' : 'disconnected'} ${server.trustMode} ${server.schemaFreshness}`,
          serverTools.length > 0 ? `${serverTools.length} tool(s)` : '',
          toolSummary.capabilityTags.length > 0 ? toolSummary.capabilityTags.join(', ') : '',
        ].filter(Boolean).join('; '),
        modelRoute: `agent_harness mode:"mcp_server" mcpServerId:"${server.name}"`,
        toolCount: serverTools.length,
        capabilityTags: toolSummary.capabilityTags,
        ...(readTools.length > 0 ? { readTools: readTools.slice(0, 8) } : {}),
        ...(writeTools.length > 0 ? { writeTools: writeTools.slice(0, 8) } : {}),
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function connectorReady(signals: readonly PersonalOpsConnectorSignal[]): boolean {
  return signals.some((signal) => signal.status === 'ready');
}

export function connectorToolCount(signals: readonly PersonalOpsConnectorSignal[], effect: PersonalOpsConnectorTool['effect']): number {
  return signals.reduce((total, signal) => total + (effect === 'read-only' ? signal.readTools?.length ?? 0 : signal.writeTools?.length ?? 0), 0);
}

export function workflowStatus(methodIds: readonly string[], connectors: readonly PersonalOpsConnectorSignal[]): PersonalOpsWorkflowStatus {
  if (connectorReady(connectors)) return 'ready';
  if (connectors.length > 0) return 'attention';
  if (methodIds.length > 0) return 'ready';
  return 'needs-setup';
}

export function workflowModelRoute(
  methodQuery: string,
  connectors: readonly PersonalOpsConnectorSignal[],
): string {
  const readyConnector = connectors.find((signal) => signal.status === 'ready') ?? connectors[0];
  if (readyConnector) return readyConnector.modelRoute;
  return `host action:"methods" query:"${methodQuery}"`;
}

export function workflowInspectRoutes(methodIds: readonly string[], connectors: readonly PersonalOpsConnectorSignal[], fallbackQuery: string): readonly string[] {
  const connectorRoutes = connectors.map((signal) => signal.modelRoute);
  const methodRoutes = methodIds.slice(0, 6).map((methodId) => `host action:"method" methodId:"${methodId}"`);
  const routes = [...connectorRoutes, ...methodRoutes];
  return routes.length > 0 ? routes : [`personal_ops action:"lane" laneId:"${fallbackQuery}"`];
}

export function inboxWorkflows(methodIds: readonly string[], connectors: readonly PersonalOpsConnectorSignal[], unavailableMethodIds: readonly string[] = []): readonly PersonalOpsWorkflow[] {
  const status = workflowStatus(methodIds, connectors);
  const inspectRoutes = workflowInspectRoutes(methodIds, connectors, 'inbox');
  const modelRoute = workflowModelRoute('email', connectors);
  const readToolCount = connectorToolCount(connectors, 'read-only');
  const writeToolCount = connectorToolCount(connectors, 'confirmed-effect');
  const degradedAdNote = unavailableMethodsNote(unavailableMethodIds);
  const setupPrerequisite = status === 'needs-setup'
    ? [
      'Connect a Google account first with /google connect, or take up credentials already on this machine with /google adopt.',
      ...(degradedAdNote ? [degradedAdNote] : []),
    ]
    : status === 'attention'
      ? ['Review connector trust/schema freshness before reading inbox data.']
      : [
        'Inspect the exact connector or daemon method schema before selecting inbox actions.',
        readToolCount > 0
          ? `${readToolCount} classified read-only inbox tool(s) are available.`
          : 'No classified read-only inbox tools were returned; inspect the connector schema before claiming live inbox access.',
      ];
  return [
    {
      id: 'inbox-triage-briefing',
      label: 'Inbox triage briefing',
      status,
      summary: 'Summarize unread or high-priority inbound messages without sending mail.',
      next: status === 'ready'
        ? 'Inspect the connector/method, list candidate messages, then summarize priorities and risks in the main conversation.'
        : 'Finish email connector setup before attempting inbox triage.',
      modelRoute,
      inspectRoutes,
      prerequisites: setupPrerequisite,
      runBoundary: 'Read/list/search can run only through the reviewed connector or daemon method; sends and mutations require explicit confirmation.',
    },
    {
      id: 'inbox-draft-reply',
      label: 'Draft reply review',
      status,
      summary: 'Draft replies for selected messages while keeping send as a separate confirmed action.',
      next: status === 'ready'
        ? 'Read the selected thread through the connector, draft in chat, then ask for confirmation before any send route.'
        : 'Finish email connector setup before drafting from live threads.',
      modelRoute,
      inspectRoutes,
      prerequisites: [
        ...setupPrerequisite,
        'The user must identify the account, mailbox, or message selection.',
        writeToolCount > 0
          ? `${writeToolCount} write-like inbox tool(s) require explicit confirmation before send, label, archive, delete, or move effects.`
          : 'No write-like inbox tools were classified; keep sending and mailbox mutation out of scope until a connector route is inspected.',
      ],
      runBoundary: 'Drafting is conversation output; sending or labeling stays on the connector/tool route with confirmation.',
    },
  ];
}

export function calendarWorkflows(methodIds: readonly string[], connectors: readonly PersonalOpsConnectorSignal[], unavailableMethodIds: readonly string[] = []): readonly PersonalOpsWorkflow[] {
  const status = workflowStatus(methodIds, connectors);
  const inspectRoutes = workflowInspectRoutes(methodIds, connectors, 'calendar');
  const modelRoute = workflowModelRoute('calendar', connectors);
  const readToolCount = connectorToolCount(connectors, 'read-only');
  const writeToolCount = connectorToolCount(connectors, 'confirmed-effect');
  const degradedAdNote = unavailableMethodsNote(unavailableMethodIds);
  const setupPrerequisite = status === 'needs-setup'
    ? [
      'Connect a Google account first with /google connect, or subscribe to a calendar feed with /calendar subscribe.',
      ...(degradedAdNote ? [degradedAdNote] : []),
    ]
    : status === 'attention'
      ? ['Review connector trust/schema freshness before reading calendar data.']
      : [
        'Inspect the exact connector or daemon method schema before selecting agenda actions.',
        readToolCount > 0
          ? `${readToolCount} classified read-only calendar tool(s) are available.`
          : 'No classified read-only calendar tools were returned; inspect the connector schema before claiming live agenda access.',
      ];
  return [
    {
      id: 'calendar-agenda-briefing',
      label: 'Agenda briefing',
      status,
      summary: 'Read upcoming events and prepare a concise day or week briefing.',
      next: status === 'ready'
        ? 'Inspect the connector/method, fetch the requested window, then summarize agenda context and prep items.'
        : 'Finish calendar connector setup before attempting agenda briefing.',
      modelRoute,
      inspectRoutes,
      prerequisites: [...setupPrerequisite, 'The user must provide a date range or accept a bounded default window.'],
      runBoundary: 'Calendar reads can run only through reviewed connector/method routes; event edits require explicit confirmation.',
    },
    {
      id: 'calendar-conflict-scan',
      label: 'Conflict scan',
      status,
      summary: 'Detect overlapping events or prep gaps and offer reminders instead of editing the calendar silently.',
      next: status === 'ready'
        ? 'Inspect the agenda source, scan the requested window, then propose reminders or follow-ups for confirmation.'
        : 'Finish calendar connector setup before scanning conflicts.',
      modelRoute,
      inspectRoutes,
      prerequisites: [
        ...setupPrerequisite,
        'The user must provide a calendar/account scope if more than one exists.',
        writeToolCount > 0
          ? `${writeToolCount} write-like calendar tool(s) require explicit confirmation before event create, edit, delete, RSVP, or reschedule effects.`
          : 'No write-like calendar tools were classified; keep event mutation out of scope until a connector route is inspected.',
      ],
      runBoundary: 'Conflict findings are advisory; reminders use schedule action:"remind" and calendar edits use confirmed connector actions.',
    },
  ];
}

export function hasMethod(methodIds: readonly string[], methodId: string): boolean {
  return methodIds.includes(methodId);
}

export function taskWorkflows(methodIds: readonly string[]): readonly PersonalOpsWorkflow[] {
  const hostTaskStatus: PersonalOpsWorkflowStatus = methodIds.length > 0 ? 'ready' : 'needs-setup';
  return [
    {
      id: 'visible-work-plan-review',
      label: 'Visible work-plan review',
      status: 'ready',
      summary: 'Track user-facing work items in the Agent-owned work plan before creating background or host work.',
      next: 'Review the plan, add or update one item when useful, and keep status changes visible.',
      modelRoute: 'agent_work_plan action:"list"',
      inspectRoutes: [
        'workspace action:"action" actionId:"workplan"',
        'workspace action:"action" actionId:"workplan-add"',
        'workspace action:"action" actionId:"workplan-status"',
      ],
      prerequisites: ['Use the work plan when the user asks for task tracking, multi-step work, or a visible checkpoint.'],
      runBoundary: 'Agent-owned work-plan edits stay local and visible; deletion/clear-completed routes require explicit confirmation.',
    },
    {
      id: 'connected-host-task-review',
      label: 'Connected-host task review',
      status: hostTaskStatus,
      summary: 'Inspect connected-host task state separately from Agent-owned work-plan state.',
      next: hostTaskStatus === 'ready'
        ? 'List host tasks, inspect one exact task id, then cancel or retry only through confirmed daemon controls when the user asks.'
        : 'Update or connect the GoodVibes host until task inspection methods are present.',
      modelRoute: 'workspace action:"action" actionId:"tasks-list"',
      inspectRoutes: [
        'workspace action:"action" actionId:"tasks-list"',
        'workspace action:"action" actionId:"task-show"',
        ...methodIds.slice(0, 6).map((methodId) => `host action:"method" methodId:"${methodId}"`),
      ],
      prerequisites: hostTaskStatus === 'ready'
        ? [`${methodIds.length} task/work-plan daemon method(s) are discoverable.`]
        : ['Connected-host task methods are not present in the current SDK operator contract.'],
      runBoundary: 'Host task cancel/retry/create actions mutate connected-host state and require exact ids, confirmation, and explicit user request.',
    },
  ];
}

export function reminderWorkflows(methodIds: readonly string[], deliveryConfigured: boolean): readonly PersonalOpsWorkflow[] {
  const scheduleStatus: PersonalOpsWorkflowStatus = methodIds.length > 0 ? 'ready' : 'needs-setup';
  const reminderStatus: PersonalOpsWorkflowStatus = methodIds.length === 0 ? 'needs-setup' : deliveryConfigured ? 'ready' : 'attention';
  return [
    {
      id: 'confirmed-reminder-request',
      label: 'Confirmed reminder request',
      status: reminderStatus,
      summary: 'Create one visible reminder only from a direct user request with real timing and optional delivery target.',
      next: reminderStatus === 'ready'
        ? 'Collect title, timing, delivery scope, and explicit user request, then use the confirmed reminder route.'
        : reminderStatus === 'attention'
          ? 'Configure or confirm a delivery target before relying on reminder delivery, or create the reminder with explicit scope.'
          : 'Update the connected GoodVibes host until schedule/reminder creation methods are available.',
      modelRoute: 'schedule action:"remind"',
      inspectRoutes: [
        'workspace action:"action" actionId:"schedule-reminder"',
        'channels action:"status"',
        ...methodIds.filter((methodId) => methodId.startsWith('schedules.')).slice(0, 6).map((methodId) => `host action:"method" methodId:"${methodId}"`),
      ],
      prerequisites: [
        'The user must provide a concrete reminder title and time.',
        deliveryConfigured ? 'At least one delivery target or channel is configured.' : 'No configured delivery target was detected; delivery setup may be needed.',
      ],
      runBoundary: 'Reminder creation requires confirm:true and explicitUserRequest; vague follow-up ideas stay as notes or work-plan items.',
    },
    {
      id: 'connected-schedule-review',
      label: 'Connected schedule review',
      status: scheduleStatus,
      summary: 'Review existing connected schedules before editing, running, pausing, resuming, or deleting one.',
      next: scheduleStatus === 'ready'
        ? 'List schedules or inspect the autonomy queue, then control only one exact schedule id through confirmed routes.'
        : 'Update the connected GoodVibes host until schedule list/control methods are available.',
      modelRoute: 'autonomy action:"item" queueItemId:"connected-schedules"',
      inspectRoutes: [
        'workspace action:"action" actionId:"schedule-list"',
        'autonomy action:"item" queueItemId:"connected-schedules"',
        'workspace action:"action" actionId:"schedule-edit"',
      ],
      prerequisites: scheduleStatus === 'ready'
        ? [`${methodIds.length} schedule/reminder daemon method(s) are discoverable.`]
        : ['Connected-host schedule methods are not present in the current SDK operator contract.'],
      runBoundary: 'Schedule edit/run/enable/disable/delete actions require exact ids, confirmation, and explicit user request.',
    },
  ];
}
