import type { KnowledgeIssueRecord, KnowledgeIssueUpsertInput, KnowledgeNodeRecord } from '../types.js';
import type { KnowledgeStore } from '../store.js';
import { isLegacyHomeGraphQualityIssue, KnowledgeIssueReplacementHeldError } from '../store-issue-replacement.js';
import { buildIssue } from './helpers.js';
import { readHomeGraphState, sourcesLinkedToNode } from './state.js';
import { readHomeGraphQuality, HomeGraphQualityHeldError, HOME_GRAPH_QUALITY_LIMITS, type HomeGraphQualityQuestion, type HomeGraphQualityReading, type HomeGraphQualityInput } from './quality/reader.js';
import { HOME_GRAPH_QUALITY_FINGERPRINT_VERSION, homeGraphQualitySubjectFingerprint, preserveLegacyQualityAuthority } from './quality/fingerprint.js';
import { projectHomeGraphQualityInput, readHomeGraphDeclaredBoolean } from './quality/projection.js';

const QUALITY_NAMESPACE_PREFIX = 'homegraph';
export function homeGraphQualityNamespace(spaceId: string): string {
  return `${QUALITY_NAMESPACE_PREFIX}:${spaceId}:quality`;
}

export async function refreshHomeGraphQualityIssues(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  options: { readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined } = {},
): Promise<readonly KnowledgeIssueRecord[]> {
  return (await refreshHomeGraphQualityReport(store, spaceId, installationId, options)).issues;
}

export async function refreshHomeGraphQualityReport(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  options: { readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined } = {},
): Promise<{ readonly issues: readonly KnowledgeIssueRecord[]; readonly retainedLegacyIssues: number }> {
  await store.init();
  const state = structuredClone(readHomeGraphState(store, spaceId));
  // Capture the full read-set, including hidden/terminal issues, BEFORE readings.
  const allIssues = structuredClone(store.listIssuesInSpace(spaceId));
  const version = JSON.stringify({ state, issues: allIssues });
  const legacy = allIssues.filter((issue) => isLegacyHomeGraphQualityIssue(issue, spaceId));
  const guard = () => {
    if (options.signal?.aborted) throw new HomeGraphQualityHeldError('aborted');
    if (JSON.stringify({ state: readHomeGraphState(store, spaceId), issues: store.listIssuesInSpace(spaceId) }) !== version) {
      throw new HomeGraphQualityHeldError('stale');
    }
  };
  guard();
  const devices = state.nodes.filter((node) => node.kind === 'ha_device');
  if (devices.length > HOME_GRAPH_QUALITY_LIMITS.devices) throw new HomeGraphQualityHeldError('budget');
  const selected = devices.map((node, index) => {
    const battery = readNonEmptyString(node.metadata.batteryType) ? false : readHomeGraphDeclaredBoolean(node.metadata.batteryPowered);
    const manual = sourcesLinkedToNode(node.id, state).length > 0 ? false : readHomeGraphDeclaredBoolean(node.metadata.manualRequired);
    const questions: HomeGraphQualityQuestion[] = [];
    if (battery === undefined) questions.push('batteryApplicable');
    if (manual === undefined) questions.push('manualApplicable');
    const reference = `device-${index + 1}`;
    const input: HomeGraphQualityInput = questions.length
      ? projectHomeGraphQualityInput(reference, node, relatedEntities(node, state), [], questions)
      : { reference, subject: { kind: 'ha_device', title: 'Declared device' }, entities: [], facts: [], questions: [] };
    return { node, battery, manual, input };
  });
  const readings = await readHomeGraphQuality(selected.map(({ input }) => input), options);
  guard();
  const issues: KnowledgeIssueUpsertInput[] = [];
  for (const [index, { node, battery, manual, input }] of selected.entries()) {
    const reading = readings[index]!;
    if (manual ?? reading.answers.manualApplicable) issues.push(qualityIssue(spaceId, installationId,
      'homegraph.device.missing_manual', `${node.title} has no linked manual or source.`, node, reading, input));
    if (battery ?? reading.answers.batteryApplicable) issues.push(qualityIssue(spaceId, installationId,
      'homegraph.device.unknown_battery', `${node.title} has no known battery type.`, node, reading, input));
  }
  const previous = new Map(allIssues.map((issue) => [issue.id, issue]));
  const retainedLegacyIssues = allIssues.filter((issue) => (issue.metadata.namespace === homeGraphQualityNamespace(spaceId)
    || isLegacyHomeGraphQualityIssue(issue, spaceId)) && preserveLegacyQualityAuthority(issue)).length;
  let written: readonly KnowledgeIssueRecord[];
  try { written = await store.replaceIssuesGuarded(issues.filter((issue) => !preserveLegacyQualityAuthority(previous.get(issue.id!))
      && !isSuppressedGeneratedIssue(previous.get(issue.id!) ?? null, issue)),
    homeGraphQualityNamespace(spaceId), guard, legacy); }
  catch (error) { if (error instanceof KnowledgeIssueReplacementHeldError) throw new HomeGraphQualityHeldError(error.reason); throw error; }
  return { issues: written, retainedLegacyIssues };
}

function qualityIssue(
  spaceId: string,
  installationId: string,
  code: string,
  message: string,
  node: KnowledgeNodeRecord,
  reading: HomeGraphQualityReading,
  input: HomeGraphQualityInput,
): KnowledgeIssueUpsertInput {
  const issue = buildIssue(spaceId, installationId, code, message, { nodeId: node.id });
  const question = code === 'homegraph.device.unknown_battery' ? 'batteryApplicable' : 'manualApplicable';
  return {
    ...issue,
    metadata: {
      ...(issue.metadata ?? {}),
      namespace: homeGraphQualityNamespace(spaceId),
      generated: true,
      subjectFingerprint: homeGraphQualitySubjectFingerprint(node, code, input),
      qualityFingerprintVersion: HOME_GRAPH_QUALITY_FINGERPRINT_VERSION,
      qualityReading: input.questions.includes(question)
        ? { origin: 'automatic-judgment', question, answer: reading.answers[question], ...reading.provenance[question] }
        : { origin: 'declared-fields' },
    },
  };
}

function isSuppressedGeneratedIssue(
  existing: KnowledgeIssueRecord | null,
  input: KnowledgeIssueUpsertInput,
): boolean {
  if (!existing || existing.status !== 'resolved') return false;
  const existingFingerprint = typeof existing.metadata.subjectFingerprint === 'string'
    ? existing.metadata.subjectFingerprint
    : undefined;
  const inputFingerprint = typeof input.metadata?.subjectFingerprint === 'string'
    ? input.metadata.subjectFingerprint
    : undefined;
  return existingFingerprint === inputFingerprint;
}


function relatedEntities(
  node: KnowledgeNodeRecord,
  state: ReturnType<typeof readHomeGraphState>,
): KnowledgeNodeRecord[] {
  const byId = new Map(state.nodes.map((entry) => [entry.id, entry]));
  return state.edges
    .filter((edge) => edge.fromKind === 'node' && edge.toKind === 'node' && edge.toId === node.id && edge.relation === 'belongs_to_device')
    .flatMap((edge) => {
      const entry = byId.get(edge.fromId);
      return entry?.kind === 'ha_entity' ? [entry] : [];
    });
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
