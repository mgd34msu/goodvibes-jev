import type { JsonValue } from '@goodvibes-jev/judgment';
import type { KnowledgeIssueRecord, KnowledgeNodeRecord } from '../../types.js';
import { hasKnowledgeNodeOperatorReview } from '../../store-node-authority.js';
import { readRecord, stableHash } from '../helpers.js';
import { homeGraphTriageApplicability, homeGraphBatteryFacts, homeGraphManualFact } from './batteries.js';
import { HomeGraphTriageHeldError as Held, type TriageReadInput } from './types.js';

export function hasTriageOperatorReview(issue: KnowledgeIssueRecord, node?: KnowledgeNodeRecord): boolean {
  const review = readRecord(issue.metadata.review);
  return typeof review.action === 'string' || Boolean(node && hasKnowledgeNodeOperatorReview(node));
}
/** Raw database IDs stay local. HA semantic identities remain untrusted values. */
export function projectTriageInput(reference: string, issue: KnowledgeIssueRecord, node: KnowledgeNodeRecord | undefined, ruleGuidance?: string): TriageReadInput {
  const subject: Record<string, JsonValue> = {};
  if (node) {
    Object.assign(subject, { kind: node.kind, title: node.title, aliases: [...node.aliases] });
    if (node.summary !== undefined) subject.summary = node.summary;
    for (const key of ['manufacturer', 'model']) copyString(subject, node.metadata, key);
    const identity: Record<string, JsonValue> = {};
    const ha = readRecord(node.metadata.homeAssistant);
    for (const key of ['objectKind', 'objectId', 'entityId', 'deviceId', 'integrationId']) copyString(identity, ha, key);
    if (Object.keys(identity).length) subject.homeAssistant = identity;
    // Only facts relevant to this issue enter its semantic input/cache. A battery
    // update must not silently invalidate an unrelated manual recommendation.
    const keys = issue.code === 'homegraph.device.unknown_battery' ? ['batteryPowered', 'batteryType']
      : issue.code === 'homegraph.device.missing_manual' ? ['manualRequired'] : [];
    for (const key of keys) {
      const value = node.metadata[key];
      if (value === undefined) continue;
      if (key === 'batteryType') {
        if (typeof value !== 'string') throw new Held('malformed');
        subject[key] = value;
      } else subject[key] = declaredBoolean(value);
    }
  }
  return { reference, issue: { code: issue.code, message: issue.message, severity: issue.severity },
    ...(node ? { subject } : {}), ...(ruleGuidance !== undefined ? { ruleGuidance } : {}) };
}
/** Exact spellings of the existing declared flag schema, never prose classification. */
function declaredBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const label = value.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(label)) return true;
    if (['false', 'no', '0', 'none', 'not_applicable', 'not applicable'].includes(label)) return false;
  }
  throw new Held('malformed');
}
function copyString(target: Record<string, JsonValue>, record: Record<string, unknown>, key: string): void {
  if (record[key] === undefined || record[key] === null) return;
  if (typeof record[key] !== 'string') throw new Held('malformed');
  target[key] = record[key];
}
export function triageCacheFingerprint(input: TriageReadInput, issue: KnowledgeIssueRecord, node: KnowledgeNodeRecord | undefined, policy: { model: string; minConfidence: number; category?: string | undefined }): string {
  return stableHash(JSON.stringify({
    issue: input.issue, subject: input.subject, guidance: input.ruleGuidance, policy,
    issueId: issue.id, nodeId: issue.nodeId, sourceId: issue.sourceId,
    lifecycle: issue.metadata.issueLifecycle, issueReview: issue.metadata.review,
    nodeReview: node?.metadata.review,
    batteries: [homeGraphTriageApplicability, homeGraphBatteryFacts, homeGraphManualFact].map(({ name, version }) => ({ name, version })),
  }));
}
