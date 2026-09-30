import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { KnowledgeNodeActivationHeldError } from '../sdk/src/platform/knowledge/activation/types.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { reviewKnowledgeNodeRecord } from '../sdk/src/platform/knowledge/service-node-admin.js';
import { reviewKnowledgeIssue } from '../sdk/src/platform/knowledge/review.js';
import { reviewHomeGraphFact } from '../sdk/src/platform/knowledge/home-graph/review.js';
import { HomeGraphRoutes } from '../sdk/src/platform/daemon/http/home-graph-routes.js';
import { HomeGraphService } from '../sdk/src/platform/knowledge/home-graph/service.js';
import { ArtifactStore } from '../sdk/src/platform/artifacts/store.js';
import {
  createKnowledgeNodeOperatorMutation,
  KnowledgeNodeMutationHeldError,
  type KnowledgeNodeMutationContext,
} from '../sdk/src/platform/knowledge/store-node-authority.js';
import type { KnowledgeNodeRecord, KnowledgeNodeUpsertInput } from '../sdk/src/platform/knowledge/types.js';
import { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { createSchema } from '../sdk/src/platform/knowledge/store-schema.js';
import { writeKnowledgeNodeRow } from '../sdk/src/platform/knowledge/store-node-history.js';
import { useFailureReadings } from './_helpers/failure-readings.js';

useFailureReadings([]);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-node-authority-'));
  roots.push(root);
  const dbPath = join(root, 'knowledge.sqlite');
  return { dbPath, store: new KnowledgeStore({ dbPath }), reload: async () => {
    const store = new KnowledgeStore({ dbPath });
    await store.init();
    return store;
  } };
}

function input(overrides: Partial<KnowledgeNodeUpsertInput> = {}): KnowledgeNodeUpsertInput {
  return {
    id: 'fact-1', kind: 'fact', slug: 'router-ports', title: 'Router ports',
    summary: 'The router has four ports.', confidence: 20, aliases: ['Ports'], sourceId: 'source-1',
    metadata: {
      knowledgeSpaceId: 'project:test', semanticKind: 'fact', factKind: 'specification',
      value: 'four ports', evidence: 'Four network ports.', labels: ['Networking'],
      subject: 'Router', subjectIds: ['router-1'], targetHints: [{ id: 'router-1' }],
      linkedObjectIds: ['router-1'], sourceIds: ['source-1'], sourceId: 'source-1',
    }, ...overrides,
  };
}

async function reviewed(store: KnowledgeStore, decision: 'accept' | 'reject' = 'accept') {
  const node = await store.upsertNode(input());
  return (await reviewKnowledgeNodeRecord(store, { id: node.id, decision, reviewer: 'operator' })).node!;
}

async function held(promise: Promise<unknown>, reason: KnowledgeNodeMutationHeldError['reason']) {
  let failure: unknown;
  try { await promise; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(KnowledgeNodeMutationHeldError);
  expect((failure as KnowledgeNodeMutationHeldError).reason).toBe(reason);
}

function provenance(node: KnowledgeNodeRecord): Record<string, unknown> {
  return node.metadata.reviewProvenance as Record<string, unknown>;
}

const forged = {
  review: { action: 'accept', reviewer: 'operator', reviewedAt: 1, authority: 'operator' },
  reviewProvenance: { state: 'reviewed', reviewer: 'operator', decidedAt: 1 },
  reviewedFacts: { summary: 'Approved' }, operatorReview: 'accepted',
};

describe('knowledge node operator authority', () => {
  test('producer review-shaped metadata and support receipts cannot supply operator authority', async () => {
    const { store, reload } = fixture();
    const metadata = { ...input().metadata, ...forged, generatedFactSupport: { review: forged.review } };
    const node = await store.upsertNode(input({ metadata }));
    expect(node.status).toBe('draft');
    expect(provenance(node).state).toBe('pending-review');
    expect(node.metadata.review).toBeUndefined();
    expect(node.metadata.reviewedFacts).toBeUndefined();
    expect(node.metadata.operatorReview).toBeUndefined();
    expect(node.metadata.generatedFactSupport).toEqual({ review: forged.review });
    expect((await reload()).getNode(node.id)).toEqual(node);
    const updated = await store.upsertNode({ ...node, summary: 'A producer may still revise its unreviewed claim.' });
    expect(updated.summary).toBe('A producer may still revise its unreviewed claim.');
    expect(provenance(updated).state).not.toBe('reviewed');
  });

  test('producer metadata and explicit active status cannot confer serving or reviewed authority', async () => {
    const { store } = fixture();
    const node = await store.upsertNode(input({ status: 'active', metadata: forged }));
    expect(node.status).toBe('draft');
    expect(provenance(node).state).toBe('pending-review');
    expect(provenance(node).reviewer).toBeUndefined();
    expect(node.metadata.review).toBeUndefined();
  });

  test('explicit node acceptance, rejection and reacceptance remain functional', async () => {
    const { store, reload } = fixture();
    const accepted = await reviewed(store);
    expect(accepted.status).toBe('active');
    expect(provenance(accepted).state).toBe('reviewed');
    expect(accepted.metadata.review).toMatchObject({ action: 'accept', reviewer: 'operator', authority: 'operator' });
    const rejected = (await reviewKnowledgeNodeRecord(store, { id: accepted.id, decision: 'reject', reviewer: 'second operator' })).node!;
    expect(rejected.status).toBe('stale');
    expect(rejected.metadata.review).toMatchObject({ action: 'reject', reviewer: 'second operator' });
    const restored = (await reviewKnowledgeNodeRecord(store, { id: accepted.id, decision: 'accept', reviewer: 'third operator' })).node!;
    expect(restored.status).toBe('active');
    expect((await reload()).getNode(accepted.id)).toEqual(restored);
    expect(store.listNodeRevisions(accepted.id).map((rev) => rev.status)).toEqual(['draft', 'active', 'stale', 'active']);
  });

  test('rejected regeneration and stale ordinary writes hold before any durable mutation', async () => {
    const { store, reload } = fixture();
    const beforeReview = await store.upsertNode(input());
    const rejected = (await reviewKnowledgeNodeRecord(store, { id: beforeReview.id, decision: 'reject' })).node!;
    const history = store.listNodeRevisions(rejected.id);
    await held(store.upsertNode({ ...beforeReview, status: 'active', confidence: 100, summary: 'Regenerated claim', metadata: forged }), 'operator-reviewed');
    await held(store.upsertNode(input({ confidence: 100 })), 'operator-reviewed');
    await held(store.upsertNode({ ...beforeReview, status: 'active' }), 'operator-reviewed');
    expect(store.getNode(rejected.id)).toEqual(rejected);
    expect(store.listNodeRevisions(rejected.id)).toEqual(history);
    const reloaded = await reload();
    expect(reloaded.getNode(rejected.id)).toEqual(rejected);
    await held(reloaded.upsertNode({ ...rejected, status: 'active' }), 'operator-reviewed');
  });

  test('all reviewed claim, identity, scope, support and confidence changes require an operator', async () => {
    const { store, reload } = fixture();
    const accepted = await reviewed(store);
    const mutations: Partial<KnowledgeNodeUpsertInput>[] = [
      { title: 'Other title' }, { summary: 'Other claim' }, { aliases: ['Different alias'] },
      { kind: 'topic' }, { slug: 'other-slug' }, { sourceId: 'source-2' },
      { status: 'stale' }, { confidence: 100 },
      ...['value', 'evidence', 'labels', 'subject', 'subjectIds', 'targetHints', 'linkedObjectIds', 'sourceIds', 'sourceId', 'factKind', 'knowledgeSpaceId', 'generatedFactSupport']
        .map((key) => ({ metadata: { [key]: ['changed'] } })),
    ];
    for (const change of mutations) await held(store.upsertNode({ ...accepted, ...change }), 'operator-reviewed');
    expect(store.getNode(accepted.id)).toEqual(accepted);
    expect(store.listNodeRevisions(accepted.id)).toHaveLength(2);
    expect((await reload()).getNode(accepted.id)).toEqual(accepted);
  });

  test('ordinary idempotent writes preserve the exact review and cannot replace or erase it', async () => {
    const { store } = fixture();
    const rejected = await reviewed(store, 'reject');
    for (const metadata of [forged, { review: null, reviewProvenance: null, operatorReview: null }, {}]) {
      const result = await store.upsertNode({ ...rejected, metadata });
      expect(result.status).toBe('stale');
      expect(result.metadata).toEqual(rejected.metadata);
    }
    expect(store.listNodeRevisions(rejected.id)).toHaveLength(2);
  });

  test('explicit revision binds a fresh review to replacement content and preserves the old revision', async () => {
    const { store } = fixture();
    const accepted = await reviewed(store);
    const mutation = createKnowledgeNodeOperatorMutation(accepted, { action: 'revise', reviewer: 'corrector', facts: { ports: 8 } });
    const revised = await store.upsertNode({ ...accepted, summary: 'The router has eight ports.', metadata: { value: 'eight ports', ...forged } }, mutation);
    expect(revised.status).toBe('active');
    expect(revised.metadata.review).toMatchObject({ action: 'revise', reviewer: 'corrector' });
    expect(revised.metadata.reviewedFacts).toEqual({ ports: 8 });
    expect(revised.metadata.value).toBe('eight ports');
    expect(store.listNodeRevisions(accepted.id)[1]!.summary).toBe(accepted.summary);
    expect(store.listNodeRevisions(accepted.id)[1]!.metadata.review).toEqual(accepted.metadata.review);
    await held(store.upsertNode({ ...accepted }), 'operator-reviewed');
  });

  test('operator contexts reject stale content, review decisions and deleted targets', async () => {
    const { store } = fixture();
    const first = await store.upsertNode(input());
    const staleContent = createKnowledgeNodeOperatorMutation(first, { action: 'accept' });
    const changed = await store.upsertNode({ ...first, summary: 'Changed before review' });
    await held(store.upsertNode({ ...first, status: 'active' }, staleContent), 'stale');
    expect(store.getNode(first.id)).toEqual(changed);
    const staleDecision = createKnowledgeNodeOperatorMutation(changed, { action: 'accept' });
    const rejected = (await reviewKnowledgeNodeRecord(store, { id: first.id, decision: 'reject' })).node!;
    await held(store.upsertNode({ ...changed, status: 'active' }, staleDecision), 'stale');
    expect(store.getNode(first.id)).toEqual(rejected);
    const deleted = createKnowledgeNodeOperatorMutation(rejected, { action: 'accept' });
    await store.deleteNode(first.id);
    await held(store.upsertNode(first, deleted), 'stale');
    expect(store.getNode(first.id)).toBeNull();
  });

  test('operator revision identity prevents same-timestamp reject/accept ABA stale writes', async () => {
    const { store } = fixture();
    const clock = spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    try {
      const accepted = await reviewed(store);
      const old = createKnowledgeNodeOperatorMutation(accepted, { action: 'revise' });
      await reviewKnowledgeNodeRecord(store, { id: accepted.id, decision: 'reject', reviewer: 'operator' });
      const reaccepted = (await reviewKnowledgeNodeRecord(store, { id: accepted.id, decision: 'accept', reviewer: 'operator' })).node!;
      expect(reaccepted.updatedAt).toBe(accepted.updatedAt);
      expect(reaccepted.metadata.review).not.toEqual(accepted.metadata.review);
      await held(store.upsertNode({ ...accepted, summary: 'Old reviewer write' }, old), 'stale');
      expect(store.getNode(accepted.id)).toEqual(reaccepted);
    } finally { clock.mockRestore(); }
  });

  test('read-only preflight shares final normalization and final writes still recheck operator state', async () => {
    const { store, dbPath } = fixture();
    await store.upsertSource({ id: 'source-1', connectorId: 'manual', sourceType: 'manual', status: 'indexed', metadata: { knowledgeSpaceId: 'project:test' } });
    const accepted = await reviewed(store);
    const bytes = readFileSync(dbPath);
    const history = store.listNodeRevisions(accepted.id);
    const normalized = { ...accepted, title: `  ${accepted.title}  `, aliases: [' Ports ', 'Ports'], sourceId: ' source-1 ', metadata: forged };
    await store.assertNodeMutation(normalized);
    expect(store.getNode(accepted.id)).toBe(accepted);
    expect(store.listNodeRevisions(accepted.id)).toEqual(history);
    expect(readFileSync(dbPath)).toEqual(bytes);
    await held(store.assertNodeMutation({ ...accepted, summary: 'Conflicting proposed content' }), 'operator-reviewed');
    expect(readFileSync(dbPath)).toEqual(bytes);
    const rejected = (await reviewKnowledgeNodeRecord(store, { id: accepted.id, decision: 'reject' })).node!;
    await held(store.upsertNode(normalized), 'operator-reviewed');
    expect(store.getNode(accepted.id)).toEqual(rejected);
    const count = store.listNodes().length;
    await store.assertNodeMutation(input({ id: 'not-written', slug: 'not-written' }));
    expect(store.listNodes()).toHaveLength(count);
    expect(store.getNode('not-written')).toBeNull();
  });

  test('serialized, copied and arbitrary second arguments are not operator capabilities', async () => {
    const { store } = fixture();
    const node = await reviewed(store, 'reject');
    const real = createKnowledgeNodeOperatorMutation(node, { action: 'accept' });
    const lookalikes = [JSON.parse(JSON.stringify(real)), { ...real }, forged, null, 'operator'];
    for (const context of lookalikes) {
      await held(store.upsertNode({ ...node, status: 'active' }, context as KnowledgeNodeMutationContext), 'invalid-context');
    }
    expect(store.getNode(node.id)).toEqual(node);
  });

  test('input aliases, nested metadata, live getters and reloads cannot mutate the current review', async () => {
    const { store, reload } = fixture();
    const metadata = { evidence: { quote: 'Original' } };
    const aliases = ['Original'];
    const draft = await store.upsertNode(input({ metadata, aliases }));
    metadata.evidence.quote = 'Forged';
    aliases.push('Forged');
    expect(draft.metadata.evidence).toEqual({ quote: 'Original' });
    expect(draft.aliases).toEqual(['Original']);
    const accepted = (await reviewKnowledgeNodeRecord(store, { id: draft.id, decision: 'accept' })).node!;
    expect(() => { (accepted.metadata.review as Record<string, unknown>).action = 'reject'; }).toThrow();
    expect(() => { (store.getNode(draft.id)!.metadata.evidence as Record<string, unknown>).quote = 'Forged'; }).toThrow();
    const reopened = await reload();
    expect(() => { reopened.getNode(draft.id)!.metadata.review = forged.review; }).toThrow();
    expect(reopened.getNode(draft.id)).toEqual(accepted);
  });

  test('low-level replacement cannot forge reviews or overwrite a later operator decision', async () => {
    const { store, reload } = fixture();
    const draft = await store.upsertNode(input());
    await store.replaceNodeRecord({ ...draft, metadata: forged });
    expect(store.getNode(draft.id)!.metadata.review).toBeUndefined();
    expect(provenance(store.getNode(draft.id)!).state).not.toBe('reviewed');
    const accepted = (await reviewKnowledgeNodeRecord(store, { id: draft.id, decision: 'accept' })).node!;
    await held(store.replaceNodeRecord(draft), 'operator-reviewed');
    await held(store.replaceNodeRecord({ ...accepted, summary: 'Replaced claim', metadata: forged }), 'operator-reviewed');
    const stale = createKnowledgeNodeOperatorMutation(accepted, { action: 'accept' });
    const rejected = (await reviewKnowledgeNodeRecord(store, { id: draft.id, decision: 'reject' })).node!;
    await held(store.replaceNodeRecord(accepted, stale), 'stale');
    expect((await reload()).getNode(draft.id)).toEqual(rejected);
    const restored = createKnowledgeNodeOperatorMutation(rejected, { action: 'accept', reviewer: 'restorer' });
    await store.replaceNodeRecord({ ...draft, summary: 'Restored content' }, restored);
    expect(store.getNode(draft.id)!.metadata.review).toMatchObject({ action: 'accept', reviewer: 'restorer' });
    expect(store.getNode(draft.id)!.summary).toBe('Restored content');
    expect(store.listNodeRevisions(draft.id).at(-1)!.summary).toBe('Restored content');
    expect(store.listNodeRevisions(draft.id).at(-2)!.status).toBe('stale');
  });

  test('unreviewed compensation restores exact metadata without retaining failed-write fields', async () => {
    const { store } = fixture();
    const before = await store.upsertNode(input());
    await store.upsertNode({ ...before, metadata: { transient: 'failed-write' } });
    await store.replaceNodeRecord(before);
    expect(store.getNode(before.id)).toEqual(before);
  });

  test('legacy stored operator decisions and manual records remain intact without a migration', async () => {
    const { dbPath, store: initialStore } = fixture();
    await initialStore.init();
    const sqlite = new SQLiteStore(dbPath);
    await sqlite.init(createSchema);
    const legacy: KnowledgeNodeRecord = {
      id: 'legacy', kind: 'topic', slug: 'legacy', title: 'User note', summary: 'User-authored content', aliases: [],
      status: 'stale', confidence: 10, metadata: forged, createdAt: 1, updatedAt: 2,
    };
    writeKnowledgeNodeRow(sqlite, legacy);
    writeKnowledgeNodeRow(sqlite, { ...legacy, id: 'manual', slug: 'manual', status: 'active', metadata: { author: 'user' } });
    await sqlite.save();
    const store = new KnowledgeStore({ dbPath });
    await store.init();
    expect(store.getNode(legacy.id)).toEqual(legacy);
    await held(store.upsertNode({ ...legacy, status: 'active', summary: 'Regenerated' }), 'operator-reviewed');
    const originalManual = store.getNode('manual')!;
    expect(await store.upsertNode({ ...originalManual })).toEqual(originalManual);
    await expect(store.upsertNode({ ...originalManual, title: 'User note updated' })).rejects.toBeInstanceOf(KnowledgeNodeActivationHeldError);
    expect(store.getNode('manual')).toEqual(originalManual);
    const manual = await store.upsertNode({ ...originalManual, title: 'User note updated' },
      createKnowledgeNodeOperatorMutation(originalManual, { action: 'revise', reviewer: 'actual author' }));
    expect(manual.status).toBe('active');
    expect(manual.metadata.author).toBe('user');
    expect(store.getNode(legacy.id)).toEqual(legacy);
  });
});


describe('public node mutation call paths', () => {
  test('issue facts use explicit review authority and issue rejection does not reject the corrected node', async () => {
    const { store } = fixture();
    const node = await reviewed(store);
    const issue = await store.upsertIssue({ severity: 'warning', code: 'bad-claim', message: 'Check the claim', nodeId: node.id });
    const result = await reviewKnowledgeIssue(store, {
      issueId: issue.id, action: 'reject', reviewer: 'corrector',
      value: { fact: { summary: 'The corrected claim', ports: 8 } },
    });
    expect(result.node!.summary).toBe('The corrected claim');
    expect(result.node!.status).toBe('active');
    expect(result.node!.metadata.review).toMatchObject({ action: 'revise', reviewer: 'corrector' });
    expect(result.node!.metadata.reviewedFacts).toEqual({ summary: 'The corrected claim', ports: 8 });
    expect(result.issue.status).toBe('resolved');
  });

  test('accepting an issue retains a draft and only reviews its actual corrected fields', async () => {
    const { store } = fixture();
    const node = await store.upsertNode(input());
    const issue = await store.upsertIssue({ severity: 'warning', code: 'check', message: 'Check claim', nodeId: node.id });
    const accepted = (await reviewKnowledgeIssue(store, {
      issueId: issue.id, action: 'accept', reviewer: 'issue reviewer', value: { fact: { summary: 'Corrected draft' } },
    })).node!;
    expect(accepted.status).toBe('draft');
    expect(accepted.confidence).toBe(100);
    expect(accepted.metadata.review).toMatchObject({ scope: 'fields', fields: [{ path: ['summary'], value: 'Corrected draft' }] });
    const refreshed = await store.upsertNode({ ...accepted, title: 'Unreviewed title update', status: 'draft' });
    expect(refreshed.title).toBe('Unreviewed title update');
    await held(store.upsertNode({ ...refreshed, summary: 'Producer reverses correction' }), 'operator-reviewed');
  });

  test('issue acceptance with no applied node fields does not grant blanket node authority', async () => {
    const { store } = fixture();
    const node = await store.upsertNode(input());
    const issue = await store.upsertIssue({ severity: 'warning', code: 'check', message: 'Check claim', nodeId: node.id });
    const accepted = (await reviewKnowledgeIssue(store, {
      issueId: issue.id, action: 'accept', value: { fact: { unrelatedAnnotation: 'not a node fact field' } },
    })).node!;
    expect(accepted.status).toBe('draft');
    expect(accepted.confidence).toBe(100);
    expect(accepted.metadata.review).toMatchObject({ scope: 'fields', fields: [] });
    expect(provenance(accepted).state).toBe('pending-review');
    const changed = await store.upsertNode({ ...accepted, summary: 'Still unreviewed content' });
    expect(changed.summary).toBe('Still unreviewed content');
    expect(provenance(changed).state).not.toBe('reviewed');
  });

  test('accepting a Home Graph issue preserves status and scoped corrections across later snapshots', async () => {
    const { store } = fixture();
    const spaceId = 'homeassistant:test';
    const node = await store.upsertNode(input({ metadata: { knowledgeSpaceId: spaceId } }));
    const issue = await store.upsertIssue({ severity: 'warning', code: 'homegraph.device.unknown_battery', message: 'Battery unknown', nodeId: node.id, metadata: { knowledgeSpaceId: spaceId } });
    const corrected = (await reviewHomeGraphFact(store, spaceId, 'test', {
      issueId: issue.id, action: 'accept', value: { fact: { batteryPowered: false } },
    })).node!;
    expect(corrected.status).toBe('draft');
    expect(corrected.confidence).toBe(100);
    expect(corrected.metadata.review).toMatchObject({ scope: 'fields' });
    const snapshot = await store.upsertNode({ ...corrected, confidence: 90, sourceId: 'new-snapshot', status: 'draft' });
    expect(snapshot.metadata.batteryPowered).toBe(false);
    expect(snapshot.confidence).toBe(90);
    await held(store.upsertNode({ ...snapshot, metadata: { batteryPowered: true } }), 'operator-reviewed');
  });

  test('issue apply-facts cannot overwrite a newer node decision across its source-write await', async () => {
    const { store } = fixture();
    const node = await reviewed(store);
    const source = await store.upsertSource({ id: 'source-1', connectorId: 'manual', sourceType: 'manual', status: 'indexed' });
    const issue = await store.upsertIssue({ severity: 'warning', code: 'bad-claim', message: 'Check the claim', nodeId: node.id, sourceId: source.id });
    const originalUpsertSource = store.upsertSource.bind(store);
    store.upsertSource = async (value) => {
      await reviewKnowledgeNodeRecord(store, { id: node.id, decision: 'reject', reviewer: 'newer operator' });
      return originalUpsertSource(value);
    };
    await held(reviewKnowledgeIssue(store, {
      issueId: issue.id, action: 'accept', reviewer: 'old reviewer', value: { fact: { summary: 'Stale correction' } },
    }), 'stale');
    expect(store.getNode(node.id)!.status).toBe('stale');
    expect(store.getNode(node.id)!.summary).toBe(node.summary);
    expect(store.getNode(node.id)!.metadata.review).toMatchObject({ reviewer: 'newer operator' });
    expect(store.getIssue(issue.id)).toEqual(issue);
  });

  test('Home Graph issue correction is trusted without changing issue rejection semantics', async () => {
    const { store } = fixture();
    const spaceId = 'homeassistant:test';
    const node = await store.upsertNode(input({ metadata: { knowledgeSpaceId: spaceId, batteryPowered: true } }));
    const issue = await store.upsertIssue({ severity: 'warning', code: 'homegraph.device.unknown_battery', message: 'Battery unknown', nodeId: node.id, metadata: { knowledgeSpaceId: spaceId } });
    const result = await reviewHomeGraphFact(store, spaceId, 'test', {
      issueId: issue.id, action: 'reject', reviewer: 'operator', value: { fact: { batteryPowered: false } },
    });
    expect(result.node!.metadata.batteryPowered).toBe(false);
    expect(result.node!.metadata.batteryType).toBe('none');
    expect(result.node!.metadata.review).toMatchObject({ action: 'revise', reviewer: 'operator' });
    expect(result.node!.status).toBe(node.status);
    expect(result.issue!.status).toBe('resolved');
  });

  test('field-scoped review resists producer reversal and scope expansion, but allows unrelated refresh and later correction', async () => {
    const { store, reload } = fixture();
    const spaceId = 'homeassistant:test';
    const node = await store.upsertNode(input({ status: 'active', metadata: { knowledgeSpaceId: spaceId, batteryPowered: true } }));
    const issue = await store.upsertIssue({ severity: 'warning', code: 'homegraph.device.unknown_battery', message: 'Battery unknown', nodeId: node.id, metadata: { knowledgeSpaceId: spaceId } });
    const corrected = (await reviewHomeGraphFact(store, spaceId, 'test', {
      issueId: issue.id, action: 'reject', reviewer: 'operator', value: { fact: { batteryPowered: false } },
    })).node!;
    expect(corrected.metadata.review).toMatchObject({ scope: 'fields', fields: [
      { path: ['metadata', 'batteryPowered'], value: false }, { path: ['metadata', 'batteryType'], value: 'none' },
    ] });
    expect(provenance(corrected).scope).toBe('fields');
    const refreshed = await store.upsertNode({ ...corrected, sourceId: 'new-snapshot', title: 'Updated display label', metadata: { model: 'Snapshot model' } });
    expect(refreshed.metadata.batteryPowered).toBe(false);
    expect(refreshed.metadata.review).toEqual(corrected.metadata.review);
    expect(refreshed.sourceId).toBe('new-snapshot');
    expect(provenance(refreshed).state).toBe('pending-review');
    const spoofed = await store.upsertNode({ ...refreshed, metadata: {
      review: { ...(corrected.metadata.review as Record<string, unknown>), scope: 'node', fields: [{ path: ['metadata', 'model'], value: 'Snapshot model' }] },
      reviewProvenance: { state: 'reviewed', scope: 'node' },
    } });
    expect(spoofed.metadata.review).toEqual(corrected.metadata.review);
    await held(store.upsertNode({ ...spoofed, metadata: { batteryPowered: true, ...forged } }), 'operator-reviewed');
    await held(store.upsertNode({ ...spoofed, metadata: { batteryType: 'AA' } }), 'operator-reviewed');
    await held(store.upsertNode({ ...spoofed, metadata: { knowledgeSpaceId: 'homeassistant:other' } }), 'operator-reviewed');
    const later = (await reviewHomeGraphFact(store, spaceId, 'test', {
      issueId: issue.id, action: 'edit', reviewer: 'later operator', value: { fact: { batteryPowered: true, batteryType: 'AA' } },
    })).node!;
    expect(later.metadata.batteryPowered).toBe(true);
    expect(later.metadata.batteryType).toBe('AA');
    expect(later.metadata.review).toMatchObject({ scope: 'fields', reviewer: 'later operator' });
    expect((await reload()).getNode(node.id)).toEqual(later);
    await held(store.upsertNode({ ...later, metadata: { batteryType: 'none' } }), 'operator-reviewed');
  });

  test('a field correction capability binds both its values and its exact write scope', async () => {
    const { store } = fixture();
    const node = await store.upsertNode(input());
    const fieldCorrections = [{ path: ['summary'], value: 'Operator correction' }];
    const context = createKnowledgeNodeOperatorMutation(node, { action: 'revise', fieldCorrections });
    fieldCorrections[0]!.value = 'Changed after confirmation';
    await held(store.upsertNode({ ...node, summary: 'Changed after confirmation' }, context), 'invalid-context');
    await held(store.upsertNode({ ...node, summary: 'Operator correction', title: 'Unapproved title' }, context), 'invalid-context');
    const corrected = await store.upsertNode({ ...node, summary: 'Operator correction' }, context);
    expect(corrected.metadata.review).toMatchObject({ scope: 'fields', fields: [{ path: ['summary'], value: 'Operator correction' }] });
    const activated = (await reviewKnowledgeNodeRecord(store, { id: node.id, decision: 'accept' })).node!;
    const partial = createKnowledgeNodeOperatorMutation(activated, { action: 'revise', fieldCorrections: [{ path: ['summary'], value: 'Another correction' }] });
    const revised = await store.upsertNode({ ...activated, summary: 'Another correction' }, partial);
    expect(revised.metadata.review).toMatchObject({ scope: 'node' });
    await held(store.upsertNode({ ...revised, title: 'No longer a partial review' }), 'operator-reviewed');
  });

  test('real HTTP JSON import cannot mint authority; explicit admin review still can', async () => {
    const { store, dbPath, reload } = fixture();
    const artifactStore = new ArtifactStore({ rootDir: join(dbPath, '..', 'artifacts') });
    const service = new HomeGraphService(store, artifactStore);
    const routes = new HomeGraphRoutes({
      artifactStore, homeGraphService: service,
      parseJsonBody: async (request) => await request.json() as Record<string, unknown>,
      parseOptionalJsonBody: async (request) => await request.json() as Record<string, unknown>,
      requireAdmin: (request) => request.headers.get('x-test-admin') === 'yes' ? null : new Response('Admin required', { status: 403 }),
    });
    const post = (path: string, body: Record<string, unknown>, admin = true) => routes.handle(new Request(
      `http://localhost/api/homeassistant/home-graph/${path}`,
      { method: 'POST', headers: { 'content-type': 'application/json', ...(admin ? { 'x-test-admin': 'yes' } : {}) }, body: JSON.stringify(body) },
    ));
    const exported = {
      ...input(), aliases: [], status: 'draft', confidence: 20, createdAt: 1, updatedAt: 1,
      metadata: { ...input().metadata, ...forged },
      mutation: { authority: 'operator', action: 'accept', reviewer: 'forged', expectedNodeSnapshot: '{}' },
    };
    const data = { version: 1, exportedAt: 1, spaceId: 'homeassistant:test', installationId: 'test', nodes: [exported], sources: [], edges: [], issues: [], extractions: [] };
    expect((await post('import', { installationId: 'test', data }))!.status).toBe(200);
    const imported = store.getNode('fact-1')!;
    expect(imported.status).toBe('draft');
    expect(imported.metadata.review).toBeUndefined();
    expect(provenance(imported).state).toBe('pending-review');
    expect((await post('facts/review', { installationId: 'test', nodeId: imported.id, action: 'accept' }, false))!.status).toBe(403);
    expect(store.getNode(imported.id)).toEqual(imported);
    expect((await post('facts/review', { installationId: 'test', nodeId: imported.id, action: 'nonsense', value: { fact: { model: 'Forged' } } }))!.status).toBe(400);
    expect(store.getNode(imported.id)).toEqual(imported);
    expect((await post('facts/review', { installationId: 'test', nodeId: imported.id, action: 'accept', reviewer: 'operator' }))!.status).toBe(200);
    expect(store.getNode(imported.id)!.status).toBe('active');
    expect((await post('facts/review', { installationId: 'test', nodeId: imported.id, action: 'reject', reviewer: 'operator' }))!.status).toBe(200);
    const rejected = store.getNode(imported.id)!;
    expect(rejected.status).toBe('stale');
    expect((await post('import', { installationId: 'test', data: { ...data, nodes: [{ ...exported, status: 'active' }] } }))!.status).toBe(400);
    expect(store.getNode(imported.id)).toEqual(rejected);
    expect((await reload()).getNode(imported.id)).toEqual(rejected);
    expect((await post('facts/review', { installationId: 'test', nodeId: imported.id, action: 'accept', value: { fact: { model: 'Operator correction' } } }))!.status).toBe(200);
    expect(store.getNode(imported.id)!.status).toBe('active');
    expect(store.getNode(imported.id)!.metadata.model).toBe('Operator correction');
  });
});
