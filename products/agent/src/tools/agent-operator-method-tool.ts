import { captureStrictJudgmentJson } from '@goodvibes-jev/engine/sdk/platform/gate';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { assertCurrentToolInvocation, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { redactStructuredDataAsync } from '@goodvibes-jev/engine/sdk/platform/utils';
import { isDeepStrictEqual } from 'node:util';
import type { ShellPathService } from '@/runtime/index.ts';
import type { AgentConnectedHostConfigReader } from '../agent/routine-schedule-promotion.ts';
import { assertOperatorEffect, captureOperatorConnection } from '../agent/operator-connection-owner.ts';
import { publishOperatorMethodReceipt } from '../agent/operator-method-receipt.ts';
import { createOperatorInputProjector, findConnectedOperatorMethod, operatorExecutionConnection, operatorExecutionWireInput, operatorExecutionRequestPolicy, operatorMethodIsReadOnly, operatorMethodIsOutward } from './agent-operator-input-projector.ts';

type JsonRecord = Record<string, unknown>;

interface OperatorContractMethod {
  readonly id: string;
  readonly title?: string;
  readonly category?: string;
  readonly access?: string;
  readonly scopes?: readonly string[];
  readonly http?: {
    readonly method?: string;
    readonly path?: string;
  };
  readonly invokable?: boolean;
  readonly outputSchema?: Record<string, unknown>;
  readonly inputSchema?: Record<string, unknown>;
}

interface OperatorMethodToolArgs {
  readonly methodId?: unknown;
  readonly input?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
  readonly dryRun?: unknown;
}

interface PreparedOperatorRoute {
  readonly method: OperatorContractMethod;
  readonly httpMethod: string;
  readonly path: string;
  readonly payload: JsonRecord;
}

type ServiceMethodId = 'services.status' | 'services.install' | 'services.start' | 'services.restart';
type WatcherMethodId =
  | 'watchers.create'
  | 'watchers.patch'
  | 'watchers.run'
  | 'watchers.start'
  | 'watchers.stop'
  | 'watchers.delete';

const READ_ONLY_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// These native routes independently admit this paired invocation on the server.
const AUTONOMOUS_NATIVE_STATE_METHOD_IDS = new Set([
  'channels.drafts.save', 'channels.drafts.delete', 'channels.routing.assign', 'channels.routing.delete',
  'occasions.answer', 'occasions.acknowledge', 'occasions.interview.answer',
  'occasions.interview.record', 'occasions.conflict.resolve', 'occasions.sweep',
]);
const AUTONOMOUS_PROFILE_METHOD_IDS = new Set([
  'profile.set', 'profile.append', 'profile.forget', 'profile.undo',
  'occasions.confirm', 'occasions.plans.confirm', 'occasions.remove',
]);
const PROFILE_QUOTE_METHOD_IDS = new Set([
  'profile.set', 'profile.append', 'occasions.confirm', 'occasions.plans.confirm',
]);
const SERVICE_METHOD_IDS = new Set<string>(['services.status', 'services.install', 'services.start', 'services.restart']);
const WATCHER_METHOD_IDS = new Set<string>([
  'watchers.create',
  'watchers.patch',
  'watchers.run',
  'watchers.start',
  'watchers.stop',
  'watchers.delete',
]);

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true';
}

function cloneInput(input: unknown): JsonRecord {
  if (!isRecord(input)) return {};
  // Path substitution consumes only this transport-owned mutable top level.
  return { ...captureStrictJudgmentJson(input) };
}

function encodePathValue(value: unknown, name: string): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return encodeURIComponent(String(value));
  }
  throw new Error(`operator method path parameter '${name}' must be a string, number, or boolean.`);
}

function substitutePath(pathTemplate: string, payload: JsonRecord): string {
  let path = pathTemplate.replace(/\{([^}]+)\}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    if (!(name in payload)) throw new Error(`operator method path parameter '${name}' is required.`);
    const encoded = encodePathValue(payload[name], name);
    delete payload[name];
    return encoded;
  });
  path = path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (match, name: string) => {
    if (!(name in payload)) return match;
    const encoded = encodePathValue(payload[name], name);
    delete payload[name];
    return encoded;
  });
  return path;
}

function prepareOperatorRoute(method: OperatorContractMethod, input: unknown): PreparedOperatorRoute {
  const httpMethod = method.http?.method?.toUpperCase();
  const pathTemplate = method.http?.path;
  if (!httpMethod || !pathTemplate) {
    throw new Error(`operator method '${method.id}' is not invokable over HTTP.`);
  }
  const payload = cloneInput(input);
  const path = substitutePath(pathTemplate, payload);
  return { method, httpMethod, path, payload };
}

function appendQuery(path: string, payload: JsonRecord): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      query.set(key, String(value));
    } else {
      query.set(key, JSON.stringify(value));
    }
  }
  const queryString = query.toString();
  if (!queryString) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${queryString}`;
}

function isServiceMethodId(methodId: string): methodId is ServiceMethodId {
  return SERVICE_METHOD_IDS.has(methodId);
}

function isWatcherMethodId(methodId: string): methodId is WatcherMethodId {
  return WATCHER_METHOD_IDS.has(methodId);
}

function serviceSuccessCriteria(methodId: ServiceMethodId): readonly string[] {
  if (methodId === 'services.status') {
    return [
      'The daemon returns a service status receipt with installed, autostart, and running booleans.',
      'The receipt has no actionError.',
    ];
  }
  if (methodId === 'services.install') {
    return [
      'The daemon returns ok:true for services.install.',
      'The service status receipt reports installed:true.',
      'The receipt has no actionError.',
      'Verify with services.status before retrying install, start, or restart.',
    ];
  }
  if (methodId === 'services.start') {
    return [
      'The daemon returns ok:true for services.start.',
      'The service status receipt reports running:true.',
      'The receipt has no actionError.',
      'Verify with services.status before retrying start or escalating.',
    ];
  }
  return [
    'The daemon returns ok:true for services.restart.',
    'The service status receipt reports running:true after restart.',
    'The receipt has no actionError.',
    'Verify with services.status before retrying restart or escalating.',
  ];
}

function serviceExpectedOutcome(methodId: ServiceMethodId): JsonRecord {
  const target = methodId === 'services.status'
    ? 'read-current-posture'
    : methodId === 'services.install'
      ? 'installed-service'
      : methodId === 'services.start'
        ? 'running-service'
        : 'restarted-running-service';
  return {
    target,
    successCriteria: serviceSuccessCriteria(methodId),
    evidenceFields: ['installed', 'autostart', 'running', 'pid', 'lastAction', 'actionError', 'network.controlPlane.ready'],
    verificationRoute: 'agent_operator_method methodId:"services.status"',
    recoveryRoute: 'setup action:"item" setupItemId:"connected-host-readiness" includeParameters:true',
  };
}

function watcherSuccessCriteria(methodId: WatcherMethodId): readonly string[] {
  if (methodId === 'watchers.delete') {
    return [
      'The daemon returns ok:true for watchers.delete.',
      'The watcher receipt reports removed:true.',
      'Verify with watchers.list before recreating or assuming no trigger remains.',
    ];
  }
  const action = methodId.split('.')[1] ?? 'watcher';
  return [
    `The daemon returns ok:true for ${methodId}.`,
    'The watcher receipt includes id, label, kind, state, source, and metadata.',
    'The watcher receipt has no lastError.',
    `Verify with watchers.list before retrying ${action} or assuming the trigger is active.`,
  ];
}

function watcherExpectedOutcome(methodId: WatcherMethodId): JsonRecord {
  const target = methodId === 'watchers.create'
    ? 'created-visible-watcher'
    : methodId === 'watchers.patch'
      ? 'updated-visible-watcher'
      : methodId === 'watchers.run'
        ? 'triggered-watcher-run'
        : methodId === 'watchers.start'
          ? 'started-watcher'
          : methodId === 'watchers.stop'
            ? 'stopped-watcher'
            : 'deleted-watcher';
  return {
    target,
    successCriteria: watcherSuccessCriteria(methodId),
    evidenceFields: ['id', 'kind', 'label', 'state', 'source.kind', 'source.enabled', 'sourceStatus', 'lastCheckpoint', 'lastError'],
    verificationRoute: 'agent_operator_method methodId:"watchers.list"',
    recoveryRoute: 'autonomy action:"intake" query:"watcher trigger" includeParameters:true',
  };
}

function summarizePreview(route: PreparedOperatorRoute): JsonRecord {
  const readOnly = operatorMethodIsReadOnly(route.method, route.payload) && !operatorMethodIsOutward(route.method.id);
  const preview: JsonRecord = {
    methodId: route.method.id,
    title: route.method.title ?? route.method.id,
    category: route.method.category ?? 'uncategorized',
    access: route.method.access ?? 'authenticated',
    scopes: route.method.scopes ?? [],
    route: `${route.httpMethod} ${route.path}`,
    effect: readOnly
      ? 'read-only-network'
      : route.method.access === 'admin'
        ? 'admitted-admin-connected-host-state'
        : 'admitted-connected-host-state',
    confirmationRequired: false,
    admissionRequired: !readOnly,
    body: READ_ONLY_HTTP_METHODS.has(route.httpMethod) ? undefined : route.payload,
    query: READ_ONLY_HTTP_METHODS.has(route.httpMethod) ? route.payload : undefined,
  };
  if (isServiceMethodId(route.method.id)) preview.expectedOutcome = serviceExpectedOutcome(route.method.id);
  if (isWatcherMethodId(route.method.id)) preview.expectedOutcome = watcherExpectedOutcome(route.method.id);
  return preview;
}

async function stringifyOutput(value: unknown, options: Parameters<typeof redactStructuredDataAsync>[1] = {}): Promise<string> {
  const protectedOutput = await redactStructuredDataAsync(value, options);
  if (!isRecord(protectedOutput)) throw new Error('Connected operator output could not be projected safely.');
  const text = JSON.stringify(protectedOutput, null, 2);
  return text;
}

/** The admitted native method declares its response structure. Unknown extension
 * fields stay withheld; declared strings still undergo all egress checks. */
function operatorResultFields(method: OperatorContractMethod): NonNullable<Parameters<typeof redactStructuredDataAsync>[1]>['declaredFields'] {
  type Declaration = NonNullable<NonNullable<Parameters<typeof redactStructuredDataAsync>[1]>['declaredFields']>[number];
  const fields = new Map<string, Declaration>();
  const add = (path: readonly string[], kind: Declaration['kind'] = 'content') => {
    const key = JSON.stringify(path);
    if (fields.get(key)?.kind !== 'secret') fields.set(key, { path, kind });
  };
  for (const name of ['methodId', 'status', 'ok', 'route', 'effect', 'body', 'outcome', 'preview', 'dryRun']) add([name]);
  // These are constructed here, independently of the connected host body.
  const previewFields = ['methodId', 'title', 'category', 'access', 'scopes', 'route', 'effect',
    'confirmationRequired', 'admissionRequired', 'body', 'query', 'expectedOutcome'];
  for (const name of previewFields) add(['preview', name]);
  const outcomeFields = ['kind', 'status', 'certified', 'methodId', 'evidence', 'expectedOutcome', 'lifecycleDecision', 'nextStep'];
  for (const name of outcomeFields) add(['outcome', name]);
  const expectedFields = ['target', 'successCriteria', 'evidenceFields', 'verificationRoute', 'recoveryRoute'];
  for (const path of [['preview', 'expectedOutcome'], ['outcome', 'expectedOutcome']]) {
    for (const name of expectedFields) add([...path, name]);
  }
  const evidenceFields = ['receipt', 'installed', 'autostart', 'running', 'pid', 'lastAction', 'actionError',
    'controlPlaneReady', 'id', 'kind', 'label', 'state', 'sourceKind', 'sourceEnabled',
    'sourceStatus', 'lastCheckpoint', 'lastError'];
  for (const path of [['outcome', 'evidence'], ['outcome', 'lifecycleDecision', 'evidence']]) {
    for (const name of evidenceFields) add([...path, name]);
  }
  for (const name of ['status', 'action', 'reason', 'evidence', 'statusRoute', 'setupRoute', 'modelRoute', 'methodId', 'decisionRules']) {
    add(['outcome', 'lifecycleDecision', name]);
  }
  const pending = [{ schema: method.outputSchema, path: ['body'] },
    { schema: method.inputSchema, path: ['preview', 'body'] },
    { schema: method.inputSchema, path: ['preview', 'query'] }];
  while (pending.length) {
    const { schema, path } = pending.pop()!;
    if (!isRecord(schema)) continue;
    if (isRecord(schema.properties)) for (const [name, child] of Object.entries(schema.properties)) {
      const childPath = [...path, name];
      add(childPath, isRecord(child) && child.writeOnly === true ? 'secret' : 'content');
      if (isRecord(child)) pending.push({ schema: child, path: childPath });
    }
    if (isRecord(schema.items)) pending.push({ schema: schema.items, path: [...path, '*'] });
    for (const union of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(schema[union])) {
      for (const child of schema[union]) if (isRecord(child)) pending.push({ schema: child, path });
    }
  }
  // These paths come from the captured native schema. Retain their immutable
  // ownership so egress need not recapture the same declarations per field.
  return captureStrictJudgmentJson([...fields.values()]);
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serviceReceiptEvidence(body: unknown): JsonRecord {
  if (!isRecord(body)) return { receipt: 'not-json-object' };
  const network = isRecord(body.network) ? body.network : {};
  const controlPlane = isRecord(network.controlPlane) ? network.controlPlane : {};
  return {
    installed: typeof body.installed === 'boolean' ? body.installed : null,
    autostart: typeof body.autostart === 'boolean' ? body.autostart : null,
    running: typeof body.running === 'boolean' ? body.running : null,
    pid: typeof body.pid === 'number' ? body.pid : null,
    lastAction: typeof body.lastAction === 'string' ? body.lastAction : null,
    actionError: typeof body.actionError === 'string' ? body.actionError : null,
    controlPlaneReady: typeof controlPlane.ready === 'boolean' ? controlPlane.ready : null,
  };
}

function serviceLifecycleRoute(methodId: ServiceMethodId): string {
  return operatorMethodLikeRoute(methodId);
}

function operatorMethodLikeRoute(methodId: string): string {
  return `agent_operator_method methodId:"${methodId}" input:{}`;
}

function serviceLifecycleDecisionFromStatus(body: unknown): JsonRecord {
  const evidence = serviceReceiptEvidence(body);
  const common = {
    evidence,
    statusRoute: serviceLifecycleRoute('services.status'),
    setupRoute: 'setup action:"item" setupItemId:"connected-host-readiness" includeParameters:true',
    decisionRules: [
      'installed:false -> services.install',
      'installed:true and running:false -> services.start',
      'installed:true and running:true and network.controlPlane.ready:false -> services.restart',
      'installed:true and running:true with no failed control-plane evidence -> no lifecycle mutation',
    ],
  };
  if (!isRecord(body)) {
    return {
      status: 'needs-follow-up',
      action: 'read-status',
      reason: 'The service status receipt was not a JSON object.',
      modelRoute: serviceLifecycleRoute('services.status'),
      ...common,
    };
  }
  const actionError = typeof body.actionError === 'string' ? body.actionError.trim() : '';
  if (actionError) {
    return {
      status: 'needs-diagnostics',
      action: 'inspect-diagnostics',
      reason: 'The service status receipt includes actionError; inspect diagnostics before any lifecycle mutation.',
      modelRoute: 'host action:"services" includeParameters:true',
      ...common,
    };
  }
  if (typeof body.installed !== 'boolean' || typeof body.running !== 'boolean' || typeof body.autostart !== 'boolean') {
    return {
      status: 'needs-follow-up',
      action: 'read-status',
      reason: 'The service status receipt is missing installed, autostart, or running booleans.',
      modelRoute: serviceLifecycleRoute('services.status'),
      ...common,
    };
  }
  if (body.installed === false) {
    return {
      status: 'action-recommended',
      action: 'install-service',
      methodId: 'services.install',
      modelRoute: serviceLifecycleRoute('services.install'),
      reason: 'services.status reports installed:false.',
      ...common,
    };
  }
  if (body.running === false) {
    return {
      status: 'action-recommended',
      action: 'start-service',
      methodId: 'services.start',
      modelRoute: serviceLifecycleRoute('services.start'),
      reason: 'services.status reports installed:true and running:false.',
      ...common,
    };
  }
  const network = isRecord(body.network) ? body.network : {};
  const controlPlane = isRecord(network.controlPlane) ? network.controlPlane : {};
  if (controlPlane.ready === false) {
    return {
      status: 'action-recommended',
      action: 'restart-service',
      methodId: 'services.restart',
      modelRoute: serviceLifecycleRoute('services.restart'),
      reason: 'services.status reports the service is installed and running, but network.controlPlane.ready:false.',
      ...common,
    };
  }
  return {
    status: 'no-action-needed',
    action: 'none',
    reason: 'services.status reports the service is installed and running with no failed control-plane readiness evidence.',
    modelRoute: 'host action:"status" includeParameters:true',
    ...common,
  };
}

function serviceLifecycleDecision(methodId: ServiceMethodId, responseOk: boolean, body: unknown): JsonRecord {
  if (!responseOk) {
    return {
      status: 'needs-follow-up',
      action: 'read-status',
      reason: `The ${methodId} daemon call failed; do not retry a lifecycle mutation until services.status or host action:"services" explains the failure.`,
      evidence: serviceReceiptEvidence(body),
      statusRoute: serviceLifecycleRoute('services.status'),
      setupRoute: 'setup action:"item" setupItemId:"connected-host-readiness" includeParameters:true',
      modelRoute: 'host action:"services" includeParameters:true',
    };
  }
  if (methodId === 'services.status') return serviceLifecycleDecisionFromStatus(body);
  return {
    status: 'verify-status',
    action: 'read-status',
    reason: `${methodId} returned a receipt; verify services.status before closing or advancing setup.`,
    evidence: serviceReceiptEvidence(body),
    statusRoute: serviceLifecycleRoute('services.status'),
    setupRoute: 'setup action:"item" setupItemId:"connected-host-readiness" includeParameters:true',
    modelRoute: serviceLifecycleRoute('services.status'),
  };
}

function serviceOutcomeCertified(methodId: ServiceMethodId, responseOk: boolean, body: unknown): boolean {
  if (!responseOk || !isRecord(body) || (typeof body.actionError === 'string' && body.actionError.trim())) return false;
  if (methodId === 'services.status') {
    return typeof body.installed === 'boolean'
      && typeof body.autostart === 'boolean'
      && typeof body.running === 'boolean';
  }
  if (methodId === 'services.install') return body.installed === true;
  if (methodId === 'services.start') return body.running === true;
  return body.running === true;
}

function serviceOutcome(methodId: string, responseOk: boolean, body: unknown): JsonRecord | undefined {
  if (!isServiceMethodId(methodId)) return undefined;
  const certified = serviceOutcomeCertified(methodId, responseOk, body);
  return {
    kind: 'service-repair-receipt',
    status: !responseOk
      ? 'failed'
      : certified
        ? 'certified'
        : 'needs-follow-up',
    certified,
    methodId,
    evidence: serviceReceiptEvidence(body),
    expectedOutcome: serviceExpectedOutcome(methodId),
    lifecycleDecision: serviceLifecycleDecision(methodId, responseOk, body),
    nextStep: certified
      ? 'Inspect services.status or connected-host status to confirm the setup wizard can advance.'
      : 'Inspect services.status and connected-host setup posture before retrying a lifecycle mutation.',
  };
}

function watcherReceiptEvidence(body: unknown): JsonRecord {
  if (!isRecord(body)) return { receipt: 'not-json-object' };
  const source = isRecord(body.source) ? body.source : {};
  return {
    id: typeof body.id === 'string' ? body.id : null,
    kind: typeof body.kind === 'string' ? body.kind : null,
    label: typeof body.label === 'string' ? body.label : null,
    state: typeof body.state === 'string' ? body.state : null,
    sourceKind: typeof source.kind === 'string' ? source.kind : null,
    sourceEnabled: typeof source.enabled === 'boolean' ? source.enabled : null,
    sourceStatus: typeof body.sourceStatus === 'string' ? body.sourceStatus : null,
    lastCheckpoint: typeof body.lastCheckpoint === 'string' ? body.lastCheckpoint : null,
    lastError: typeof body.lastError === 'string' ? body.lastError : null,
  };
}

function watcherOutcomeCertified(methodId: WatcherMethodId, responseOk: boolean, body: unknown): boolean {
  if (!responseOk || !isRecord(body)) return false;
  if (methodId === 'watchers.delete') return body.removed === true;
  if (typeof body.lastError === 'string' && body.lastError.trim()) return false;
  return typeof body.id === 'string'
    && typeof body.kind === 'string'
    && typeof body.label === 'string'
    && typeof body.state === 'string'
    && isRecord(body.source);
}

function watcherOutcome(methodId: string, responseOk: boolean, body: unknown): JsonRecord | undefined {
  if (!isWatcherMethodId(methodId)) return undefined;
  const certified = watcherOutcomeCertified(methodId, responseOk, body);
  return {
    kind: 'watcher-receipt',
    status: !responseOk
      ? 'failed'
      : certified
        ? 'certified'
        : 'needs-follow-up',
    certified,
    methodId,
    evidence: watcherReceiptEvidence(body),
    expectedOutcome: watcherExpectedOutcome(methodId),
    nextStep: certified
      ? 'Inspect watchers.list or autonomy action:"queue" to verify the trigger remains visible and scoped.'
      : 'Inspect watchers.list and autonomy action:"intake" before retrying watcher setup or run control.',
  };
}

function operatorOutcome(methodId: string, responseOk: boolean, body: unknown): JsonRecord | undefined {
  return serviceOutcome(methodId, responseOk, body)
    ?? watcherOutcome(methodId, responseOk, body);
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function createAgentOperatorMethodTool(
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): Tool {
  return {
    definition: {
      name: 'agent_operator_method',
      description: 'Invoke a GoodVibes daemon operator method under current recorded effect admission.',
      parameters: {
        type: 'object',
        properties: {
          methodId: {
            type: 'string',
            description: 'Exact operator method id, for example services.status.',
          },
          input: {
            type: 'object',
            description: 'Method input; path keys are removed before query/body.',
            additionalProperties: true,
          },
          confirm: {
            type: 'boolean',
            description: 'Optional audit annotation; does not grant effect authority.',
          },
          explicitUserRequest: {
            type: 'string',
            description: 'Optional request provenance; does not grant effect authority.',
          },
          dryRun: {
            type: 'boolean',
            description: 'Preview the route without calling the daemon.',
          },
        },
        required: ['methodId'],
        additionalProperties: false,
      },
      sideEffects: ['network', 'state'],
    },
    execute: async (rawArgs, options) => {
      let args: OperatorMethodToolArgs;
      try { args = isRecord(rawArgs) ? captureStrictJudgmentJson(rawArgs) : {}; }
      catch { return { success: false, error: 'Operator method arguments must be plain JSON data.' }; }
      options?.signal?.throwIfAborted();
      const methodId = readString(args.methodId);
      if (!methodId) return { success: false, error: 'methodId is required.' };
      const method = findConnectedOperatorMethod(methodId);
      if (!method) {
        return {
          success: false,
          error: `Unknown GoodVibes operator method '${methodId}'. Inspect host action:"methods" first.`,
        };
      }
      // Capability-advertisement honesty: the operator contract marks a
      // cataloged-but-not-route-backed method invokable:false (email.inbox.list,
      // email.send, etc., see @goodvibes-jev/engine/sdk's method-catalog-route-reconcile).
      // Refuse here, before prepareOperatorRoute/fetch, rather than letting the
      // model discover a bare 404 from a route that was never wired up. The ad
      // must degrade at the source, not rely on the model coping with a 404.
      const invocationDescriptor = Object.getOwnPropertyDescriptor(method, 'invokable');
      if (invocationDescriptor && 'value' in invocationDescriptor && invocationDescriptor.value === false) {
        return {
          success: false,
          error: `operator method '${method.id}' is unavailable (route not served by this daemon). Do not retry it; the daemon has not wired this capability up.`,
        };
      }

      let route: PreparedOperatorRoute;
      let methodSnapshot: OperatorContractMethod;
      try {
        methodSnapshot = captureStrictJudgmentJson(method);
        route = prepareOperatorRoute(methodSnapshot, args.input);
      } catch (error) {
        return { success: false, error: summarizeError(error) };
      }

      const preview = summarizePreview(route);
      if (readBoolean(args.dryRun)) {
        try {
          const output = await stringifyOutput({ preview, dryRun: true }, { declaredFields: operatorResultFields(methodSnapshot), signal: options?.signal, assertCurrent: () => {
            options?.signal?.throwIfAborted(); assertCurrentToolInvocation(rawArgs, options);
            if (findConnectedOperatorMethod(methodId) !== method || !isDeepStrictEqual(captureStrictJudgmentJson(method), methodSnapshot)) throw new Error('Connected operator method changed.');
          } });
          return { success: true, output };
        } catch { return { success: false, error: 'Connected operator preview could not be projected safely.' }; }
      }

      const requiresEffect = !operatorMethodIsReadOnly(methodSnapshot, args.input) || operatorMethodIsOutward(methodSnapshot.id);
      if (requiresEffect && options === undefined) {
        return { success: false, error: 'Connected operator effects require current recorded effect admission.' };
      }

      const requestPath = READ_ONLY_HTTP_METHODS.has(route.httpMethod)
        ? appendQuery(route.path, route.payload)
        : route.path;
      try {
        const assertInvocation = () => {
          options?.signal?.throwIfAborted();
          if (requiresEffect) assertOperatorEffect(rawArgs, options, operatorMethodIsOutward(methodSnapshot.id));
          else assertCurrentToolInvocation(rawArgs, options);
          if (findConnectedOperatorMethod(methodId) !== method || !isDeepStrictEqual(captureStrictJudgmentJson(method), methodSnapshot)) {
            throw new Error('Connected operator method changed.');
          }
        };
        assertInvocation();
        const projectedConnection = operatorExecutionConnection(rawArgs, options, shellPaths, configManager, 'method');
        if (!projectedConnection && requiresEffect) throw new Error('Connected operator effects require a registered source projection.');
        const connection = projectedConnection ?? captureOperatorConnection(shellPaths, configManager, assertInvocation);
        const assertCurrent = () => { assertInvocation(); connection.assertCurrent(); };
        if (!connection.token) return { success: false, error: 'auth_required: no connected-host operator token found.' };
        const retainedPayload = operatorExecutionWireInput(route.payload, rawArgs, options, shellPaths, configManager, 'method');
        const wirePayload = AUTONOMOUS_PROFILE_METHOD_IDS.has(methodSnapshot.id)
          ? { ...retainedPayload, admission: 'autonomous', authority: 'autonomous',
            ...(PROFILE_QUOTE_METHOD_IDS.has(methodSnapshot.id) ? { said: '' } : {}),
            ...(methodSnapshot.id === 'occasions.remove' ? { confirmed: true } : {}) }
          : AUTONOMOUS_NATIVE_STATE_METHOD_IDS.has(methodSnapshot.id)
            ? { ...retainedPayload, admission: 'autonomous' } : retainedPayload;
        if (requiresEffect) {
          const requestPolicy = operatorExecutionRequestPolicy(rawArgs, options, shellPaths, configManager, 'method');
          if (!requestPolicy) throw new Error('Connected operator source policy is unavailable.');
          await requestPolicy.screen({ toolName: 'agent_operator_method', methodId: methodSnapshot.id,
            endpoint: `${connection.baseUrl}${requestPath}`, payload: wirePayload }, { signal: options?.signal, assertCurrent });
        }
        assertCurrent();
        const response = await fetch(`${connection.baseUrl}${requestPath}`, {
          signal: options?.signal,
          redirect: 'error',
          method: route.httpMethod,
          headers: {
            authorization: `Bearer ${connection.token}`,
            ...(READ_ONLY_HTTP_METHODS.has(route.httpMethod) ? {} : { 'content-type': 'application/json' }),
          },
          ...(READ_ONLY_HTTP_METHODS.has(route.httpMethod) ? {} : { body: JSON.stringify(wirePayload) }),
        });
        assertCurrent();
        const body = await readResponseBody(response);
        assertCurrent();
        const outcome = operatorOutcome(route.method.id, response.ok, body);
        const output = {
          methodId: route.method.id,
          status: response.status,
          ok: response.ok,
          route: `${route.httpMethod} ${requestPath}`,
          effect: preview.effect,
          body,
          ...(outcome ? { outcome } : {}),
        };
        const formatted = await stringifyOutput(output, { signal: options?.signal, assertCurrent, secretValues: [connection.token],
          declaredFields: operatorResultFields(methodSnapshot) });
        assertCurrent();
        if (!response.ok) return { success: false, error: formatted };
        publishOperatorMethodReceipt(route.method.id, rawArgs, options, body);
        assertCurrent();
        return { success: true, output: formatted };
      } catch {
        return {
          success: false,
          error: 'connected_host_unavailable: current recorded effect admission and an unchanged connection are required.',
        };
      }
    },
  };
}

export function registerAgentOperatorMethodTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): void {
  registry.register(createAgentOperatorMethodTool(shellPaths, configManager), { inputProjection: createOperatorInputProjector(shellPaths, configManager, 'method') });
}
