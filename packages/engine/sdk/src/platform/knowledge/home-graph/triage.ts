import { judgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { JudgmentInputError } from '../../gate/judgment-input.js';
import type { KnowledgeIssueRecord } from '../types.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeSemanticService } from '../semantic/index.js';
import { readRecord } from './helpers.js';
import { readHomeGraphState } from './state.js';
import { resolveReadableHomeGraphSpace } from './space-selection.js';
import type { HomeGraphSpaceInput } from './types.js';
import { prepareHomeGraphTriageReadings, HomeGraphTriageHeldError as Held, TRIAGE_READING_LIMITS } from './triage/reader.js';
import { hasTriageOperatorReview, projectTriageInput, triageCacheFingerprint } from './triage/projection.js';
import { applyTriageReadings } from './triage/application.js';

/** Owner floor; settled registered readings remain mandatory regardless of this setting. */
export const HOME_GRAPH_TRIAGE_DEFAULT_MIN_CONFIDENCE = 85;
export const HOME_GRAPH_TRIAGE_DEFAULT_CHUNK_SIZE = 25;
export const HOME_GRAPH_TRIAGE_DEFAULT_LIMIT = 25;
const TRIAGE_ISSUE_SCAN_LIMIT = 1_000;
export interface HomeGraphTriageRule {
  readonly code: string;
  readonly promptGuidance?: string | undefined;
  readonly defaultCategory?: string | undefined;
}
/** Issue purposes, not device-name/category classification heuristics. */
export const DEFAULT_HOME_GRAPH_TRIAGE_RULES: readonly HomeGraphTriageRule[] = [
  { code: 'homegraph.device.unknown_battery', defaultCategory: 'not_applicable',
    promptGuidance: 'Establish whether battery tracking applies to this exact subject. Unknown battery type is not evidence of no battery. Any automatic battery facts require separate support readings.' },
  { code: 'homegraph.device.missing_manual', defaultCategory: 'not_applicable',
    promptGuidance: 'Establish whether this exact subject needs an applicable manual. An unfound manual is not evidence that none is required. Any automatic manual fact requires a separate support reading.' },
];
export interface HomeGraphTriageOptions {
  /** Owner rejection floor on a probability × 100 scale. Cannot weaken the registered band. */
  readonly minConfidence?: number | undefined;
  /** Max untriaged open issues to examine this run. Default 25. */
  readonly limit?: number | undefined;
  /** Legacy batching hint retained for compatibility; judgment concurrency is bounded internally. */
  readonly chunkSize?: number | undefined;
  /** Re-triage even issues whose cached fingerprint is unchanged. */
  readonly force?: boolean | undefined;
  /** Issue ids to leave untouched this run. */
  readonly skipIssueIds?: readonly string[] | undefined;
  /** Restrict triage to this subset of issue codes (must still have a rule). */
  readonly issueCodes?: readonly string[] | undefined;
  /** Extra rules merged over the built-ins (by code), the extensibility hook. */
  readonly additionalRules?: readonly HomeGraphTriageRule[] | undefined;
  /** Whole reading-pass timeout in ms, at most 60 seconds. */
  readonly timeoutMs?: number | undefined;
  /** Legacy display label. Automatic triage never creates an operator review. */
  readonly reviewer?: string | undefined;
}

export interface HomeGraphTriageDecision {
  readonly issueId: string;
  readonly code: string;
  readonly action: 'reject' | 'review';
  readonly category?: string | undefined;
  readonly confidence: number;
  readonly reason?: string | undefined;
  /** True when the decision cleared the threshold and was auto-applied. */
  readonly applied: boolean;
  /** Facts written to the device node when applied. */
  readonly appliedFacts?: Record<string, unknown> | undefined;
  /** Provenance tag, always `homegraph-triage`. */
  readonly source: string;
}

export interface HomeGraphTriageResult {
  readonly ok: true;
  readonly spaceId: string;
  /** False when no judgment port is configured, the loop is a no-op. */
  readonly configured: boolean;
  readonly processed: number;
  /** Open triageable issues skipped because their cached fingerprint was unchanged. */
  readonly skipped: number;
  readonly applied: number;
  readonly reviewed: number;
  readonly decisions: readonly HomeGraphTriageDecision[];
  /** Open triageable issues still unresolved after this run. */
  readonly remaining: number;
  readonly minConfidence: number;
  readonly reason?: string | undefined;
}

/** Read applicability and exact proposed facts before ordinary automatic writes. */
export async function runHomeGraphIssueTriage(input: HomeGraphSpaceInput & {
  readonly store: KnowledgeStore;
  /** Content generation is intentionally independent of these typed judgments. */
  readonly semanticService?: KnowledgeSemanticService | undefined;
  readonly options?: HomeGraphTriageOptions | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<HomeGraphTriageResult> {
  await input.store.init();
  const { spaceId } = resolveReadableHomeGraphSpace(input.store, input);
  const options = input.options ?? {};
  const requestedMinimum = options.minConfidence ?? HOME_GRAPH_TRIAGE_DEFAULT_MIN_CONFIDENCE;
  if (!Number.isFinite(requestedMinimum)) throw new Held('malformed');
  const minConfidence = Math.max(85, Math.min(100, requestedMinimum));
  const rules = new Map(DEFAULT_HOME_GRAPH_TRIAGE_RULES.map((rule) => [rule.code, rule]));
  for (const rule of options.additionalRules ?? []) {
    if (typeof rule.code !== 'string' || !rule.code.trim()
      || (rule.promptGuidance !== undefined && typeof rule.promptGuidance !== 'string')
      || (rule.defaultCategory !== undefined && typeof rule.defaultCategory !== 'string')) throw new Held('malformed');
    rules.set(rule.code, { ...rule });
  }
  const codes = options.issueCodes ? new Set(options.issueCodes) : undefined;
  const state = readHomeGraphState(input.store, spaceId);
  const nodeById = new Map(state.nodes.map((node) => [node.id, node]));
  const triageable = (issue: KnowledgeIssueRecord) => issue.status === 'open' && rules.has(issue.code) && (!codes || codes.has(issue.code));
  const open = state.issues.filter(triageable);
  const empty = (configured: boolean, reason: string, skipped = 0): HomeGraphTriageResult => ({ ok: true, spaceId, configured,
    processed: 0, skipped, applied: 0, reviewed: 0, decisions: [], remaining: open.length, minConfidence, reason });
  let model: string;
  try { model = judgmentPort('engine.knowledge.homegraph-triage').model; }
  catch (error) { if (error instanceof JudgmentPortMissingError) return empty(false, 'triage-judgment-not-configured'); throw error; }
  const limit = options.limit ?? HOME_GRAPH_TRIAGE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > TRIAGE_READING_LIMITS.inputs) throw new Held('budget');
  if (input.signal?.aborted) return empty(true, 'triage-held-aborted');
  const skipIds = new Set(options.skipIssueIds ?? []);
  let skipped = 0;
  const selected: Array<{ issue: KnowledgeIssueRecord; input: ReturnType<typeof projectTriageInput>; fingerprint: string }> = [];
  try {
    for (const issue of open.slice(0, TRIAGE_ISSUE_SCAN_LIMIT)) {
      if (selected.length >= limit) break;
      if (skipIds.has(issue.id)) continue;
      const node = issue.nodeId ? nodeById.get(issue.nodeId) : undefined;
      // Explicit review remains authoritative even with force=true.
      if (hasTriageOperatorReview(issue, node)) { skipped++; continue; }
      const rule = rules.get(issue.code)!;
      const projected = projectTriageInput(`issue-${selected.length + 1}`, issue, node, rule.promptGuidance);
      const fingerprint = triageCacheFingerprint(projected, issue, node, { model, minConfidence, category: rule.defaultCategory });
      const cached = readRecord(issue.metadata.triage);
      if (!options.force && cached.origin === 'automatic-judgment' && cached.model === model
        && cached.requestedModel === model && cached.fingerprint === fingerprint) { skipped++; continue; }
      if (selected.length < limit) selected.push({ issue: structuredClone(issue), input: projected, fingerprint });
    }
    if (!selected.length) return empty(true, skipped ? 'no-untriaged-open-issues' : 'no-open-issues', skipped);
    const plans = await prepareHomeGraphTriageReadings(selected.map((entry) => entry.input), {
      signal: input.signal, timeoutMs: options.timeoutMs, minConfidence,
    });
    const applications = selected.map(({ issue, fingerprint }, index) => ({ issue, fingerprint, plan: plans[index]!,
      node: issue.nodeId ? nodeById.get(issue.nodeId) : undefined, category: rules.get(issue.code)?.defaultCategory }));
    await applyTriageReadings(input.store, applications, input.signal);
    const decisions: HomeGraphTriageDecision[] = applications.map(({ issue, plan, category }) => ({
      issueId: issue.id, code: issue.code, action: plan.action, category, confidence: plan.probability * 100,
      applied: plan.action === 'reject', ...(Object.keys(plan.facts).length ? { appliedFacts: { ...plan.facts } } : {}),
      source: 'homegraph-triage',
    }));
    const applied = decisions.filter((decision) => decision.applied).length;
    return { ok: true, spaceId, configured: true, processed: selected.length, skipped, applied,
      reviewed: decisions.length - applied, decisions,
      remaining: readHomeGraphState(input.store, spaceId).issues.filter(triageable).length, minConfidence };
  } catch (error) {
    if (error instanceof JudgmentInputError) return empty(true, 'triage-held-protected-input', skipped);
    if (error instanceof Held) return empty(error.reason !== 'unconfigured', `triage-held-${error.reason}`, skipped);
    throw error;
  }
}
