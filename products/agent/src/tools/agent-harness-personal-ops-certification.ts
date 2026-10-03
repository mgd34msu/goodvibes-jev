import { previewHarnessText } from './agent-harness-text.ts';
import { readRecord, readString } from './agent-harness-model-routing-utils.ts';
import { redactedPersonalOpsText } from './agent-harness-personal-ops-runner.ts';
import type { PersonalOpsRecordCertification } from './agent-harness-personal-ops-types.ts';

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
    readRecord(record.receipt),
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

function normalizeSchemaStatus(records: readonly Readonly<Record<string, unknown>>[]): PersonalOpsRecordCertification['schemaStatus'] {
  const explicit = firstAcross(records, ['schemaStatus', 'receiptSchemaStatus', 'certificationStatus'])
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
  if (['certified', 'valid', 'verified', 'schema-certified'].includes(explicit)) return 'certified';
  const schemaVersion = firstAcross(records, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion']);
  const publicationGuarantee = firstAcross(records, ['publicationGuarantee', 'hostPublicationGuarantee', 'providerPublicationGuarantee', 'personalOpsPublicationGuarantee']);
  const provenance = firstAcross(records, ['methodId', 'sourceTool', 'actionId', 'publisher', 'publisherId']);
  return schemaVersion && publicationGuarantee && provenance ? 'certified' : 'legacy';
}

function redactedPreview(value: string, limit = 180): string {
  return previewHarnessText(redactedPersonalOpsText(value), limit);
}

function receiptIds(record: Readonly<Record<string, unknown>>, records: readonly Readonly<Record<string, unknown>>[]): readonly string[] {
  const explicit = [
    ...readStringArray(record.receiptIds),
    ...readStringArray(record.effectReceiptIds),
    ...readStringArray(record.providerReceiptIds),
    firstAcross(records, ['receiptId', 'effectReceiptId', 'readReceiptId', 'syncReceiptId', 'operationReceiptId']),
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

export function personalOpsRecordCertification(input: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly sourcePath: string;
  readonly durableId: string;
  readonly recordKind: string;
  readonly hasConfirmedEffectRoute?: boolean;
  readonly requireReceipt?: boolean;
}): PersonalOpsRecordCertification {
  const records = recordsForCertification(input.record);
  const schemaStatus = normalizeSchemaStatus(records);
  const schemaVersion = firstAcross(records, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion']);
  const publicationGuarantee = firstAcross(records, ['publicationGuarantee', 'hostPublicationGuarantee', 'providerPublicationGuarantee', 'personalOpsPublicationGuarantee']);
  const publisher = firstAcross(records, ['publisher', 'publisherId', 'daemonId', 'hostId']);
  const ids = receiptIds(input.record, records);
  const primaryReceiptId = ids[0] ?? '';
  const receiptStatus = firstAcross(records, ['receiptStatus', 'receiptOutcome', 'operationStatus']);
  const receiptRoute = firstAcross(records, ['receiptRoute', 'inspectReceiptRoute', 'artifactRoute']);
  const proof = provenance(input.record, records, input.sourcePath);
  const missingSignals = [
    ...(schemaStatus === 'certified' ? [] : [`Certified ${input.recordKind} schema is not published.`]),
    ...(input.durableId ? [] : [`Durable ${input.recordKind} id is not published.`]),
    ...(publicationGuarantee ? [] : [`Provider-side ${input.recordKind} publication guarantee is not published.`]),
    ...(publisher ? [] : [`Provider-side ${input.recordKind} publisher is not published.`]),
    ...(input.hasConfirmedEffectRoute ? [] : [`Confirmed ${input.recordKind} follow-up route is not published.`]),
    ...(input.requireReceipt && ids.length === 0 ? [`Confirmed ${input.recordKind} execution receipt id is not published.`] : []),
  ];
  return {
    schemaStatus,
    ...(schemaVersion ? { schemaVersion: redactedPreview(schemaVersion, 80) } : {}),
    ...(publicationGuarantee ? { publicationGuarantee: redactedPreview(publicationGuarantee, 220) } : {}),
    ...(publisher ? { publisher: redactedPreview(publisher, 80) } : {}),
    ...(proof.length > 0 ? { provenance: proof } : {}),
    ...(primaryReceiptId ? { receiptId: primaryReceiptId } : {}),
    ...(receiptStatus ? { receiptStatus: redactedPreview(receiptStatus, 80) } : {}),
    ...(receiptRoute ? { receiptRoute: redactedPreview(receiptRoute, 180) } : {}),
    ...(ids.length > 0 ? { receiptIds: ids } : {}),
    missingSignals,
    policy: 'Personal Ops treats provider records and effect receipts as certified only when the host or SDK publishes schema, durable id, publication guarantee, publisher/provenance, and exact confirmed routes or receipt ids; otherwise the row stays visible but not release-certifying.',
  };
}
