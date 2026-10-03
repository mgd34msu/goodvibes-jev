import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';

export interface DeviceLiveRecordCertification {
  readonly schemaStatus: 'certified' | 'legacy';
  readonly schemaVersion?: string;
  readonly publicationGuarantee?: string;
  readonly publisher?: string;
  readonly provenance?: readonly string[];
  readonly receiptId?: string;
  readonly cursor?: string;
  readonly missingSignals: readonly string[];
  readonly policy: string;
}

export interface DeviceLiveCapabilityRecord {
  readonly id: string;
  readonly capabilityId: string;
  readonly label: string | null;
  readonly domain: string;
  readonly status: string;
  readonly summary: string | null;
  readonly capabilities: readonly string[];
  readonly permissionScope: string | null;
  readonly route: string | null;
  readonly modelRoute: string;
  readonly controlRoutes: Readonly<Record<string, string>>;
  readonly sourcePath: string;
  readonly source: 'daemon-read-model' | 'sdk-read-model';
  readonly certification: DeviceLiveRecordCertification;
}

export interface DeviceLiveReadModelSnapshot {
  readonly capabilities: readonly DeviceLiveCapabilityRecord[];
  readonly sourceCounts: Readonly<Record<string, number>>;
}

interface SourceCandidate {
  readonly path: string;
  readonly source: unknown;
  readonly kind: 'daemon-read-model' | 'sdk-read-model';
}

interface CollectedRecord {
  readonly path: string;
  readonly kind: 'daemon-read-model' | 'sdk-read-model';
  readonly record: Record<string, unknown>;
}

const WRAPPER_KEYS = [
  'records',
  'items',
  'capabilities',
  'deviceCapabilities',
  'mobileCapabilities',
  'voiceWorkflows',
  'workflows',
  'sensors',
  'sensorRoutes',
] as const;

const SNAPSHOT_METHODS = ['getSnapshot', 'snapshot', 'toJSON'] as const;
const LIST_METHODS = ['listCapabilities', 'listDeviceCapabilities', 'listSensors', 'listVoiceWorkflows', 'list'] as const;

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readMetadata(record: Record<string, unknown>): Record<string, unknown> {
  return readObject(record.metadata);
}

function nestedString(record: Record<string, unknown>, key: string): string {
  return readString(record[key])
    || readString(readMetadata(record)[key])
    || readString(readObject(record.capability)[key])
    || readString(readObject(record.device)[key])
    || readString(readObject(record.permission)[key])
    || readString(readObject(record.evidence)[key])
    || readString(readObject(record.route)[key]);
}

function certificationRecords(record: Record<string, unknown>): readonly Record<string, unknown>[] {
  return [
    record,
    readMetadata(record),
    readObject(record.schema),
    readObject(record.contract),
    readObject(record.publication),
    readObject(record.receipt),
    readObject(record.certification),
  ];
}

function firstAcross(records: readonly Record<string, unknown>[], keys: readonly string[]): string {
  for (const record of records) {
    for (const key of keys) {
      const value = readString(record[key]);
      if (value) return value;
    }
  }
  return '';
}

function stringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) return [...new Set(value.map((entry) => readString(entry)).filter(Boolean))].slice(0, 16);
  const text = readString(value);
  return text ? text.split(',').map((entry) => entry.trim()).filter(Boolean).slice(0, 16) : [];
}

function redactText(value: string): string {
  return value
    .replace(/\b(bearer)\s+[a-z0-9._~+/=-]+/gi, '$1 <redacted>')
    .replace(/\b(token|secret|password|api[_-]?key|authorization)\s*[:=]\s*[^,\s;/]+/gi, '$1=<redacted>');
}

function safePreview(value: string, limit: number): string {
  return previewHarnessText(redactText(value), limit);
}

function safeNullablePreview(value: string, limit: number): string | null {
  return value ? safePreview(value, limit) : null;
}

function schemaStatus(records: readonly Record<string, unknown>[]): DeviceLiveRecordCertification['schemaStatus'] {
  const explicit = firstAcross(records, ['schemaStatus', 'receiptSchemaStatus', 'certificationStatus']).toLowerCase().replace(/[_\s]+/g, '-');
  if (['certified', 'valid', 'verified', 'schema-certified'].includes(explicit)) return 'certified';
  return firstAcross(records, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion'])
    && firstAcross(records, ['publicationGuarantee', 'hostPublicationGuarantee', 'devicePublicationGuarantee'])
    && firstAcross(records, ['publisher', 'publisherId', 'daemonId', 'hostId'])
    ? 'certified'
    : 'legacy';
}

function routeMap(record: Record<string, unknown>): Readonly<Record<string, string>> {
  const routes = { ...readObject(record.routes), ...readObject(record.controls) };
  const output: Record<string, string> = {};
  for (const key of ['inspect', 'open', 'run', 'capture', 'repairPermission', 'grantPermission', 'revokePermission', 'test']) {
    const value = readString(routes[key]) || nestedString(record, `${key}Route`);
    if (value) output[key] = safePreview(value, 180);
  }
  return output;
}

function certification(input: {
  readonly record: Record<string, unknown>;
  readonly sourcePath: string;
  readonly id: string;
  readonly capabilityId: string;
  readonly status: string;
  readonly permissionScope: string;
  readonly modelRoute: string;
  readonly hasRoutes: boolean;
}): DeviceLiveRecordCertification {
  const records = certificationRecords(input.record);
  const currentSchemaStatus = schemaStatus(records);
  const schemaVersion = firstAcross(records, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion']);
  const publicationGuarantee = firstAcross(records, ['publicationGuarantee', 'hostPublicationGuarantee', 'devicePublicationGuarantee']);
  const publisher = firstAcross(records, ['publisher', 'publisherId', 'daemonId', 'hostId']);
  const receiptId = firstAcross(records, ['receiptId', 'capabilityReceiptId', 'permissionReceiptId', 'routeReceiptId']);
  const cursor = firstAcross(records, ['cursor', 'freshnessCursor', 'sequence', 'checkpoint']);
  const provenance = [...new Set([
    ...stringArray(input.record.provenance),
    input.sourcePath ? `source ${input.sourcePath}` : '',
    firstAcross(records, ['methodId']) ? `method ${firstAcross(records, ['methodId'])}` : '',
    firstAcross(records, ['sourceTool']) ? `sourceTool ${firstAcross(records, ['sourceTool'])}` : '',
  ].map((entry) => safePreview(entry, 180)).filter(Boolean))].slice(0, 8);
  const missingSignals = [
    ...(currentSchemaStatus === 'certified' ? [] : ['Certified device capability schema is not published.']),
    ...(input.id ? [] : ['Durable device capability record id is not published.']),
    ...(input.capabilityId ? [] : ['Device capability id is not published.']),
    ...(input.status ? [] : ['Device capability status is not published.']),
    ...(publicationGuarantee ? [] : ['Device capability publication guarantee is not published.']),
    ...(publisher ? [] : ['Device capability publisher is not published.']),
    ...(provenance.length > 0 ? [] : ['Device capability provenance is not published.']),
    ...(cursor ? [] : ['Device capability freshness cursor is not published.']),
    ...(input.permissionScope ? [] : ['Permission scope is not published.']),
    ...(input.modelRoute && input.hasRoutes ? [] : ['Exact inspect/control route is not published.']),
  ];
  return {
    schemaStatus: currentSchemaStatus,
    ...(schemaVersion ? { schemaVersion: safePreview(schemaVersion, 80) } : {}),
    ...(publicationGuarantee ? { publicationGuarantee: safePreview(publicationGuarantee, 220) } : {}),
    ...(publisher ? { publisher: safePreview(publisher, 80) } : {}),
    ...(provenance.length > 0 ? { provenance } : {}),
    ...(receiptId ? { receiptId: safePreview(receiptId, 96) } : {}),
    ...(cursor ? { cursor: safePreview(cursor, 96) } : {}),
    missingSignals,
    policy: 'Device capability read models certify release readiness only when the SDK or daemon publishes schema, durable capability ids, permission scope, publication guarantee, publisher/provenance, freshness cursor, exact inspect/control routes, and redacted receipt evidence.',
  };
}

function callMethod(source: Record<string, unknown>, method: string): unknown {
  const fn = source[method];
  if (typeof fn !== 'function') return undefined;
  try {
    return (fn as () => unknown).call(source);
  } catch {
    return undefined;
  }
}

function collectFromSource(
  source: unknown,
  path: string,
  kind: 'daemon-read-model' | 'sdk-read-model',
  visited = new WeakSet<object>(),
): readonly CollectedRecord[] {
  if (!source) return [];
  if (Array.isArray(source)) return source.flatMap((entry, index) => collectFromSource(entry, `${path}[${index}]`, kind, visited));
  if (source instanceof Map) return Array.from(source.entries()).flatMap(([key, value]) => collectFromSource(value, `${path}.${String(key)}`, kind, visited));
  if (typeof source !== 'object') return [];
  if (visited.has(source)) return [];
  visited.add(source);
  const record = source as Record<string, unknown>;
  const fromSnapshots = SNAPSHOT_METHODS.flatMap((method) => {
    const snapshot = callMethod(record, method);
    return snapshot === undefined ? [] : collectFromSource(snapshot, `${path}.${method}()`, kind, visited);
  });
  const fromMethods = LIST_METHODS.flatMap((method) => {
    const snapshot = callMethod(record, method);
    return snapshot === undefined ? [] : collectFromSource(snapshot, `${path}.${method}()`, kind, visited);
  });
  const fromWrappers = WRAPPER_KEYS.flatMap((key) => {
    if (!(key in record)) return [];
    return collectFromSource(record[key], `${path}.${key}`, kind, visited);
  });
  if (fromSnapshots.length > 0 || fromMethods.length > 0 || fromWrappers.length > 0) {
    return [...fromSnapshots, ...fromMethods, ...fromWrappers];
  }
  return [{ path, kind, record }];
}

function modelRoute(record: Record<string, unknown>, capabilityId: string): string {
  const routes = readObject(record.routes);
  return nestedString(record, 'modelRoute')
    || nestedString(record, 'inspectRoute')
    || nestedString(record, 'route')
    || readString(routes.inspect)
    || readString(routes.open)
    || readString(routes.run)
    || `device action:"capability" capabilityId:"${capabilityId}" includeParameters:true`;
}

function capabilityId(record: Record<string, unknown>, index: number): string {
  return nestedString(record, 'capabilityId')
    || nestedString(record, 'id')
    || nestedString(record, 'kind')
    || `device-capability-${index}`;
}

function normalizeCapability(entry: CollectedRecord, index: number): DeviceLiveCapabilityRecord | null {
  const capId = capabilityId(entry.record, index);
  if (!capId) return null;
  const id = nestedString(entry.record, 'id') || nestedString(entry.record, 'receiptId') || `device-live:${capId}:${index}`;
  const routes = routeMap(entry.record);
  const route = nestedString(entry.record, 'route') || nestedString(entry.record, 'openRoute') || routes.open || routes.run || routes.inspect || null;
  const routeForModel = modelRoute(entry.record, capId);
  const permissionScope = nestedString(entry.record, 'permissionScope') || nestedString(entry.record, 'scope') || nestedString(entry.record, 'permission');
  const status = nestedString(entry.record, 'status') || nestedString(entry.record, 'state') || 'unknown';
  return {
    id,
    capabilityId: capId,
    label: safeNullablePreview(nestedString(entry.record, 'label') || nestedString(entry.record, 'title'), 120),
    domain: nestedString(entry.record, 'domain') || nestedString(entry.record, 'surface') || 'device',
    status,
    summary: safeNullablePreview(nestedString(entry.record, 'summary') || nestedString(entry.record, 'detail'), 220),
    capabilities: [...new Set([
      ...stringArray(entry.record.capabilities),
      ...stringArray(entry.record.features),
      ...stringArray(readObject(entry.record.capability).capabilities),
      capId,
    ].map((value) => safePreview(value, 80)).filter(Boolean))].slice(0, 16),
    permissionScope: safeNullablePreview(permissionScope, 120),
    route: route ? safePreview(route, 180) : null,
    modelRoute: routeForModel,
    controlRoutes: routes,
    sourcePath: entry.path,
    source: entry.kind,
    certification: certification({
      record: entry.record,
      sourcePath: entry.path,
      id,
      capabilityId: capId,
      status,
      permissionScope,
      modelRoute: routeForModel,
      hasRoutes: Boolean(route || Object.keys(routes).length > 0),
    }),
  };
}

function sourceCounts(entries: readonly CollectedRecord[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.path] = (counts[entry.path] ?? 0) + 1;
  return counts;
}

function sources(context: CommandContext): readonly SourceCandidate[] {
  const platform = readObject(context.platform);
  const readModels = readObject(platform.readModels);
  const device = readObject(readModels.device);
  const companion = readObject(readModels.companion);
  const voice = readObject(readModels.voice);
  const opsDevice = readObject(readObject(context.ops).device);
  const clients = readObject(context.clients);
  const operator = readObject(clients.operator);
  const operatorSdk = readObject(clients.operatorSdk);
  return [
    { path: 'context.platform.readModels.device.capabilities', source: device.capabilities, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.device.sensors', source: device.sensors, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.companion.capabilities', source: companion.capabilities, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.voice.workflows', source: voice.workflows, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.deviceCapabilities', source: readModels.deviceCapabilities, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.companionCapabilities', source: readModels.companionCapabilities, kind: 'daemon-read-model' },
    { path: 'context.ops.device.capabilities', source: opsDevice.capabilities, kind: 'sdk-read-model' },
    { path: 'context.clients.operator.device.capabilities', source: readObject(operator.device).capabilities, kind: 'sdk-read-model' },
    { path: 'context.clients.operatorSdk.device.capabilities', source: readObject(operatorSdk.device).capabilities, kind: 'sdk-read-model' },
  ];
}

export function isCertifiedDeviceLiveRecord(record: DeviceLiveCapabilityRecord): boolean {
  return record.certification.schemaStatus === 'certified' && record.certification.missingSignals.length === 0;
}

export function certifiedDeviceLiveRecords(
  snapshot: DeviceLiveReadModelSnapshot,
  capabilityId: string,
  terms: readonly string[] = [],
): readonly DeviceLiveCapabilityRecord[] {
  const expected = [capabilityId, ...terms].map((term) => term.toLowerCase());
  return snapshot.capabilities.filter((record) => {
    if (!isCertifiedDeviceLiveRecord(record)) return false;
    const text = [
      record.id,
      record.capabilityId,
      record.label ?? '',
      record.domain,
      record.status,
      record.summary ?? '',
      record.permissionScope ?? '',
      ...record.capabilities,
    ].join('\n').toLowerCase();
    return expected.some((term) => text.includes(term));
  });
}

export function deviceLiveReadModelSnapshot(context: CommandContext): DeviceLiveReadModelSnapshot {
  const entries = sources(context).flatMap((candidate) => collectFromSource(candidate.source, candidate.path, candidate.kind));
  const seen = new Set<string>();
  const capabilities: DeviceLiveCapabilityRecord[] = [];
  for (const record of entries.map(normalizeCapability).filter((entry): entry is DeviceLiveCapabilityRecord => entry !== null)) {
    const key = `${record.capabilityId}:${record.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    capabilities.push(record);
  }
  return {
    capabilities,
    sourceCounts: sourceCounts(entries),
  };
}
