import type { KnowledgeStore } from '../../store.js';
import type { KnowledgeIssueRecord, KnowledgeNodeRecord, KnowledgeNodeUpsertInput, KnowledgeIssueUpsertInput } from '../../types.js';
import { KnowledgeNodeMutationHeldError } from '../../store-node-authority.js';
import { HomeGraphTriageHeldError as Held, type TriageReadingPlan } from './types.js';
import { hasTriageOperatorReview } from './projection.js';
export interface TriageApplication {
  readonly issue: KnowledgeIssueRecord;
  readonly node?: KnowledgeNodeRecord | undefined;
  readonly plan: TriageReadingPlan;
  readonly fingerprint: string;
  readonly category?: string | undefined;
}
/** Ordinary producer writes only. Automatic recommendations never mint review authority. */
export async function applyTriageReadings(store: KnowledgeStore, applications: readonly TriageApplication[], signal?: AbortSignal): Promise<void> {
  const issues = new Map(applications.map(({ issue }) => [issue.id, JSON.stringify(issue)]));
  const nodes = new Map(applications.flatMap(({ node }) => node ? [[node.id, JSON.stringify(node)] as const] : []));
  const guard = () => {
    if (signal?.aborted) throw new Held('aborted');
    for (const [id, snapshot] of issues) if (JSON.stringify(store.getIssue(id)) !== snapshot) throw new Held('stale');
    for (const [id, snapshot] of nodes) if (JSON.stringify(store.getNode(id)) !== snapshot) throw new Held('stale');
    for (const { issue, node } of applications) if (hasTriageOperatorReview(issue, node)) throw new Held('operator-reviewed');
  };
  guard();
  const nodeInputs = new Map<string, KnowledgeNodeUpsertInput>();
  for (const { issue, node, plan } of applications) {
    if (issue.status !== 'open') throw new Held('stale');
    if (!Object.keys(plan.facts).length) continue;
    if (!node || issue.nodeId !== node.id) throw new Held('stale');
    const prior = nodeInputs.get(node.id);
    nodeInputs.set(node.id, { id: node.id, kind: node.kind, slug: node.slug, title: node.title,
      summary: node.summary, aliases: node.aliases, status: node.status, confidence: node.confidence,
      sourceId: node.sourceId, metadata: { ...prior?.metadata, ...plan.facts,
        automaticTriage: { origin: 'automatic-judgment', source: 'homegraph-triage', model: plan.model,
          decisions: applications.filter((entry) => entry.node?.id === node.id).map((entry) => ({ issueId: entry.issue.id, decisionIds: entry.plan.decisionIds, batteries: entry.plan.batteries })) },
      } });
  }
  const issueInputs: KnowledgeIssueUpsertInput[] = [];
  for (const { issue, plan, fingerprint, category } of applications) {
    issueInputs.push({ id: issue.id, severity: issue.severity, code: issue.code,
      message: issue.message, status: plan.action === 'reject' ? 'resolved' : 'open',
      sourceId: issue.sourceId, nodeId: issue.nodeId,
      metadata: { ...issue.metadata, triage: { fingerprint, action: plan.action, category,
        confidence: plan.probability * 100, probability: plan.probability, applied: plan.action === 'reject',
        origin: plan.origin, source: 'homegraph-triage', model: plan.model, requestedModel: plan.requestedModel,
        decisionIds: plan.decisionIds, batteries: plan.batteries, decidedAt: Date.now() },
        ...(plan.action === 'reject' ? { resolution: { origin: 'automatic-judgment', source: 'homegraph-triage', decisionIds: plan.decisionIds } } : {}),
      } });
  }
  // Normalization, the final frozen-state/cancellation guard, all SQL writes and
  // cache updates share one synchronous commit point. No earlier plan can be
  // persisted if a later issue is held or cancellation arrived before commit.
  try { await store.applyGuardedNodeIssueWrites({ nodes: [...nodeInputs.values()], issues: issueInputs }, guard); }
  catch (error) { if (error instanceof KnowledgeNodeMutationHeldError) throw new Held('operator-reviewed'); throw error; }
}
