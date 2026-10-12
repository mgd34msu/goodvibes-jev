import { types as nodeTypes } from 'node:util';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogData, captureCatalogMethods, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { capturePersonalOpsData, assertPersonalOpsDataCurrent } from './agent-harness-personal-ops-source.ts';
import { captureNativeReadModelObservation } from './agent-harness-autonomy-live-records.ts';
import { modelReadingServicePath, modelReadingOptions, withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { readRuntimeBoolean, readRuntimeKind, readRuntimeRoute, readRuntimeSchema, readRuntimeStatus, type InteractiveRuntimeEvidence } from './agent-harness-interactive-runtime-readings.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { readRecord, readString } from './agent-harness-model-routing-utils.ts';

export type AgentHarnessInteractiveRuntimeKind = 'process-output' | 'pty-session' | 'sudo-mediation' | 'browser-desktop-receipt';
export type AgentHarnessInteractiveRuntimeStatus = 'ready' | 'running' | 'completed' | 'blocked' | 'failed' | 'attention' | 'unknown';

export interface AgentHarnessInteractiveRuntimeCertification {
  readonly schemaStatus: 'certified' | 'legacy';
  readonly schemaVersion?: string;
  readonly publicationGuarantee?: string;
  readonly publisher?: string;
  readonly provenance?: readonly string[];
  readonly receiptId?: string;
  readonly receiptRoute?: string;
  readonly missingSignals: readonly string[];
  readonly policy: string;
}

export interface AgentHarnessInteractiveRuntimeRoute {
  readonly id: string;
  readonly label: string;
  readonly modelRoute: string;
  readonly effect: 'read-only' | 'confirmed' | 'confirmed-admin';
}

export interface AgentHarnessInteractiveRuntimeRecord {
  readonly id: string;
  readonly kind: AgentHarnessInteractiveRuntimeKind;
  readonly status: AgentHarnessInteractiveRuntimeStatus;
  readonly source: string;
  readonly label: string;
  readonly summary: string;
  readonly processId?: string;
  readonly sessionId?: string;
  readonly pid?: number;
  readonly command?: string;
  readonly surface?: string;
  readonly action?: string;
  readonly receiptId?: string;
  readonly outputChunks?: readonly Record<string, unknown>[];
  readonly routes: readonly AgentHarnessInteractiveRuntimeRoute[];
  readonly updatedAt?: string;
  readonly certification: AgentHarnessInteractiveRuntimeCertification;
}

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/secret:\/\/[^\s,'"}]+/gi, 'secret://<redacted>'],
  [/("?\b(?:api[-_]?key|apikey|token|secret|password|passwd|credential|authorization)\b"?\s*:\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1"<redacted>"'],
  [/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|BEARER)[A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/gi, '$1=<redacted>'],
  [/(\b(?:token|secret|password|passwd|api[-_]?key|apikey|authorization|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1<redacted>'],
  [/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>'],
];

function redactedPreview(value: unknown, limit = 180): string {
  const raw = readString(value);
  const redacted = SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), raw);
  return previewHarnessText(redacted, limit);
}



function readNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

function readTimestamp(value: unknown): string | undefined {
  const raw = readString(value);
  const parsed = raw ? Date.parse(raw) : typeof value === 'number' && Number.isFinite(value) ? value : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function stringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) return [...new Set(value.map((entry) => readString(entry)).filter(Boolean))].slice(0, 10);
  const raw = readString(value);
  return raw ? raw.split(',').map((entry) => entry.trim()).filter(Boolean).slice(0, 10) : [];
}

function firstString(records: readonly Readonly<Record<string, unknown>>[], keys: readonly string[]): string {
  for (const record of records) {
    for (const key of keys) {
      const value = readString(record[key]);
      if (value) return value;
    }
  }
  return '';
}

function certificationRecords(record: Readonly<Record<string, unknown>>): readonly Readonly<Record<string, unknown>>[] {
  return [
    record,
    readRecord(record.schema),
    readRecord(record.contract),
    readRecord(record.publication),
    readRecord(record.receipt),
    readRecord(record.certification),
  ];
}



function routeValue(value: unknown): string {
  const direct = readString(value);
  if (direct) return direct;
  const record = readRecord(value);
  return readString(record.modelRoute) || readString(record.route) || readString(record.command) || readString(record.action) || readString(record.href) || readString(record.url);
}



function readId(record: Readonly<Record<string, unknown>>, kind: AgentHarnessInteractiveRuntimeKind): string {
  return readString(record.id)
    || readString(record.recordId)
    || readString(record.processId)
    || readString(record.sessionId)
    || readString(record.receiptId)
    || readString(record.contractId)
    || `${kind}:${readString(record.sourceId) || readString(record.action) || 'published'}`;
}

async function routesFor(kind: AgentHarnessInteractiveRuntimeKind, evidence: InteractiveRuntimeEvidence, options: CatalogRankingOptions): Promise<readonly AgentHarnessInteractiveRuntimeRoute[]> {
  const specs = {
    inspect: { label: 'Inspect record', effect: 'read-only' }, log: { label: 'Read output', effect: 'read-only' },
    write: { label: 'Write input', effect: 'confirmed' }, resize: { label: 'Resize session', effect: 'confirmed' },
    close: { label: 'Close session', effect: 'confirmed' }, credential: { label: 'Mediated credential prompt', effect: 'confirmed-admin' },
    execute: { label: kind === 'browser-desktop-receipt' ? 'Execute trusted control' : 'Execute route', effect: 'confirmed' },
    receipt: { label: 'Inspect receipt', effect: 'read-only' },
  } as const;
  const routes: AgentHarnessInteractiveRuntimeRoute[] = [];
  const containers: readonly { readonly path: readonly string[]; readonly value: Readonly<Record<string, unknown>> }[] = [
    { path: [], value: evidence.record }, ...['routes', 'modelRoutes', 'actions', 'commands', 'links'].map(key => ({ path: [key], value: readRecord(evidence.record[key]) })),
  ];
  for (const container of containers) {
    for (const [key, value] of Object.entries(container.value)) {
      const role = await readRuntimeRoute({ ...evidence, key, value, routeContainerPath: container.path }, options);
      options.signal?.throwIfAborted(); options.assertCurrent?.();
      if (role === 'none') continue;
      const modelRoute = routeValue(value);
      if (!modelRoute) throw new ToolInputProjectionError('held');
      // Effects are a closed native mapping from the recorded role, never the publisher key.
      const spec = specs[role];
      routes.push({ id: role, label: spec.label, modelRoute, effect: spec.effect });
    }
  }
  return routes;
}

async function outputChunks(evidence: InteractiveRuntimeEvidence, options: CatalogRankingOptions): Promise<readonly Record<string, unknown>[]> {
  const record = evidence.record;
  const output = readRecord(record.output);
  const rawChunks = Array.isArray(record.outputChunks) ? record.outputChunks
    : Array.isArray(record.chunks) ? record.chunks
    : Array.isArray(output.chunks) ? output.chunks
    : [];
  const chunks: Record<string, unknown>[] = [];
  for (const [index, entry] of rawChunks.entries()) {
    const chunk = readRecord(entry);
    const text = redactedPreview(chunk.text ?? chunk.preview ?? chunk.data ?? chunk.content, 600);
    const truncated = await readRuntimeBoolean(evidence, `outputChunks[${index}].truncated`, chunk.truncated, 'Whether this published output chunk omits output because it was truncated.', options);
    if (text) chunks.push({
      chunkId: readString(chunk.chunkId) || readString(chunk.id) || `${index + 1}`,
      stream: readString(chunk.stream) || readString(chunk.channel) || 'stdout',
      text,
      chars: readNumber(chunk.chars) ?? text.length,
      bytes: readNumber(chunk.bytes) ?? Buffer.byteLength(text),
      truncated: truncated ?? false,
      createdAt: readTimestamp(chunk.createdAt ?? chunk.timestamp),
    });
  }
  if (chunks.length > 0) return chunks.slice(0, 5);
  return ['stdoutTail', 'stderrTail', 'stdout', 'stderr'].flatMap((key) => {
    const text = redactedPreview(record[key] ?? output[key], 600);
    return text ? [{ chunkId: key, stream: key.includes('stderr') ? 'stderr' : 'stdout', text, chars: text.length, bytes: Buffer.byteLength(text), truncated: false }] : [];
  }).slice(0, 5);
}

async function certification(input: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly source: string;
  readonly kind: AgentHarnessInteractiveRuntimeKind;
  readonly id: string;
  readonly routes: readonly AgentHarnessInteractiveRuntimeRoute[];
  readonly chunks: readonly Record<string, unknown>[];
  readonly evidence: InteractiveRuntimeEvidence;
  readonly options: CatalogRankingOptions;
}): Promise<AgentHarnessInteractiveRuntimeCertification> {
  const records = certificationRecords(input.record);
  const status = await readRuntimeSchema(input.evidence, input.options);
  const publicationGuarantee = firstString(records, ['publicationGuarantee', 'hostPublicationGuarantee', 'runtimePublicationGuarantee']);
  const publisher = firstString(records, ['publisher', 'publisherId', 'daemonId', 'hostId']);
  const provenance = [...new Set([
    ...stringArray(input.record.provenance),
    input.source ? `source ${input.source}` : '',
    firstString(records, ['methodId']) ? `method ${firstString(records, ['methodId'])}` : '',
    firstString(records, ['sourceTool']) ? `sourceTool ${firstString(records, ['sourceTool'])}` : '',
  ].map((entry) => redactedPreview(entry, 180)).filter(Boolean))].slice(0, 8);
  const receiptId = firstString(records, ['receiptId', 'operationReceiptId', 'commandReceiptId', 'sessionReceiptId']);
  const hasRoute = (id: string) => input.routes.some((route) => route.id === id);
  const rawSecretReturned = await readRuntimeBoolean(input.evidence, 'rawSecretReturned', input.record.rawSecretReturned, 'Whether the publisher returned raw secret material.', input.options);
  const rawValueReturned = await readRuntimeBoolean(input.evidence, 'rawValueReturned', input.record.rawValueReturned, 'Whether the publisher returned raw credential values.', input.options);
  const missingSignals = [
    ...(status === 'certified' ? [] : [`Certified ${input.kind} schema is not published.`]),
    ...(input.id ? [] : [`Durable ${input.kind} id is not published.`]),
    ...(publicationGuarantee ? [] : [`${input.kind} publication guarantee is not published.`]),
    ...(publisher ? [] : [`${input.kind} publisher is not published.`]),
    ...(provenance.length > 0 ? [] : [`${input.kind} provenance is not published.`]),
    ...(input.kind === 'process-output' && input.chunks.length === 0 && !hasRoute('log') ? ['Live process output chunks or log route are not published.'] : []),
    ...(input.kind === 'pty-session' && (!hasRoute('write') || (!hasRoute('log') && input.chunks.length === 0)) ? ['PTY input and output routes are not both published.'] : []),
    ...(input.kind === 'sudo-mediation' && (!hasRoute('credential') || rawSecretReturned === true || rawValueReturned === true) ? ['Sudo credential mediation route is missing or raw secret exposure was reported.'] : []),
    ...(input.kind === 'browser-desktop-receipt' && (!receiptId || !hasRoute('execute') || !hasRoute('receipt')) ? ['Browser/desktop command receipt, execute route, or receipt route is not published.'] : []),
  ];
  return {
    schemaStatus: status,
    ...(firstString(records, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion']) ? { schemaVersion: redactedPreview(firstString(records, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion']), 80) } : {}),
    ...(publicationGuarantee ? { publicationGuarantee: redactedPreview(publicationGuarantee, 220) } : {}),
    ...(publisher ? { publisher: redactedPreview(publisher, 80) } : {}),
    ...(provenance.length > 0 ? { provenance } : {}),
    ...(receiptId ? { receiptId: redactedPreview(receiptId, 96) } : {}),
    ...(hasRoute('receipt') ? { receiptRoute: input.routes.find((route) => route.id === 'receipt')?.modelRoute } : {}),
    missingSignals,
    policy: 'Interactive runtime records certify release readiness only when the SDK or daemon publishes schema, durable id, publication guarantee, publisher/provenance, bounded output or receipt evidence, exact confirmed control routes, and no raw secret material.',
  };
}

async function normalizeRecord(evidence: InteractiveRuntimeEvidence, options: CatalogRankingOptions): Promise<AgentHarnessInteractiveRuntimeRecord | null> {
  const { record, source } = evidence;
  if (Object.keys(record).length === 0) return null;
  const kind = await readRuntimeKind(evidence, options);
  const id = readId(record, kind);
  if (!id) return null;
  const routes = await routesFor(kind, evidence, options);
  const chunks = await outputChunks(evidence, options);
  const command = redactedPreview(record.command ?? record.cmd, 180);
  const receiptId = readString(record.receiptId) || readString(record.operationReceiptId) || readString(record.commandReceiptId);
  return {
    id,
    kind,
    status: await readRuntimeStatus(evidence, options),
    source,
    label: redactedPreview(record.label ?? record.title ?? id, 96),
    summary: redactedPreview(record.summary ?? record.description ?? record.detail ?? command ?? id, 240),
    ...(readString(record.processId) ? { processId: readString(record.processId) } : {}),
    ...(readString(record.sessionId) ? { sessionId: readString(record.sessionId) } : {}),
    ...(readNumber(record.pid) !== undefined ? { pid: readNumber(record.pid) } : {}),
    ...(command ? { command } : {}),
    ...(readString(record.surface) ? { surface: redactedPreview(record.surface, 80) } : {}),
    ...(readString(record.action) ? { action: redactedPreview(record.action, 80) } : {}),
    ...(receiptId ? { receiptId: redactedPreview(receiptId, 96) } : {}),
    ...(chunks.length > 0 ? { outputChunks: chunks } : {}),
    routes,
    ...(readTimestamp(record.updatedAt ?? record.createdAt ?? record.timestamp) ? { updatedAt: readTimestamp(record.updatedAt ?? record.createdAt ?? record.timestamp) } : {}),
    certification: await certification({ record, source, kind, id, routes, chunks, evidence, options }),
  };
}

const RUNTIME_SOURCE_PATHS: readonly (readonly string[])[] = [
  ['platform', 'readModels', 'execution', 'interactiveRuntime'], ['platform', 'readModels', 'execution', 'processRuntime'],
  ['platform', 'readModels', 'execution', 'ptySessions'], ['platform', 'readModels', 'execution', 'sudoMediation'],
  ['platform', 'readModels', 'computer', 'browserDesktopReceipts'], ['platform', 'readModels', 'browser', 'controlReceipts'],
  ['clients', 'operatorSdk', 'execution', 'interactiveRuntime'], ['extensions', 'daemonRuntime', 'interactiveRuntime'],
];

interface RuntimeSourceSnapshot { readonly source: string; readonly snapshot: unknown }

function captureRuntimeSources(context: CommandContext) {
  const guards: Array<() => void> = [];
  const sources: RuntimeSourceSnapshot[] = [];
  const path = (keys: readonly string[]) => {
    let value: unknown = context;
    for (const key of keys) {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== 'object') throw new ToolInputProjectionError('invalid');
      guards.push(captureCatalogMethods(value, [key]));
      value = modelReadingServicePath(value, [key]);
    }
    return value;
  };
  const synchronous = (read: () => unknown): unknown => {
    let value: unknown;
    try { value = read(); } catch { throw new ToolInputProjectionError('unavailable'); }
    if (nodeTypes.isPromise(value)) {
      // This native catalog is synchronous. Drain rejection without borrowing a producer's then slot.
      Promise.prototype.then.call(value, undefined, () => undefined);
      throw new ToolInputProjectionError('held');
    }
    return value;
  };
  for (const keys of RUNTIME_SOURCE_PATHS) {
    const source = path(keys);
    if (source === undefined || source === null) continue;
    if ((typeof source === 'object' || typeof source === 'function') && nodeTypes.isProxy(source)) throw new ToolInputProjectionError('held');
    let acquire: () => unknown = () => source;
    if (typeof source === 'function') acquire = () => synchronous(() => Reflect.apply(source, undefined, []));
    else if (typeof source === 'object' && !Array.isArray(source)) {
      const methods = captureCatalogMethods(source, ['getSnapshot', 'snapshot', 'list', 'records', 'subscribe']); guards.push(methods);
      for (const name of ['getSnapshot', 'snapshot', 'list', 'records']) {
        const read = modelReadingServicePath(source, [name]);
        if (typeof read !== 'function') continue;
        if (nodeTypes.isProxy(read)) throw new ToolInputProjectionError('held');
        if (name === 'getSnapshot' && typeof modelReadingServicePath(source, ['subscribe']) === 'function') guards.push(captureNativeReadModelObservation(source));
        acquire = () => { methods(); const value = synchronous(() => Reflect.apply(read, source, [])); methods(); return value; };
        break;
      }
    }
    const original = acquire(), snapshot = capturePersonalOpsData(original);
    guards.push(() => { assertPersonalOpsDataCurrent(original, snapshot); assertPersonalOpsDataCurrent(acquire(), snapshot); });
    sources.push({ source: `context.${keys.join('.')}`, snapshot });
  }
  return { sources, assertCurrent() { for (const guard of guards) guard(); } };
}

function recordsFromSnapshot(source: RuntimeSourceSnapshot): readonly InteractiveRuntimeEvidence[] {
  const evidence = (value: unknown, containerPath: readonly string[], mapId?: string): InteractiveRuntimeEvidence => {
    const record = readRecord(value);
    return { ...source, containerPath, record: mapId ? { ...record, id: readString(record.id) || mapId } : record };
  };
  if (Array.isArray(source.snapshot)) return source.snapshot.map((value, index) => evidence(value, [String(index)]));
  const record = readRecord(source.snapshot);
  const values: InteractiveRuntimeEvidence[] = [];
  // These are native publisher containers. Their paths are evidence, never a kind fallback.
  for (const key of ['processes', 'liveProcesses', 'outputChunks', 'ptySessions', 'sessions', 'sudoMediation', 'credentials', 'browserDesktopReceipts', 'controlReceipts', 'receipts', 'records', 'items']) {
    const candidate = record[key];
    if (Array.isArray(candidate)) values.push(...candidate.map((value, index) => evidence(value, [key, String(index)])));
    else for (const [id, value] of Object.entries(readRecord(candidate))) values.push(evidence(value, [key, id], id));
  }
  return values.length ? values : Object.keys(record).length ? [evidence(record, [])] : [];
}

export interface InteractiveRuntimeSnapshot {
  readonly records: readonly AgentHarnessInteractiveRuntimeRecord[];
  readonly capabilitySummary: Record<string, unknown>;
  readonly parityStatus: InteractiveRuntimeParity;
  readonly assertCurrent: () => void;
}

export async function acquireInteractiveRuntimeSnapshot(context: CommandContext, options: CatalogRankingOptions = {}): Promise<InteractiveRuntimeSnapshot> {
  const optionSlots = captureCatalogMethods(options, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent', 'requirePreservedSource']);
  optionSlots();
  const originalAssertCurrent = options.assertCurrent, originalRetainCurrent = options.retainCurrent, signal = options.signal;
  if ((originalAssertCurrent !== undefined && (typeof originalAssertCurrent !== 'function' || nodeTypes.isProxy(originalAssertCurrent)))
    || (originalRetainCurrent !== undefined && (typeof originalRetainCurrent !== 'function' || nodeTypes.isProxy(originalRetainCurrent))))
    throw new ToolInputProjectionError('invalid');
  const throwIfAborted = AbortSignal.prototype.throwIfAborted;
  const checkSignal = (): void => { if (signal) Reflect.apply(throwIfAborted, signal, []); };
  const assertBorrowedCurrent = (): void => {
    optionSlots(); checkSignal();
    let result: unknown;
    try { result = originalAssertCurrent?.(); }
    finally {
      if (nodeTypes.isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
      optionSlots(); checkSignal();
    }
    if (result !== undefined) throw new ToolInputProjectionError('held');
  };
  const dispatchRetainCurrent = (guard: () => void, key?: string): void => {
    optionSlots(); checkSignal();
    let result: unknown;
    try { result = originalRetainCurrent?.(guard, key); }
    finally {
      if (nodeTypes.isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
      optionSlots(); checkSignal();
    }
    if (result !== undefined) throw new ToolInputProjectionError('held');
  };
  assertBorrowedCurrent();
  const native = captureRuntimeSources(context), retained: Array<() => void> = [];
  const assertSourceCurrent = () => { optionSlots(); checkSignal(); native.assertCurrent(); };
  const assertCurrent = () => {
    assertSourceCurrent(); assertBorrowedCurrent(); assertSourceCurrent();
    for (const guard of retained) guard();
    assertSourceCurrent();
  };
  const retainCurrent = (guard: () => void, key?: string): void => {
    optionSlots(); checkSignal();
    retained.push(guard);
    dispatchRetainCurrent(guard, key);
  };
  assertCurrent();
  dispatchRetainCurrent(assertSourceCurrent, 'agent.runtime.sources');
  let records: AgentHarnessInteractiveRuntimeRecord[] = [];
  if (native.sources.length) {
    const readingOptions = options.sourceOwner ? options : modelReadingOptions(context, context.extensions?.toolRegistry, options.signal, options.assertCurrent, retainCurrent);
    records = await withModelReadingSource({ sources: native.sources }, { ...readingOptions, assertCurrent, retainCurrent }, async (captured, current) => {
      const normalized: AgentHarnessInteractiveRuntimeRecord[] = [];
      for (const source of captured.sources) {
        for (const evidence of recordsFromSnapshot(source)) {
          const record = await normalizeRecord(evidence, current);
          current.signal?.throwIfAborted(); current.assertCurrent?.();
          if (record) normalized.push(record);
        }
      }
      return normalized;
    });
  }
  assertCurrent();
  records.sort((left, right) => {
    const delta = (right.updatedAt ? Date.parse(right.updatedAt) : 0) - (left.updatedAt ? Date.parse(left.updatedAt) : 0);
    return delta || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
  });
  const data = captureCatalogData({ records, capabilitySummary: summarizeInteractiveRuntimeRecords(records), parityStatus: interactiveRuntimeParityForRecords(records) });
  return { ...data, assertCurrent };
}

export async function interactiveRuntimeRecords(context: CommandContext, options: CatalogRankingOptions = {}): Promise<readonly AgentHarnessInteractiveRuntimeRecord[]> {
  return (await acquireInteractiveRuntimeSnapshot(context, options)).records;
}

function complete(record: AgentHarnessInteractiveRuntimeRecord): boolean {
  return record.certification.schemaStatus === 'certified' && record.certification.missingSignals.length === 0
    && (record.status === 'ready' || record.status === 'running' || record.status === 'completed');
}

function kindSummary(records: readonly AgentHarnessInteractiveRuntimeRecord[], kind: AgentHarnessInteractiveRuntimeKind): Record<string, unknown> {
  const matches = records.filter((record) => record.kind === kind);
  const certified = matches.filter(complete);
  return {
    status: certified.length > 0 ? 'certified' : matches.length > 0 ? 'attention' : 'not-published',
    recordCount: matches.length,
    certifiedRecordCount: certified.length,
    ...(matches[0] ? { latest: matches[0] } : {}),
  };
}

export function summarizeInteractiveRuntimeRecords(records: readonly AgentHarnessInteractiveRuntimeRecord[]): Record<string, unknown> {
  const certified = records.filter(complete);
  return {
    status: certified.length > 0 ? 'certified-live-runtime' : records.length > 0 ? 'attention' : 'not-published',
    recordCount: records.length,
    certifiedRecordCount: certified.length,
    liveProcessOutput: kindSummary(records, 'process-output'),
    ptySessions: kindSummary(records, 'pty-session'),
    sudoMediation: kindSummary(records, 'sudo-mediation'),
    browserDesktopControl: kindSummary(records, 'browser-desktop-receipt'),
    latestRecords: records.slice(0, 6),
    policy: 'Certified interactive runtime records are read-only evidence until the selected published route is invoked with its own confirmation boundary.',
  };
}

export interface InteractiveRuntimeParity {
  readonly stdinWriteContract: boolean;
  readonly ptyContract: boolean;
  readonly sudoMediationContract: boolean;
  readonly browserDesktopControlContract: boolean;
  readonly browserDesktopRoute: string | null;
  readonly browserDesktopRecords: readonly AgentHarnessInteractiveRuntimeRecord[];
}

export function interactiveRuntimeParityForRecords(records: readonly AgentHarnessInteractiveRuntimeRecord[]): InteractiveRuntimeParity {
  const certified = records.filter(complete);
  const hasRoute = (record: AgentHarnessInteractiveRuntimeRecord, id: string) => record.routes.some((route) => route.id === id);
  const browserDesktopRecords = certified.filter((record) => record.kind === 'browser-desktop-receipt');
  return {
    stdinWriteContract: certified.some((record) => (record.kind === 'process-output' || record.kind === 'pty-session') && hasRoute(record, 'write')),
    ptyContract: certified.some((record) => record.kind === 'pty-session'),
    sudoMediationContract: certified.some((record) => record.kind === 'sudo-mediation'),
    browserDesktopControlContract: browserDesktopRecords.length > 0,
    browserDesktopRoute: browserDesktopRecords[0]?.routes.find((route) => route.id === 'execute')?.modelRoute ?? browserDesktopRecords[0]?.routes.find((route) => route.id === 'inspect')?.modelRoute ?? null,
    browserDesktopRecords,
  };
}

export async function interactiveRuntimeCapabilitySummary(context: CommandContext, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  return (await acquireInteractiveRuntimeSnapshot(context, options)).capabilitySummary;
}

export async function interactiveRuntimeParityStatus(context: CommandContext, options: CatalogRankingOptions = {}): Promise<InteractiveRuntimeParity> {
  return (await acquireInteractiveRuntimeSnapshot(context, options)).parityStatus;
}
