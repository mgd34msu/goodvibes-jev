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

function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const raw = readString(value).toLowerCase();
  if (['true', 'yes', '1', 'ready', 'available', 'published', 'certified'].includes(raw)) return true;
  if (['false', 'no', '0', 'blocked', 'missing', 'unavailable'].includes(raw)) return false;
  return null;
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

function schemaStatus(records: readonly Readonly<Record<string, unknown>>[]): AgentHarnessInteractiveRuntimeCertification['schemaStatus'] {
  const explicit = firstString(records, ['schemaStatus', 'receiptSchemaStatus', 'certificationStatus']).toLowerCase().replace(/[_\s]+/g, '-');
  if (['certified', 'valid', 'verified', 'schema-certified'].includes(explicit)) return 'certified';
  return firstString(records, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion'])
    && firstString(records, ['publicationGuarantee', 'hostPublicationGuarantee', 'runtimePublicationGuarantee'])
    && firstString(records, ['publisher', 'publisherId', 'daemonId', 'hostId', 'methodId', 'sourceTool'])
    ? 'certified'
    : 'legacy';
}

function routeValue(value: unknown): string {
  const direct = readString(value);
  if (direct) return direct;
  const record = readRecord(value);
  return readString(record.modelRoute) || readString(record.route) || readString(record.command) || readString(record.action) || readString(record.href) || readString(record.url);
}

function routeFrom(record: Readonly<Record<string, unknown>>, aliases: readonly string[]): string {
  const containers = [record, readRecord(record.routes), readRecord(record.modelRoutes), readRecord(record.actions), readRecord(record.commands), readRecord(record.links)];
  for (const alias of aliases) {
    for (const container of containers) {
      const route = routeValue(container[alias]) || routeValue(container[`${alias}Route`]) || routeValue(container[`${alias}Command`]) || routeValue(container[`${alias}Action`]);
      if (route) return route;
    }
  }
  return '';
}

function runtimeKind(record: Readonly<Record<string, unknown>>, fallback: AgentHarnessInteractiveRuntimeKind): AgentHarnessInteractiveRuntimeKind {
  const raw = `${readString(record.kind) || readString(record.recordKind) || readString(record.type) || readString(record.capability)}`.toLowerCase();
  if (/pty|terminal-session|interactive-session/.test(raw)) return 'pty-session';
  if (/sudo|credential|privilege/.test(raw)) return 'sudo-mediation';
  if (/browser|desktop|screenshot|screen|computer|control|receipt/.test(raw)) return 'browser-desktop-receipt';
  if (/process|output|chunk|terminal/.test(raw)) return 'process-output';
  return fallback;
}

function normalizeStatus(value: unknown): AgentHarnessInteractiveRuntimeStatus {
  const raw = readString(value).toLowerCase().replace(/_/g, '-');
  if (['ready', 'available', 'published', 'certified', 'ok', 'healthy'].includes(raw)) return 'ready';
  if (['running', 'active', 'in-progress'].includes(raw)) return 'running';
  if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(raw)) return 'completed';
  if (['blocked', 'denied', 'permission-denied'].includes(raw)) return 'blocked';
  if (['failed', 'failure', 'error', 'errored'].includes(raw)) return 'failed';
  if (['attention', 'review', 'stale'].includes(raw)) return 'attention';
  return raw ? 'unknown' : 'unknown';
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

function routesFor(kind: AgentHarnessInteractiveRuntimeKind, record: Readonly<Record<string, unknown>>): readonly AgentHarnessInteractiveRuntimeRoute[] {
  const routeSpecs: readonly [string, string, readonly string[], AgentHarnessInteractiveRuntimeRoute['effect']][] = [
    ['inspect', 'Inspect record', ['inspect', 'status', 'show'], 'read-only'],
    ['log', 'Read output', ['log', 'output', 'chunks', 'tail'], 'read-only'],
    ['write', 'Write input', ['write', 'stdin', 'input', 'sendInput'], 'confirmed'],
    ['resize', 'Resize session', ['resize'], 'confirmed'],
    ['close', 'Close session', ['close', 'stop', 'kill', 'cancel'], 'confirmed'],
    ['credential', 'Mediated credential prompt', ['credential', 'sudo', 'privilege', 'prompt'], 'confirmed-admin'],
    ['execute', kind === 'browser-desktop-receipt' ? 'Execute trusted control' : 'Execute route', ['execute', 'command', 'control', 'run'], 'confirmed'],
    ['receipt', 'Inspect receipt', ['receipt', 'receipts', 'history'], 'read-only'],
  ];
  return routeSpecs
    .map(([id, label, aliases, effect]) => {
      const modelRoute = routeFrom(record, aliases);
      return modelRoute ? { id, label, modelRoute: redactedPreview(modelRoute, 220), effect } : null;
    })
    .filter((route): route is AgentHarnessInteractiveRuntimeRoute => route !== null);
}

function outputChunks(record: Readonly<Record<string, unknown>>): readonly Record<string, unknown>[] {
  const output = readRecord(record.output);
  const rawChunks = Array.isArray(record.outputChunks) ? record.outputChunks
    : Array.isArray(record.chunks) ? record.chunks
    : Array.isArray(output.chunks) ? output.chunks
    : [];
  const chunks = rawChunks.flatMap((entry, index): Record<string, unknown>[] => {
    const chunk = readRecord(entry);
    const text = redactedPreview(chunk.text ?? chunk.preview ?? chunk.data ?? chunk.content, 600);
    return text ? [{
      chunkId: readString(chunk.chunkId) || readString(chunk.id) || `${index + 1}`,
      stream: readString(chunk.stream) || readString(chunk.channel) || 'stdout',
      text,
      chars: readNumber(chunk.chars) ?? text.length,
      bytes: readNumber(chunk.bytes) ?? Buffer.byteLength(text),
      truncated: readBoolean(chunk.truncated) ?? false,
      createdAt: readTimestamp(chunk.createdAt ?? chunk.timestamp),
    }] : [];
  });
  if (chunks.length > 0) return chunks.slice(0, 5);
  return ['stdoutTail', 'stderrTail', 'stdout', 'stderr'].flatMap((key) => {
    const text = redactedPreview(record[key] ?? output[key], 600);
    return text ? [{ chunkId: key, stream: key.includes('stderr') ? 'stderr' : 'stdout', text, chars: text.length, bytes: Buffer.byteLength(text), truncated: false }] : [];
  }).slice(0, 5);
}

function certification(input: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly source: string;
  readonly kind: AgentHarnessInteractiveRuntimeKind;
  readonly id: string;
  readonly routes: readonly AgentHarnessInteractiveRuntimeRoute[];
  readonly chunks: readonly Record<string, unknown>[];
}): AgentHarnessInteractiveRuntimeCertification {
  const records = certificationRecords(input.record);
  const status = schemaStatus(records);
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
  const rawSecretReturned = readBoolean(input.record.rawSecretReturned) === true || readBoolean(input.record.rawValueReturned) === true;
  const missingSignals = [
    ...(status === 'certified' ? [] : [`Certified ${input.kind} schema is not published.`]),
    ...(input.id ? [] : [`Durable ${input.kind} id is not published.`]),
    ...(publicationGuarantee ? [] : [`${input.kind} publication guarantee is not published.`]),
    ...(publisher ? [] : [`${input.kind} publisher is not published.`]),
    ...(provenance.length > 0 ? [] : [`${input.kind} provenance is not published.`]),
    ...(input.kind === 'process-output' && input.chunks.length === 0 && !hasRoute('log') ? ['Live process output chunks or log route are not published.'] : []),
    ...(input.kind === 'pty-session' && (!hasRoute('write') || (!hasRoute('log') && input.chunks.length === 0)) ? ['PTY input and output routes are not both published.'] : []),
    ...(input.kind === 'sudo-mediation' && (!hasRoute('credential') || rawSecretReturned) ? ['Sudo credential mediation route is missing or raw secret exposure was reported.'] : []),
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

function normalizeRecord(value: unknown, source: string, fallbackKind: AgentHarnessInteractiveRuntimeKind): AgentHarnessInteractiveRuntimeRecord | null {
  const record = readRecord(value);
  if (Object.keys(record).length === 0) return null;
  const kind = runtimeKind(record, fallbackKind);
  const id = readId(record, kind);
  if (!id) return null;
  const routes = routesFor(kind, record);
  const chunks = outputChunks(record);
  const command = redactedPreview(record.command ?? record.cmd, 180);
  const receiptId = readString(record.receiptId) || readString(record.operationReceiptId) || readString(record.commandReceiptId);
  return {
    id,
    kind,
    status: normalizeStatus(record.status ?? record.state ?? record.outcome),
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
    certification: certification({ record, source, kind, id, routes, chunks }),
  };
}

function readSnapshot(source: unknown): unknown {
  if (typeof source === 'function') {
    const value = (source as () => unknown)();
    return value && typeof (value as Promise<unknown>).then === 'function' ? undefined : value;
  }
  const record = readRecord(source);
  for (const methodName of ['getSnapshot', 'snapshot', 'list', 'records']) {
    const method = record[methodName];
    if (typeof method !== 'function') continue;
    const value = (method as () => unknown)();
    return value && typeof (value as Promise<unknown>).then === 'function' ? undefined : value;
  }
  return source;
}

function recordsFromSnapshot(snapshot: unknown, fallbackKind: AgentHarnessInteractiveRuntimeKind): readonly { readonly kind: AgentHarnessInteractiveRuntimeKind; readonly value: unknown }[] {
  if (Array.isArray(snapshot)) return snapshot.map((value) => ({ kind: fallbackKind, value }));
  const record = readRecord(snapshot);
  const keyed: Array<readonly [string, AgentHarnessInteractiveRuntimeKind]> = [
    ['processes', 'process-output'],
    ['liveProcesses', 'process-output'],
    ['outputChunks', 'process-output'],
    ['ptySessions', 'pty-session'],
    ['sessions', 'pty-session'],
    ['sudoMediation', 'sudo-mediation'],
    ['credentials', 'sudo-mediation'],
    ['browserDesktopReceipts', 'browser-desktop-receipt'],
    ['controlReceipts', 'browser-desktop-receipt'],
    ['receipts', 'browser-desktop-receipt'],
    ['records', fallbackKind],
    ['items', fallbackKind],
  ];
  const values: { kind: AgentHarnessInteractiveRuntimeKind; value: unknown }[] = [];
  for (const [key, kind] of keyed) {
    const candidate = record[key];
    if (Array.isArray(candidate)) values.push(...candidate.map((value) => ({ kind, value })));
    else {
      const map = readRecord(candidate);
      if (Object.keys(map).length > 0) values.push(...Object.entries(map).map(([id, value]) => ({ kind, value: { ...readRecord(value), id: readString(readRecord(value).id) || id } })));
    }
  }
  return values.length > 0 ? values : Object.keys(record).length > 0 ? [{ kind: fallbackKind, value: record }] : [];
}

function runtimeSources(context: CommandContext): readonly { readonly path: string; readonly source: unknown; readonly kind: AgentHarnessInteractiveRuntimeKind }[] {
  const platform = context.platform as unknown as Record<string, unknown>;
  const clients = readRecord(context.clients);
  const extensions = context.extensions as unknown as Record<string, unknown>;
  const readModels = readRecord(platform.readModels);
  const execution = readRecord(readModels.execution);
  const computer = readRecord(readModels.computer);
  const browser = readRecord(readModels.browser);
  const operatorSdk = readRecord(clients.operatorSdk);
  const daemonRuntime = readRecord(extensions.daemonRuntime);
  return [
    { path: 'context.platform.readModels.execution.interactiveRuntime', source: execution.interactiveRuntime, kind: 'process-output' },
    { path: 'context.platform.readModels.execution.processRuntime', source: execution.processRuntime, kind: 'process-output' },
    { path: 'context.platform.readModels.execution.ptySessions', source: execution.ptySessions, kind: 'pty-session' },
    { path: 'context.platform.readModels.execution.sudoMediation', source: execution.sudoMediation, kind: 'sudo-mediation' },
    { path: 'context.platform.readModels.computer.browserDesktopReceipts', source: computer.browserDesktopReceipts, kind: 'browser-desktop-receipt' },
    { path: 'context.platform.readModels.browser.controlReceipts', source: browser.controlReceipts, kind: 'browser-desktop-receipt' },
    { path: 'context.clients.operatorSdk.execution.interactiveRuntime', source: readRecord(operatorSdk.execution).interactiveRuntime, kind: 'process-output' },
    { path: 'context.extensions.daemonRuntime.interactiveRuntime', source: daemonRuntime.interactiveRuntime, kind: 'process-output' },
  ];
}

export function interactiveRuntimeRecords(context: CommandContext): readonly AgentHarnessInteractiveRuntimeRecord[] {
  const records: AgentHarnessInteractiveRuntimeRecord[] = [];
  for (const source of runtimeSources(context)) {
    if (source.source === undefined || source.source === null) continue;
    try {
      const snapshot = readSnapshot(source.source);
      records.push(...recordsFromSnapshot(snapshot, source.kind)
        .map((entry) => normalizeRecord(entry.value, source.path, entry.kind))
        .filter((entry): entry is AgentHarnessInteractiveRuntimeRecord => entry !== null));
    } catch {
      // Runtime read models are optional; a broken publisher should not hide local execution posture.
    }
  }
  return records.sort((left, right) => {
    const delta = (right.updatedAt ? Date.parse(right.updatedAt) : 0) - (left.updatedAt ? Date.parse(left.updatedAt) : 0);
    return delta || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
  });
}

function complete(record: AgentHarnessInteractiveRuntimeRecord): boolean {
  return record.certification.schemaStatus === 'certified' && record.certification.missingSignals.length === 0;
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

export function interactiveRuntimeCapabilitySummary(context: CommandContext): Record<string, unknown> {
  const records = interactiveRuntimeRecords(context);
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

export function interactiveRuntimeParityStatus(context: CommandContext): {
  readonly stdinWriteContract: boolean;
  readonly ptyContract: boolean;
  readonly sudoMediationContract: boolean;
  readonly browserDesktopControlContract: boolean;
  readonly browserDesktopRoute: string | null;
  readonly browserDesktopRecords: readonly AgentHarnessInteractiveRuntimeRecord[];
} {
  const certified = interactiveRuntimeRecords(context).filter(complete);
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
