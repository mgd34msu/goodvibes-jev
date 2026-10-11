import { assertPersonalOpsDataCurrent, capturePersonalOpsData } from './agent-harness-personal-ops-source.ts';
import { captureModelReadingInput, captureModelReadingSnapshotGuard, modelReadingServicePath } from './agent-harness-model-reading-source.ts';
import { types as nodeTypes } from 'node:util';
import { captureCatalogData, captureCatalogMethods, prepareHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { personalOpsLaneMembers, readPersonalOpsSampleField, readPersonalOpsTool, type DiscoveryLane, type PersonalOpsToolContract } from './agent-harness-personal-ops-readings.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { getOperatorContract, OPERATOR_CONTRACT } from '@goodvibes-jev/engine/sdk/contracts';
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

export function operatorContractMethods(): readonly OperatorContractMethod[] {
  return getOperatorContract().operator.methods.filter(method => Boolean(method.id));
}

export function isInvokableContractMethod(method: OperatorContractMethod): boolean {
  return method.invokable !== false;
}

export function partitionInvokableMethods(methods: readonly OperatorContractMethod[]): {
  readonly available: readonly string[]; readonly unavailable: readonly string[];
} {
  const ids = (invokable: boolean) => methods.filter(method => isInvokableContractMethod(method) === invokable)
    .map(method => method.id).sort((left, right) => left.localeCompare(right));
  return { available: ids(true), unavailable: ids(false) };
}

export async function contractMethodsForLane(lane: DiscoveryLane, options: CatalogRankingOptions): Promise<{
  readonly available: readonly string[]; readonly unavailable: readonly string[];
}> {
  const result = (await readContractMethodLanes([lane], options))[0];
  if (!result) throw new ToolInputProjectionError('held');
  return result;
}

export async function contractMethodsForLanes(options: CatalogRankingOptions): Promise<{
  readonly inbox: ReturnType<typeof partitionInvokableMethods>;
  readonly calendar: ReturnType<typeof partitionInvokableMethods>;
  readonly tasks: ReturnType<typeof partitionInvokableMethods>;
  readonly reminders: ReturnType<typeof partitionInvokableMethods>;
}> {
  const [inbox, calendar, tasks, reminders] = await readContractMethodLanes(['inbox', 'calendar', 'tasks', 'reminders'], options);
  if (!inbox || !calendar || !tasks || !reminders) throw new ToolInputProjectionError('held');
  return { inbox, calendar, tasks, reminders };
}

export async function contractMethodsForAutonomy(options: CatalogRankingOptions): Promise<{
  readonly approvals: ReturnType<typeof partitionInvokableMethods>;
  readonly automation: ReturnType<typeof partitionInvokableMethods>;
  readonly schedules: ReturnType<typeof partitionInvokableMethods>;
  readonly tasks: ReturnType<typeof partitionInvokableMethods>;
}> {
  const [approvals, automation, schedules, tasks] = await readContractMethodLanes(['approvals', 'automation', 'schedules', 'tasks'], options);
  if (!approvals || !automation || !schedules || !tasks) throw new ToolInputProjectionError('held');
  return { approvals, automation, schedules, tasks };
}

interface CapturedContractMethod {
  readonly value: OperatorContractMethod;
  readonly index: number;
  readonly assertCurrent: () => void;
}
interface ContractMetadata {
  readonly manifest: ReturnType<typeof getOperatorContract>;
  readonly operator: ReturnType<typeof getOperatorContract>['operator'];
  readonly captured: readonly CapturedContractMethod[];
  readonly batches: readonly {
    readonly methods: readonly CapturedContractMethod[];
    readonly entries: readonly OperatorContractMethod[];
  }[];
}
const immutableContractMetadata = new WeakMap<object, ContractMetadata>();

function isFrozenDataTree(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (nodeTypes.isProxy(value) || !Object.isFrozen(value)) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).every(key => typeof key === 'string' && Object.hasOwn(descriptors[key]!, 'value')
    && isFrozenDataTree(descriptors[key]!.value, seen));
}

const describeContractMethod = (method: OperatorContractMethod) => ({
  id: method.id, description: method.description ?? method.title ?? '', evidence: method,
});

/** Reuse only detached metadata from the exact immutable generated producer. */
function prepareContractMetadata(manifest: ReturnType<typeof getOperatorContract>,
  operator: ReturnType<typeof getOperatorContract>['operator'], original: readonly OperatorContractMethod[],
  captured: readonly CapturedContractMethod[]): ContractMetadata {
  const batches: CapturedContractMethod[][] = [];
  let characters = 0, batch: CapturedContractMethod[] = [];
  for (const method of captured) {
    if (!method.value.id) continue;
    const size = JSON.stringify([method.value.id, method.value.description ?? method.value.title ?? '', method.value]).length;
    if (batch.length && (characters + size + 16 > 250_000 || batch.length >= 16)) {
      batches.push(batch); batch = []; characters = 0;
    }
    batch.push(method); characters += size;
  }
  if (batch.length) batches.push(batch);
  const metadata: ContractMetadata = Object.freeze({ manifest, operator, captured: Object.freeze(captured),
    batches: Object.freeze(batches.map(methods => Object.freeze({ methods: Object.freeze(methods),
      entries: prepareHarnessCatalog(methods.map(method => method.value), describeContractMethod),
    }))),
  });
  if (manifest === OPERATOR_CONTRACT && Object.isFrozen(manifest) && Object.isFrozen(operator) && isFrozenDataTree(original)) {
    for (const method of captured) method.assertCurrent();
    immutableContractMetadata.set(original, metadata);
  }
  return metadata;
}

async function readContractMethodLanes(lanes: readonly DiscoveryLane[], options: CatalogRankingOptions): Promise<readonly ReturnType<typeof partitionInvokableMethods>[]> {
  const optionsCurrent = captureCatalogMethods(options, ['signal', 'assertCurrent', 'retainCurrent', 'sourceOwner']);
  const signal = options.signal, callerCurrent = options.assertCurrent, retainCurrent = options.retainCurrent;
  const manifest = getOperatorContract();
  const manifestCurrent = captureCatalogMethods(manifest, ['operator']);
  const operator = manifest.operator;
  const operatorCurrent = captureCatalogMethods(operator, ['methods']);
  const original = operator.methods;
  if (!Array.isArray(original) || nodeTypes.isProxy(original) || Object.getPrototypeOf(original) !== Array.prototype)
    throw new ToolInputProjectionError('invalid');
  const descriptors = Object.getOwnPropertyDescriptors(original);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== original.length + 1 || keys.some(key => typeof key !== 'string' || (key !== 'length'
    && (!Number.isSafeInteger(Number(key)) || String(Number(key)) !== key || Number(key) < 0 || Number(key) >= original.length
      || !Object.hasOwn(descriptors[key]!, 'value'))))) throw new ToolInputProjectionError('invalid');
  const arrayCurrent = captureCatalogMethods(original, Object.getOwnPropertyNames(original));
  const arrayIdentityCurrent = captureCatalogMethods(original, ['length']);
  const assertRoot = () => {
    optionsCurrent(); signal?.throwIfAborted(); manifestCurrent(); operatorCurrent(); arrayIdentityCurrent();
    if (getOperatorContract() !== manifest) throw new ToolInputProjectionError('held');
  };
  const found = immutableContractMetadata.get(original);
  const existing = manifest === OPERATOR_CONTRACT && found?.manifest === manifest && found.operator === operator ? found : undefined;
  // The native manifest exceeds a single reading's budget. Each complete method
  // owns its capture; batches change scheduling, never the candidate population.
  const captured = existing?.captured ?? original.map((method, index) => {
    const value = captureModelReadingInput(method);
    const assertSnapshot = captureModelReadingSnapshotGuard(value);
    return Object.freeze({ value, index, assertCurrent: () => assertSnapshot(method) });
  });
  const assertSource = () => {
    assertRoot(); arrayCurrent();
    if (Reflect.ownKeys(original).length !== keys.length) throw new ToolInputProjectionError('held');
    for (const method of captured) method.assertCurrent();
  };
  const assertCurrent = () => { callerCurrent?.(); assertSource(); };
  assertCurrent();
  const { batches } = existing ?? prepareContractMetadata(manifest, operator, original, captured);
  const retained = new Map<string | (() => void), () => void>();
  const results: ReturnType<typeof partitionInvokableMethods>[] = [];
  for (const lane of lanes) {
    const selected: OperatorContractMethod[] = [];
    for (const { methods, entries } of batches) {
      assertCurrent();
      const assertIndices = captureCatalogMethods(original, methods.map(method => String(method.index)));
      const assertBatch = () => {
        callerCurrent?.(); assertRoot(); assertIndices();
        for (const method of methods) method.assertCurrent();
        for (const guard of retained.values()) guard();
      };
      const matches = await personalOpsLaneMembers(entries, lane, describeContractMethod,
        { ...options, assertCurrent: assertBatch, retainCurrent(guard, key) { if (!retained.has(key ?? guard)) retained.set(key ?? guard, guard); } });
      assertCurrent(); selected.push(...matches);
    }
    results.push(partitionInvokableMethods(selected));
  }
  for (const [key, guard] of retained) retainCurrent?.(guard, typeof key === 'string' ? key : undefined);
  retainCurrent?.(assertSource, 'personal-ops-contract-source');
  assertCurrent();
  return results;
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

function mcpApi(context: CommandContext): object | null {
  const api = modelReadingServicePath(context, ['clients', 'mcpApi']) ?? modelReadingServicePath(context, ['extensions', 'mcpRegistry']);
  if (api === undefined || api === null) return null;
  if (typeof api !== 'object') throw new ToolInputProjectionError('invalid');
  return api;
}

export function mcpServerRecords(context: CommandContext): readonly {
  readonly name: string; readonly connected: boolean; readonly trustMode: string; readonly role: string;
  readonly schemaFreshness: string; readonly allowedHosts: readonly string[];
}[] {
  const api = mcpApi(context);
  if (!api) return [];
  const list = modelReadingServicePath(api, ['listServerSecurity']);
  if (typeof list !== 'function') return [];
  const raw: unknown = list.call(api);
  const captured = captureCatalogData(raw);
  if (!Array.isArray(captured)) throw new ToolInputProjectionError('invalid');
  return captured.map(value => {
    const server = schemaObject(value);
    if (!server || typeof server.name !== 'string' || typeof server.connected !== 'boolean' || typeof server.trustMode !== 'string'
      || typeof server.role !== 'string' || typeof server.schemaFreshness !== 'string' || !Array.isArray(server.allowedHosts)
      || !server.allowedHosts.every((host: unknown) => typeof host === 'string')) throw new ToolInputProjectionError('invalid');
    return { ...server, name: server.name, connected: server.connected, trustMode: server.trustMode, role: server.role,
      schemaFreshness: server.schemaFreshness, allowedHosts: server.allowedHosts.filter((host: unknown): host is string => typeof host === 'string') };
  });
}

export async function mcpToolRecords(context: CommandContext, options: CatalogRankingOptions = {}): Promise<readonly McpToolRecord[]> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const api = mcpApi(context);
  if (!api) return [];
  const list = modelReadingServicePath(api, ['listAllTools']);
  if (typeof list !== 'function') return [];
  const methodGuard = captureCatalogMethods(api, ['listAllTools']);
  const assertSource = () => {
    options.signal?.throwIfAborted(); methodGuard();
    if (mcpApi(context) !== api) throw new ToolInputProjectionError('held');
  };
  const raw: unknown = await list.call(api);
  options.assertCurrent?.(); assertSource();
  const tools = captureCatalogData(raw);
  if (!Array.isArray(tools)) throw new ToolInputProjectionError('invalid');
  const result = tools.map(value => {
    const tool = schemaObject(value);
    if (!tool || typeof tool.serverName !== 'string' || typeof tool.toolName !== 'string'
      || (tool.description !== undefined && typeof tool.description !== 'string')
      || (tool.qualifiedName !== undefined && typeof tool.qualifiedName !== 'string')) throw new ToolInputProjectionError('invalid');
    return { ...tool, serverName: tool.serverName, toolName: tool.toolName,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      ...(typeof tool.qualifiedName === 'string' ? { qualifiedName: tool.qualifiedName } : {}),
    };
  });
  const sourceSnapshot = capturePersonalOpsData(raw);
  const assertCompleteSource = () => { assertSource(); assertPersonalOpsDataCurrent(raw, sourceSnapshot); };
  options.retainCurrent?.(assertCompleteSource, 'personal-ops-mcp-tools');
  return result;
}

export function mcpSchemaReader(context: CommandContext, options: CatalogRankingOptions = {}): ((qualifiedName: string) => Promise<McpToolSchema | null>) | null {
  const api = mcpApi(context);
  if (!api) return null;
  const read = modelReadingServicePath(api, ['getToolSchema']);
  if (typeof read !== 'function') return null;
  const methodsCurrent = captureCatalogMethods(api, ['getToolSchema']);
  return async qualifiedName => {
    const assertSource = () => {
      options.signal?.throwIfAborted(); methodsCurrent();
      if (mcpApi(context) !== api) throw new ToolInputProjectionError('held');
    };
    const assertCurrent = () => { options.assertCurrent?.(); assertSource(); };
    assertCurrent(); const raw: unknown = await read.call(api, qualifiedName); assertCurrent();
    if (raw === null || raw === undefined) return null;
    const captured = captureCatalogData(raw);
    const schema = schemaObject(captured);
    if (!schema) throw new ToolInputProjectionError('invalid');
    const sourceSnapshot = capturePersonalOpsData(raw);
    const assertCompleteSource = () => { assertSource(); assertPersonalOpsDataCurrent(raw, sourceSnapshot); };
    assertCompleteSource(); options.retainCurrent?.(assertCompleteSource, `personal-ops-mcp-schema:${qualifiedName}`);
    return { ...schema, inputSchema: schema.inputSchema };
  };
}

export function mcpToolCaller(context: CommandContext): ((qualifiedName: string, input: Readonly<Record<string, unknown>>, options?: { readonly signal?: AbortSignal | undefined }) => Promise<unknown>) | null {
  const api = mcpApi(context);
  if (!api) return null;
  const call = modelReadingServicePath(api, ['callTool']);
  if (typeof call !== 'function') return null;
  return async (qualifiedName, input, options) => {
    options?.signal?.throwIfAborted();
    if (mcpApi(context) !== api || modelReadingServicePath(api, ['callTool']) !== call) throw new ToolInputProjectionError('held');
    const raw: unknown = await call.call(api, qualifiedName, input, options);
    options?.signal?.throwIfAborted();
    if (mcpApi(context) !== api || modelReadingServicePath(api, ['callTool']) !== call) throw new ToolInputProjectionError('held');
    return raw;
  };
}

export function qualifiedToolName(tool: McpToolRecord): string {
  return tool.qualifiedName ?? `mcp:${tool.serverName}:${tool.toolName}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function schemaObject(value: unknown): Record<string, unknown> | null {
  return isObjectRecord(value) ? value : null;
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

export async function summarizeInputSchema(
  qualifiedName: string,
  contract: PersonalOpsToolContract,
  lane: 'inbox' | 'calendar',
  effect: PersonalOpsConnectorTool['effect'],
  options: CatalogRankingOptions,
): Promise<McpSchemaSummary | null> {
  const schema = schemaObject(contract.inputSchema);
  if (!schema) return null;
  const requiredFields = schemaRequiredFields(schema);
  const optionalFields = schemaOptionalFields(schema, requiredFields);
  const fields = [...requiredFields, ...optionalFields.slice(0, Math.max(0, 4 - requiredFields.length))];
  const sampleInput: Record<string, unknown> = {};
  for (const field of fields) sampleInput[field] = await readPersonalOpsSampleField({ field, inputSchema: contract.inputSchema, contract, lane, effect }, options);
  return { schemaRoute: `mcp schema qualifiedName:"${qualifiedName}"`, requiredFields, optionalFields, sampleInput };
}

export async function mcpToolSchemas(
  context: CommandContext,
  tools: readonly McpToolRecord[],
  options: CatalogRankingOptions = {},
): Promise<ReadonlyMap<string, McpToolSchema>> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const api = mcpApi(context);
  const read = mcpSchemaReader(context, options);
  if (!api || !read) return new Map();
  const source = captureCatalogData(tools);
  const sourceJson = JSON.stringify(source);
  const methodsCurrent = captureCatalogMethods(api, ['getToolSchema']);
  const assertSource = () => {
    options.signal?.throwIfAborted(); methodsCurrent();
    if (mcpApi(context) !== api
      || JSON.stringify(captureCatalogData(tools)) !== sourceJson) throw new ToolInputProjectionError('held');
  };
  const assertCurrent = () => { options.assertCurrent?.(); assertSource(); };
  const schemas = new Map<string, McpToolSchema>();
  for (const tool of source) {
    assertCurrent();
    const schema = await read(qualifiedToolName(tool));
    assertCurrent();
    if (schema) schemas.set(qualifiedToolName(tool), captureCatalogData(schema));
  }
  options.retainCurrent?.(assertSource, 'personal-ops-mcp-schema');
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

export async function connectorSignalsMatching(
  context: CommandContext,
  options: CatalogRankingOptions & {
    readonly lane: 'inbox' | 'calendar';
    readonly toolsByServer: ReadonlyMap<string, readonly McpToolRecord[]>;
    readonly schemasByQualifiedName: ReadonlyMap<string, McpToolSchema>;
  },
): Promise<readonly PersonalOpsConnectorSignal[]> {
  const servers = mcpServerRecords(context);
  const source = servers.map(server => ({ server, tools: (options.toolsByServer.get(server.name) ?? []).map(tool => ({
    ...tool, schema: options.schemasByQualifiedName.get(qualifiedToolName(tool)) ?? null,
  })) }));
  const serialized = JSON.stringify(captureCatalogData(source));
  const assertSource = () => {
    options.signal?.throwIfAborted();
    const current = mcpServerRecords(context).map(server => ({ server, tools: (options.toolsByServer.get(server.name) ?? []).map(tool => ({
      ...tool, schema: options.schemasByQualifiedName.get(qualifiedToolName(tool)) ?? null,
    })) }));
    if (JSON.stringify(captureCatalogData(current)) !== serialized) throw new ToolInputProjectionError('held');
  };
  const assertCurrent = () => { options.assertCurrent?.(); assertSource(); };
  const currentOptions = { ...options, assertCurrent };
  const matches = await personalOpsLaneMembers(source, options.lane, entry => ({
    id: entry.server.name, description: entry.tools.map(tool => tool.description ?? '').join('\n'), evidence: entry,
  }), currentOptions);
  const signals: PersonalOpsConnectorSignal[] = [];
  for (const { server, tools } of matches) {
    assertCurrent();
    const classified: PersonalOpsConnectorTool[] = [];
    for (const tool of tools) {
      const contract = { server: tool.serverName, tool: tool.toolName, description: tool.description ?? '', inputSchema: tool.schema?.inputSchema ?? null };
      const reading = await readPersonalOpsTool(contract, currentOptions);
      assertCurrent();
      if (!reading || reading.lane !== options.lane) continue;
      const summary = await summarizeInputSchema(qualifiedToolName(tool), contract, reading.lane, reading.effect, currentOptions);
      assertCurrent();
      classified.push({ name: tool.toolName, qualifiedName: qualifiedToolName(tool), ...(tool.description ? { description: tool.description } : {}),
        effect: reading.effect, capability: `${reading.lane}-${reading.effect === 'read-only' ? 'read' : 'write'}`,
        ...(summary ?? {}),
      });
    }
    const ready = server.connected && server.schemaFreshness === 'fresh' && server.trustMode !== 'blocked';
    const capabilityTags = [...new Set(classified.map(tool => tool.capability))].sort();
    signals.push({ id: `mcp:${server.name}`, kind: 'mcp-server', label: server.name, status: ready ? 'ready' : 'attention',
      summary: `${server.connected ? 'connected' : 'disconnected'} ${server.trustMode} ${server.schemaFreshness}; ${tools.length} tool(s); ${capabilityTags.join(', ')}`,
      modelRoute: `agent_harness mode:"mcp_server" mcpServerId:"${server.name}"`, toolCount: tools.length, capabilityTags,
      readTools: classified.filter(tool => tool.effect === 'read-only'), writeTools: classified.filter(tool => tool.effect === 'confirmed-effect'),
    });
  }
  assertCurrent(); options.retainCurrent?.(assertSource, `personal-ops-connectors:${options.lane}`);
  return signals.sort((left, right) => left.label.localeCompare(right.label));
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
