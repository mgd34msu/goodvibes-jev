import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { AgentSetupWizardDurableReceipt, AgentSetupWizardDurableReceiptStatus, AgentSetupWizardReceiptSchemaStatus } from './setup-wizard.ts';

interface SetupReceiptInput {
  readonly id: string;
  readonly filename?: string | null;
  readonly createdAt?: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly inspectRoute: string | null;
  readonly source?: string;
}

const SETUP_RECEIPT_PURPOSES = new Set([
  'agent-setup-receipt',
  'goodvibes-setup-receipt',
  'connected-host-setup-receipt',
  'connected-host-service-receipt',
  'connected-host-auth-receipt',
  'connected-host-browser-pwa-receipt',
  'browser-pwa-first-run-receipt',
]);

const STEP_LABELS: Readonly<Record<string, string>> = {
  'connected-host-readiness': 'Connected host',
  runtime: 'Connected host',
  'connected-host-auth': 'Connected-host auth',
  'install-smoke': 'Install smoke',
  'browser-pwa': 'Browser/PWA',
};

const SETUP_RECEIPT_SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/("?\b(?:api[-_]?key|apikey|token|secret|password|passwd|credential|authorization)\b"?\s*:\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1"<redacted>"'],
  [/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|BEARER)[A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/gi, '$1=<redacted>'],
  [/(\b(?:token|secret|password|passwd|api[-_]?key|apikey|authorization|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1<redacted>'],
  [/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>'],
];

function metadataString(metadata: Readonly<Record<string, unknown>>, key: string): string {
  const value = metadata[key];
  return typeof value === 'string' ? value.trim() : '';
}

function firstMetadataString(metadata: Readonly<Record<string, unknown>>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = metadataString(metadata, key);
    if (value) return value;
  }
  return '';
}

function metadataBoolean(metadata: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = metadata[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['true', 'yes', '1'].includes(value.trim().toLowerCase());
  return false;
}

function metadataNumber(metadata: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = metadata[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isoFromValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function receiptRecordedAt(input: SetupReceiptInput): string | null {
  for (const key of ['recordedAt', 'capturedAt', 'completedAt', 'createdAt', 'timestamp']) {
    const value = isoFromValue(input.metadata[key]);
    if (value) return value;
  }
  return isoFromValue(input.createdAt);
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

function normalizeStatus(raw: string): AgentSetupWizardDurableReceiptStatus {
  const value = normalizeToken(raw);
  if (!value) return 'unknown';
  if ([
    'ready',
    'ready-for-user-run',
    'complete',
    'completed',
    'ok',
    'success',
    'succeeded',
    'passed',
    'reachable',
    'authenticated',
    'published',
    'usable',
    'active',
    'running',
    'online',
    'healthy',
  ].includes(value)) return 'ready';
  if ([
    'blocked',
    'not-ready',
    'setup-needed',
    'needs-setup',
    'missing',
    'unavailable',
    'unreachable',
    'unauthenticated',
    'pending',
  ].includes(value)) return 'blocked';
  if (['failed', 'failure', 'error', 'errored'].includes(value)) return 'failed';
  return 'unknown';
}

function normalizeSchemaStatus(metadata: Readonly<Record<string, unknown>>): AgentSetupWizardReceiptSchemaStatus {
  const explicit = normalizeToken(firstMetadataString(metadata, ['schemaStatus', 'receiptSchemaStatus', 'certificationStatus']));
  if (['certified', 'valid', 'verified', 'schema-certified'].includes(explicit)) return 'certified';
  const schemaVersion = firstMetadataString(metadata, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion']);
  const provenance = firstMetadataString(metadata, ['repairRoute', 'actionRoute', 'methodId', 'actionId', 'sourceTool']);
  const publicationGuarantee = firstMetadataString(metadata, ['publicationGuarantee', 'hostPublicationGuarantee', 'firstRunPublicationGuarantee']);
  return schemaVersion && provenance && publicationGuarantee ? 'certified' : 'legacy';
}

function normalizeStepId(raw: string): string {
  const value = normalizeToken(raw);
  if (value === 'runtime') return 'connected-host-readiness';
  if (value === 'connected-host' || value === 'connected-host-status' || value === 'service-status' || value === 'services-status') {
    return 'connected-host-readiness';
  }
  if (value === 'connected-host-token' || value === 'operator-token' || value === 'auth') return 'connected-host-auth';
  if (value === 'setup-smoke' || value === 'smoke') return 'install-smoke';
  if (value === 'browser' || value === 'pwa' || value === 'browser-first-run' || value === 'web-cockpit') return 'browser-pwa';
  return value;
}

function inferStepIdFromMetadata(metadata: Readonly<Record<string, unknown>>, filename = ''): string {
  const explicit = firstMetadataString(metadata, ['setupStepId', 'setupItemId', 'stepId', 'wizardStepId']);
  if (explicit) return normalizeStepId(explicit);

  const evidence = [
    metadataString(metadata, 'receiptKind'),
    metadataString(metadata, 'methodId'),
    metadataString(metadata, 'purpose'),
    metadataString(metadata, 'source'),
    metadataString(metadata, 'label'),
    metadataString(metadata, 'summary'),
    filename,
  ].join(' ').toLowerCase();

  if (/\b(browser-pwa|browser|pwa|web-cockpit)\b/.test(evidence)) return 'browser-pwa';
  if (/\b(install-smoke|setup-smoke|smoke|first-assistant-turn)\b/.test(evidence)) return 'install-smoke';
  if (/\b(connected-host-auth|operator-token|auth|token|authenticated)\b/.test(evidence)) return 'connected-host-auth';
  if (/\b(services?\.status|connected-host-readiness|connected-host-status|service-status|runtime|host-status)\b/.test(evidence)) {
    return 'connected-host-readiness';
  }
  return '';
}

function isSetupReceiptArtifact(artifact: ArtifactDescriptor): boolean {
  const purpose = metadataString(artifact.metadata, 'purpose');
  return SETUP_RECEIPT_PURPOSES.has(purpose) || metadataBoolean(artifact.metadata, 'setupReceipt');
}

function isSetupReceiptRecord(metadata: Readonly<Record<string, unknown>>): boolean {
  const purpose = metadataString(metadata, 'purpose');
  if (SETUP_RECEIPT_PURPOSES.has(purpose) || metadataBoolean(metadata, 'setupReceipt')) return true;
  return Boolean(firstMetadataString(metadata, ['setupStepId', 'setupItemId', 'stepId', 'wizardStepId', 'receiptId', 'durableReceiptId', 'eventId']));
}

function redactSetupReceiptText(value: string): string {
  return SETUP_RECEIPT_SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function redactedMetadataString(metadata: Readonly<Record<string, unknown>>, key: string): string {
  const value = metadataString(metadata, key);
  return value ? redactSetupReceiptText(value) : '';
}

function receiptProvenance(metadata: Readonly<Record<string, unknown>>): readonly string[] {
  return [
    redactedMetadataString(metadata, 'methodId') ? `method ${redactedMetadataString(metadata, 'methodId')}` : '',
    redactedMetadataString(metadata, 'actionId') ? `action ${redactedMetadataString(metadata, 'actionId')}` : '',
    redactedMetadataString(metadata, 'repairRoute') ? `repair ${redactedMetadataString(metadata, 'repairRoute')}` : '',
    redactedMetadataString(metadata, 'actionRoute') ? `actionRoute ${redactedMetadataString(metadata, 'actionRoute')}` : '',
    redactedMetadataString(metadata, 'sourceTool') ? `sourceTool ${redactedMetadataString(metadata, 'sourceTool')}` : '',
  ].filter(Boolean).slice(0, 8);
}

function receiptSummary(
  metadata: Readonly<Record<string, unknown>>,
  stepId: string,
  status: AgentSetupWizardDurableReceiptStatus,
): string {
  return redactSetupReceiptText(firstMetadataString(metadata, ['summary', 'receiptSummary', 'label']))
    || `${STEP_LABELS[stepId] ?? stepId} durable setup receipt is ${status}.`;
}

function buildSetupWizardDurableReceipt(input: SetupReceiptInput): AgentSetupWizardDurableReceipt | null {
  if (!isSetupReceiptRecord(input.metadata)) return null;
  const stepId = inferStepIdFromMetadata(input.metadata, input.filename ?? '');
  if (!stepId) return null;
  const recordedAt = receiptRecordedAt(input);
  if (!recordedAt) return null;
  const status = normalizeStatus(firstMetadataString(input.metadata, ['receiptStatus', 'status', 'result', 'outcome', 'state']));
  const receiptId = firstMetadataString(input.metadata, ['receiptId', 'durableReceiptId', 'eventId', 'id']) || input.id;
  const inspectRoute = firstMetadataString(input.metadata, ['inspectRoute', 'modelRoute', 'route'])
    || input.inspectRoute
    || `setup action:"item" setupItemId:"${stepId}" includeParameters:true`;
  const schemaStatus = normalizeSchemaStatus(input.metadata);
  const schemaVersion = firstMetadataString(input.metadata, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion']);
  const publicationGuarantee = redactedMetadataString(input.metadata, 'publicationGuarantee')
    || redactedMetadataString(input.metadata, 'hostPublicationGuarantee')
    || redactedMetadataString(input.metadata, 'firstRunPublicationGuarantee');
  const eventCursor = firstMetadataString(input.metadata, ['eventCursor', 'cursor', 'streamCursor']);
  const eventSequence = metadataNumber(input.metadata, 'eventSequence')
    ?? metadataNumber(input.metadata, 'sequence')
    ?? metadataNumber(input.metadata, 'streamSequence')
    ?? metadataNumber(input.metadata, 'offset');
  const publisher = firstMetadataString(input.metadata, ['publisher', 'publisherId', 'daemonId', 'hostId']);
  const provenance = receiptProvenance(input.metadata);
  return {
    stepId,
    stepLabel: metadataString(input.metadata, 'stepLabel') || STEP_LABELS[stepId],
    status,
    receiptId,
    recordedAt,
    summary: receiptSummary(input.metadata, stepId, status),
    inspectRoute,
    source: input.source || metadataString(input.metadata, 'source') || undefined,
    schemaStatus,
    ...(schemaVersion ? { schemaVersion } : {}),
    ...(provenance.length > 0 ? { provenance } : {}),
    ...(publicationGuarantee ? { publicationGuarantee } : {}),
    ...(eventCursor ? { eventCursor } : {}),
    ...(eventSequence !== undefined ? { eventSequence } : {}),
    ...(publisher ? { publisher } : {}),
  };
}

export function buildSetupWizardDurableReceipts(
  artifacts: readonly ArtifactDescriptor[],
): readonly AgentSetupWizardDurableReceipt[] {
  return artifacts.flatMap((artifact) => {
    if (!isSetupReceiptArtifact(artifact)) return [];
    const receipt = buildSetupWizardDurableReceipt({
      id: artifact.id,
      filename: artifact.filename,
      createdAt: artifact.createdAt,
      metadata: artifact.metadata,
      inspectRoute: `agent_artifacts show artifactId:"${artifact.id}" includeContent:false`,
      source: metadataString(artifact.metadata, 'source') || metadataString(artifact.metadata, 'purpose') || undefined,
    });
    return receipt ? [receipt] : [];
  });
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function recordsFromSetupReadModelSnapshot(snapshot: unknown, inherited: Readonly<Record<string, unknown>> = {}): readonly unknown[] {
  if (Array.isArray(snapshot)) {
    return snapshot.map((entry, index) => {
      const entryRecord = readRecord(entry);
      if (Object.keys(entryRecord).length === 0) return entry;
      return {
        ...inherited,
        ...entryRecord,
        ...(metadataNumber(entryRecord, 'eventSequence') === undefined && metadataString(inherited, 'eventStream') ? { eventSequence: index } : {}),
      };
    });
  }
  const record = readRecord(snapshot);
  const inheritedCursor = firstMetadataString(record, ['eventCursor', 'cursor', 'streamCursor']);
  const inheritedSequence = metadataNumber(record, 'eventSequence')
    ?? metadataNumber(record, 'sequence')
    ?? metadataNumber(record, 'streamSequence')
    ?? metadataNumber(record, 'offset');
  const baseInherited = {
    ...inherited,
    ...(inheritedCursor ? { eventCursor: inheritedCursor } : {}),
    ...(inheritedSequence !== undefined ? { eventSequence: inheritedSequence } : {}),
  };
  for (const key of ['setupReceipts', 'receipts', 'durableReceipts', 'receiptEvents', 'setupReceiptEvents', 'eventStream', 'stream', 'events', 'records', 'items', 'entries']) {
    const value = record[key];
    const eventStream = /event|stream/i.test(key);
    const childInherited = eventStream ? { ...baseInherited, eventStream: 'true' } : baseInherited;
    if (Array.isArray(value)) return recordsFromSetupReadModelSnapshot(value, childInherited);
    const valueRecord = readRecord(value);
    if (Object.keys(valueRecord).length > 0) {
      return Object.entries(valueRecord).map(([id, entry]) => {
        const entryRecord = readRecord(entry);
        if (Object.keys(entryRecord).length === 0 || metadataString(entryRecord, 'id') || metadataString(entryRecord, 'receiptId')) return entry;
        return { ...childInherited, ...entryRecord, id };
      });
    }
  }
  return isSetupReceiptRecord(record) ? [{ ...baseInherited, ...record }] : [];
}

export function buildSetupWizardDurableReceiptsFromReadModel(
  snapshot: unknown,
  source: string,
): readonly AgentSetupWizardDurableReceipt[] {
  return recordsFromSetupReadModelSnapshot(snapshot).flatMap((value) => {
    const record = readRecord(value);
    if (Object.keys(record).length === 0) return [];
    const metadata = {
      ...readRecord(record.metadata),
      ...record,
    };
    const receipt = buildSetupWizardDurableReceipt({
      id: firstMetadataString(metadata, ['id', 'receiptId', 'durableReceiptId', 'eventId']) || source,
      filename: metadataString(metadata, 'filename') || null,
      createdAt: metadata.createdAt,
      metadata,
      inspectRoute: metadataString(metadata, 'inspectRoute') || null,
      source,
    });
    return receipt ? [receipt] : [];
  });
}

function receiptRank(receipt: AgentSetupWizardDurableReceipt): number {
  if (receipt.status === 'ready') return 3;
  if (receipt.status === 'blocked') return 2;
  if (receipt.status === 'failed') return 1;
  return 0;
}

function preferReceipt(
  current: AgentSetupWizardDurableReceipt,
  candidate: AgentSetupWizardDurableReceipt,
): AgentSetupWizardDurableReceipt {
  const rankDelta = receiptRank(candidate) - receiptRank(current);
  if (rankDelta > 0) return candidate;
  if (rankDelta < 0) return current;
  const currentTime = Date.parse(current.recordedAt);
  const candidateTime = Date.parse(candidate.recordedAt);
  if (candidateTime > currentTime) return candidate;
  return current;
}

export function mergeSetupWizardDurableReceipts(
  ...receiptLists: readonly (readonly AgentSetupWizardDurableReceipt[])[]
): readonly AgentSetupWizardDurableReceipt[] {
  const byKey = new Map<string, AgentSetupWizardDurableReceipt>();
  for (const receipt of receiptLists.flat()) {
    const key = `${receipt.stepId}:${receipt.receiptId}`;
    const current = byKey.get(key);
    byKey.set(key, current ? preferReceipt(current, receipt) : receipt);
  }
  return [...byKey.values()].sort((left, right) => {
    const timeDelta = Date.parse(right.recordedAt) - Date.parse(left.recordedAt);
    if (timeDelta !== 0) return timeDelta;
    return left.receiptId.localeCompare(right.receiptId);
  });
}
