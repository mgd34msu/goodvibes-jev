import type { KnowledgeIssueRecord, KnowledgeNodeRecord } from '../../types.js';
import { readRecord, stableHash } from '../helpers.js';
import type { HomeGraphQualityInput } from './types.js';
import { readHomeGraphDeclaredBoolean } from './projection.js';
export const HOME_GRAPH_QUALITY_FINGERPRINT_VERSION = 2;
export function homeGraphQualitySubjectFingerprint(node: KnowledgeNodeRecord, code: string, input: HomeGraphQualityInput): string {
  const question = code === 'homegraph.device.unknown_battery' ? 'batteryApplicable' : 'manualApplicable';
  const semantic = input.questions.includes(question) ? {
    subject: input.subject,
    entities: input.entities.map(({ reference: _reference, ...entity }) => JSON.stringify(entity)).sort(),
  } : undefined;
  const homeAssistant = readRecord(node.metadata.homeAssistant), attributes = readRecord(node.metadata.attributes);
  return stableHash(JSON.stringify({ code, kind: node.kind, title: node.title, semantic,
    manufacturer: node.metadata.manufacturer, model: node.metadata.model,
    objectKind: homeAssistant.objectKind, objectId: homeAssistant.objectId, entityId: homeAssistant.entityId,
    deviceId: homeAssistant.deviceId, integrationId: homeAssistant.integrationId, domain: homeAssistant.domain,
    deviceClass: attributes.device_class,
    ...(question === 'batteryApplicable' ? { batteryPowered: readHomeGraphDeclaredBoolean(node.metadata.batteryPowered), batteryType: node.metadata.batteryType }
      : { manualRequired: readHomeGraphDeclaredBoolean(node.metadata.manualRequired) }),
  }));
}
/** A hash-version upgrade supplies no evidence that an operator's reviewed subject changed. */
export function preserveLegacyQualityAuthority(issue: KnowledgeIssueRecord | undefined): boolean {
  // Legacy rows have no detached evidence snapshot. Their raw fingerprint cannot
  // distinguish meaning changes from equivalent declared-flag representation.
  // Automatic refresh therefore cannot prove that an old reviewed subject changed.
  return Boolean(issue && issue.metadata.qualityFingerprintVersion !== HOME_GRAPH_QUALITY_FINGERPRINT_VERSION
    && (issue.status === 'resolved' || typeof readRecord(issue.metadata.review).action === 'string'));
}
