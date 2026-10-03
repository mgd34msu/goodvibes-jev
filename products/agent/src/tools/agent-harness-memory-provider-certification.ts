import { previewHarnessText } from './agent-harness-text.ts';
import { readRecord, readString } from './agent-harness-model-routing-utils.ts';

export interface MemoryExternalProviderCertification {
  readonly schemaStatus: 'certified' | 'legacy';
  readonly schemaVersion?: string;
  readonly publicationGuarantee?: string;
  readonly publisher?: string;
  readonly provenance?: readonly string[];
  readonly receiptId?: string;
  readonly receiptStatus?: string;
  readonly receiptRoute?: string;
  readonly receiptIds?: readonly string[];
  readonly receiptStreamStatus?: string;
  readonly missingSignals: readonly string[];
  readonly policy: string;
}

const MEMORY_CERT_SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/secret:\/\/[^\s,'"}]+/gi, 'secret://<redacted>'],
  [/("?\b(?:api[-_]?key|apikey|token|secret|password|passwd|credential|authorization)\b"?\s*:\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1"<redacted>"'],
  [/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|BEARER)[A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/gi, '$1=<redacted>'],
  [/(\b(?:token|secret|password|passwd|api[-_]?key|apikey|authorization|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1<redacted>'],
  [/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>'],
];

function redactedPreview(value: unknown, limit = 180): string {
  const raw = readString(value);
  const redacted = MEMORY_CERT_SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), raw);
  return previewHarnessText(redacted, limit);
}

function firstString(record: Readonly<Record<string, unknown>>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) return value;
  }
  return '';
}

function readStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((entry) => readString(entry)).filter(Boolean))].slice(0, 12);
  }
  const text = readString(value);
  return text ? text.split(',').map((entry) => entry.trim()).filter(Boolean).slice(0, 12) : [];
}

function recordsForCertification(record: Readonly<Record<string, unknown>>): readonly Readonly<Record<string, unknown>>[] {
  return [
    record,
    readRecord(record.schema),
    readRecord(record.contract),
    readRecord(record.providerContract),
    readRecord(record.memoryProviderContract),
    readRecord(record.receipt),
    readRecord(record.receiptContract),
    readRecord(record.publication),
    readRecord(record.certification),
  ];
}

function firstAcross(records: readonly Readonly<Record<string, unknown>>[], keys: readonly string[]): string {
  for (const record of records) {
    const value = firstString(record, keys);
    if (value) return value;
  }
  return '';
}

function normalizeSchemaStatus(records: readonly Readonly<Record<string, unknown>>[]): MemoryExternalProviderCertification['schemaStatus'] {
  const explicit = firstAcross(records, ['schemaStatus', 'receiptSchemaStatus', 'certificationStatus'])
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
  if (['certified', 'valid', 'verified', 'schema-certified'].includes(explicit)) return 'certified';
  const schemaVersion = firstAcross(records, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion']);
  const publicationGuarantee = firstAcross(records, ['publicationGuarantee', 'hostPublicationGuarantee', 'providerPublicationGuarantee', 'memoryPublicationGuarantee']);
  const proof = firstAcross(records, ['methodId', 'sourceTool', 'actionId', 'publisher', 'publisherId', 'daemonId', 'hostId']);
  return schemaVersion && publicationGuarantee && proof ? 'certified' : 'legacy';
}

function receiptIds(record: Readonly<Record<string, unknown>>, records: readonly Readonly<Record<string, unknown>>[], extraIds: readonly string[]): readonly string[] {
  const explicit = [
    ...extraIds,
    ...readStringArray(record.receiptIds),
    ...readStringArray(record.effectReceiptIds),
    ...readStringArray(record.providerReceiptIds),
    ...readStringArray(record.syncReceiptIds),
    firstAcross(records, ['receiptId', 'effectReceiptId', 'readReceiptId', 'writeReceiptId', 'syncReceiptId', 'forgetReceiptId', 'operationReceiptId']),
  ].filter(Boolean);
  return [...new Set(explicit.map((entry) => redactedPreview(entry, 96)))].slice(0, 12);
}

function provenance(record: Readonly<Record<string, unknown>>, records: readonly Readonly<Record<string, unknown>>[], sourcePath: string): readonly string[] {
  const values = [
    ...readStringArray(record.provenance),
    sourcePath ? `source ${sourcePath}` : '',
    firstAcross(records, ['methodId']) ? `method ${firstAcross(records, ['methodId'])}` : '',
    firstAcross(records, ['actionId']) ? `action ${firstAcross(records, ['actionId'])}` : '',
    firstAcross(records, ['sourceTool']) ? `sourceTool ${firstAcross(records, ['sourceTool'])}` : '',
  ];
  return [...new Set(values.map((entry) => redactedPreview(entry, 180)).filter(Boolean))].slice(0, 8);
}

function certifiedBase(input: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly sourcePath: string;
  readonly receiptIds?: readonly string[];
}): Omit<MemoryExternalProviderCertification, 'missingSignals' | 'policy'> & { readonly rawPublicationGuarantee: string; readonly rawPublisher: string; readonly rawReceiptRoute: string; readonly rawReceiptStreamStatus: string; readonly rawReceiptStatus: string; readonly rawSchemaVersion: string; readonly receiptIdsValue: readonly string[]; readonly schemaStatusValue: MemoryExternalProviderCertification['schemaStatus'] } {
  const records = recordsForCertification(input.record);
  const schemaStatus = normalizeSchemaStatus(records);
  const schemaVersion = firstAcross(records, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion']);
  const publicationGuarantee = firstAcross(records, ['publicationGuarantee', 'hostPublicationGuarantee', 'providerPublicationGuarantee', 'memoryPublicationGuarantee']);
  const publisher = firstAcross(records, ['publisher', 'publisherId', 'daemonId', 'hostId']);
  const ids = receiptIds(input.record, records, input.receiptIds ?? []);
  const receiptStatus = firstAcross(records, ['receiptStatus', 'receiptOutcome', 'operationStatus', 'status']);
  const receiptRoute = firstAcross(records, ['receiptRoute', 'inspectReceiptRoute', 'artifactRoute']);
  const receiptStreamStatus = firstAcross(records, ['receiptStreamStatus', 'receiptPublicationStatus', 'receiptsStatus', 'streamStatus']);
  const proof = provenance(input.record, records, input.sourcePath);
  return {
    schemaStatus,
    ...(schemaVersion ? { schemaVersion: redactedPreview(schemaVersion, 80) } : {}),
    ...(publicationGuarantee ? { publicationGuarantee: redactedPreview(publicationGuarantee, 220) } : {}),
    ...(publisher ? { publisher: redactedPreview(publisher, 80) } : {}),
    ...(proof.length > 0 ? { provenance: proof } : {}),
    ...(ids[0] ? { receiptId: ids[0] } : {}),
    ...(receiptStatus ? { receiptStatus: redactedPreview(receiptStatus, 80) } : {}),
    ...(receiptRoute ? { receiptRoute: redactedPreview(receiptRoute, 180) } : {}),
    ...(ids.length > 0 ? { receiptIds: ids } : {}),
    ...(receiptStreamStatus ? { receiptStreamStatus: redactedPreview(receiptStreamStatus, 80) } : {}),
    rawPublicationGuarantee: publicationGuarantee,
    rawPublisher: publisher,
    rawReceiptRoute: receiptRoute,
    rawReceiptStreamStatus: receiptStreamStatus,
    rawReceiptStatus: receiptStatus,
    rawSchemaVersion: schemaVersion,
    receiptIdsValue: ids,
    schemaStatusValue: schemaStatus,
  };
}

export function memoryExternalProviderLiveCertification(input: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly sourcePath: string;
  readonly providerId: string;
  readonly readContractPublished: boolean;
  readonly writeContractPublished: boolean;
  readonly syncContractPublished: boolean;
  readonly forgetContractPublished: boolean;
  readonly receiptIds: readonly string[];
  readonly receiptRoute: string | null;
}): MemoryExternalProviderCertification {
  const base = certifiedBase({ record: input.record, sourcePath: input.sourcePath, receiptIds: input.receiptIds });
  const {
    rawPublicationGuarantee,
    rawPublisher,
    rawReceiptRoute,
    rawReceiptStreamStatus,
    rawReceiptStatus,
    rawSchemaVersion,
    receiptIdsValue,
    schemaStatusValue,
    ...certification
  } = base;
  const receiptPublished = base.receiptIdsValue.length > 0 || Boolean(input.receiptRoute) || Boolean(base.rawReceiptRoute) || Boolean(base.rawReceiptStreamStatus);
  const missingSignals = [
    ...(schemaStatusValue === 'certified' ? [] : ['Certified external memory provider schema is not published.']),
    ...(input.providerId ? [] : ['Durable external memory provider id is not published.']),
    ...(rawPublicationGuarantee ? [] : ['Provider-side external memory publication guarantee is not published.']),
    ...(rawPublisher ? [] : ['Provider-side external memory publisher is not published.']),
    ...(certification.provenance?.length ? [] : ['Provider-side external memory provenance is not published.']),
    ...(input.readContractPublished ? [] : ['Bounded read/search contract is not published.']),
    ...(input.writeContractPublished ? [] : ['Confirmed write/upsert contract is not published.']),
    ...(input.syncContractPublished ? [] : ['Confirmed sync/import/export contract is not published.']),
    ...(input.forgetContractPublished ? [] : ['Forget/delete contract or explicit not-supported contract is not published.']),
    ...(receiptPublished ? [] : ['External memory provider receipt stream or receipt ids are not published.']),
  ];
  return {
    ...certification,
    ...(input.receiptRoute && !certification.receiptRoute ? { receiptRoute: redactedPreview(input.receiptRoute, 180) } : {}),
    missingSignals,
    policy: 'External memory provider records certify release readiness only when the host or SDK publishes schema, durable provider id, publication guarantee, publisher/provenance, bounded read, confirmed write/sync, forget or explicit not-supported, and receipt stream evidence without raw secrets or memory bodies.',
  };
}

export function memoryExternalProviderReceiptCertification(input: {
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly sourcePath: string;
  readonly providerId: string;
  readonly artifactId: string;
}): MemoryExternalProviderCertification {
  const base = certifiedBase({ record: input.metadata, sourcePath: input.sourcePath });
  const {
    rawPublicationGuarantee,
    rawPublisher,
    rawReceiptRoute,
    rawReceiptStreamStatus,
    rawReceiptStatus,
    rawSchemaVersion,
    receiptIdsValue,
    schemaStatusValue,
    ...certification
  } = base;
  const missingSignals = [
    ...(schemaStatusValue === 'certified' ? [] : ['Certified external memory receipt schema is not published.']),
    ...(input.providerId ? [] : ['Durable external memory provider id is not published.']),
    ...(input.artifactId || receiptIdsValue.length > 0 ? [] : ['Durable external memory receipt id is not published.']),
    ...(rawPublicationGuarantee ? [] : ['Provider-side external memory receipt publication guarantee is not published.']),
    ...(rawPublisher ? [] : ['Provider-side external memory receipt publisher is not published.']),
    ...(certification.provenance?.length ? [] : ['Provider-side external memory receipt provenance is not published.']),
    ...(receiptIdsValue.length > 0 ? [] : ['Confirmed external memory operation receipt id is not published.']),
  ];
  return {
    ...certification,
    ...(certification.receiptId ? {} : { receiptId: redactedPreview(input.artifactId, 96), receiptIds: [redactedPreview(input.artifactId, 96)] }),
    missingSignals,
    policy: 'External memory receipt artifacts certify release evidence only when they include schema, durable provider and receipt ids, publication guarantee, publisher/provenance, status, redaction posture, and inspectable follow-up route metadata.',
  };
}
