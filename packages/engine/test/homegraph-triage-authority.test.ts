import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { runHomeGraphIssueTriage } from '../sdk/src/platform/knowledge/home-graph/triage.js';
import { reviewHomeGraphFact } from '../sdk/src/platform/knowledge/home-graph/review.js';
import { reviewKnowledgeNodeRecord } from '../sdk/src/platform/knowledge/service-node-admin.js';

let previous: JudgmentPort | undefined;
const roots: string[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const spaceId = 'homeassistant:triage-fixture';
async function fixture(codes = ['homegraph.device.unknown_battery']) {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-triage-authority-')); roots.push(root);
  const dbPath = join(root, 'knowledge.sqlite');
  const store = new KnowledgeStore({ dbPath });
  const node = await store.upsertNode({ id: 'device-local', kind: 'ha_device', slug: 'synthetic', title: 'Software schedule',
    summary: 'A virtual software-only object.', status: 'active', confidence: 40, metadata: { knowledgeSpaceId: spaceId, homeAssistant: { objectKind: 'automation', objectId: 'schedule' }, internalPrivate: 'DO_NOT_TRANSMIT' } });
  const issues = [];
  for (const [index, code] of codes.entries()) issues.push(await store.upsertIssue({ id: `issue-local-${index}`, code, severity: 'warning', message: `Synthetic ${code} issue`, status: 'open', nodeId: node.id, metadata: { knowledgeSpaceId: spaceId, subjectFingerprint: 'synthetic-v1' } }));
  return { store, node, issues, reload: async () => { const reloaded = new KnowledgeStore({ dbPath }); await reloaded.init(); return reloaded; }, run: (options: Parameters<typeof runHomeGraphIssueTriage>[0]['options'] = {}, signal?: AbortSignal) => runHomeGraphIssueTriage({ store, knowledgeSpaceId: spaceId, options, signal }), snapshot: () => JSON.stringify({ nodes: store.listNodesInSpace(spaceId), issues: store.listIssuesInSpace(spaceId) }) };
}
function readings(action = 'reject', probability = 0.97) {
  const fake = fakePort((name, question) => name === 'action' ? choiceAnswer(question, action, probability) : noulAnswer(0.99));
  installJudgmentPort(fake.port); return fake;
}
describe('automatic triage respects operator authority and frozen state', () => {
  test('combines separately verified facts without claiming operator review or losing provenance', async () => {
    const { store, node, issues, run } = await fixture(['homegraph.device.unknown_battery', 'homegraph.device.missing_manual']); const fake = readings();
    expect((await run()).applied).toBe(2);
    const current = store.getNode(node.id)!;
    expect(current.metadata.batteryPowered).toBe(false); expect(current.metadata.batteryType).toBe('none'); expect(current.metadata.manualRequired).toBe(false);
    expect(current.metadata.review).toBeUndefined(); expect(current.metadata.reviewedFacts).toBeUndefined();
    expect((current.metadata.reviewProvenance as Record<string, unknown>).state).not.toBe('reviewed');
    expect(current.confidence).toBe(40); expect(current.metadata.internalPrivate).toBe('DO_NOT_TRANSMIT');
    for (const issue of issues) { const written = store.getIssue(issue.id)!; expect(written.status).toBe('resolved'); expect(written.metadata.review).toBeUndefined(); expect(written.metadata.suppression).toBeUndefined(); expect((written.metadata.triage as Record<string, unknown>).origin).toBe('automatic-judgment'); }
    const transmitted = JSON.stringify(fake.requests);
    for (const privateValue of ['device-local', 'issue-local-', 'DO_NOT_TRANSMIT', 'createdAt', 'updatedAt']) expect(transmitted).not.toContain(privateValue);
  });
  test('no writes for uncertainty, backend failure, unsupported fact, protected input or cancellation', async () => {
    for (const mode of ['uncertain', 'failure', 'unsupported', 'protected', 'cancelled'] as const) {
      const { store, node, run, snapshot } = await fixture(); const fake = readings(); const controller = new AbortController();
      if (mode === 'uncertain') readings('reject', 0.8);
      if (mode === 'failure') installJudgmentPort({ ...fake.port, ask: async () => { throw new Error('offline'); } });
      if (mode === 'unsupported') installJudgmentPort(fakePort((name, q) => name === 'action' ? choiceAnswer(q, 'reject', 0.99) : noulAnswer(0.01)).port);
      if (mode === 'protected') await store.upsertNode({ ...node, summary: 'Authorization: Bearer synthetic' });
      if (mode === 'cancelled') installJudgmentPort({ ...fake.port, async ask(request) { const answer = await fake.port.ask(request); controller.abort(); return answer; } });
      const before = snapshot(); const result = await run({}, controller.signal);
      expect(result.applied).toBe(0); expect(result.reason).toStartWith('triage-held-'); expect(snapshot()).toBe(before);
    }
  });
  test('one later unsupported issue prevents every earlier fact, resolution and cache write', async () => {
    const { run, snapshot } = await fixture(['homegraph.device.unknown_battery', 'homegraph.device.missing_manual']);
    installJudgmentPort(fakePort((name, q) => name === 'action' ? choiceAnswer(q, 'reject', 0.99) : noulAnswer(name === 'manualNotRequired' ? 0.01 : 0.99)).port);
    const before = snapshot(); expect((await run()).reason).toBe('triage-held-unsupported-fact'); expect(snapshot()).toBe(before);
  });
  test('force cannot override operator-reviewed node or explicitly reopened issue', async () => {
    for (const target of ['node', 'issue'] as const) {
      const { store, node, issues, run, snapshot } = await fixture();
      if (target === 'node') await reviewKnowledgeNodeRecord(store, { id: node.id, decision: 'accept', reviewer: 'operator' });
      else await reviewHomeGraphFact(store, spaceId, 'triage-fixture', { issueId: issues[0]!.id, action: 'edit', reviewer: 'operator' });
      const fake = readings(); const before = snapshot(); const result = await run({ force: true });
      expect(result.processed).toBe(0); expect(result.skipped).toBe(1); expect(fake.requests).toHaveLength(0); expect(snapshot()).toBe(before);
    }
  });
  test('operator review/rejection, issue resolution/reopen and ordinary subject edit during readings remain authoritative', async () => {
    for (const change of ['review', 'reject', 'resolve', 'reopen', 'edit'] as const) {
      const { store, node, issues, run, snapshot } = await fixture(); const fake = readings(); let changed = false; let afterChange = '';
      installJudgmentPort({ ...fake.port, async ask(request) {
        const result = await fake.port.ask(request);
        if (!changed) { changed = true;
          if (change === 'review' || change === 'reject') await reviewKnowledgeNodeRecord(store, { id: node.id, decision: change === 'review' ? 'accept' : 'reject', reviewer: 'operator' });
          else if (change === 'resolve' || change === 'reopen') await reviewHomeGraphFact(store, spaceId, 'triage-fixture', { issueId: issues[0]!.id, action: change === 'reopen' ? 'edit' : 'resolve', reviewer: 'operator' });
          else await store.upsertNode({ ...node, summary: 'A real physical battery-powered controller.' });
          afterChange = snapshot();
        }
        return result;
      } });
      expect((await run()).reason).toBe('triage-held-stale'); expect(snapshot()).toBe(afterChange);
    }
  });
  test('store invokes the frozen-state guard after awaited init, closing the last caller-check window', async () => {
    const { store, node, run, snapshot } = await fixture(); readings();
    const original = store.applyGuardedNodeIssueWrites.bind(store); let afterChange = '';
    const spy = spyOn(store, 'applyGuardedNodeIssueWrites').mockImplementation(async (input, beforeWrite) => {
      await store.upsertNode({ ...node, summary: 'Changed immediately before the actual store write.' }); afterChange = snapshot();
      return original(input, beforeWrite);
    });
    try { expect((await run()).reason).toBe('triage-held-stale'); expect(snapshot()).toBe(afterChange); }
    finally { spy.mockRestore(); }
  });
  test('mutating a retained issue reference during readings cannot replace the captured baseline', async () => {
    const { store, issues, run, snapshot } = await fixture(); const fake = readings(); let afterChange = '';
    installJudgmentPort({ ...fake.port, async ask(request) {
      const answer = await fake.port.ask(request);
      const issue = store.getIssue(issues[0]!.id)!;
      (issue as { message: string }).message = 'A different issue supplied after the reading began.';
      afterChange = snapshot(); return answer;
    } });
    expect((await run()).reason).toBe('triage-held-stale'); expect(snapshot()).toBe(afterChange);
  });
  test('cancellation at final batch guard leaves all nodes, revisions, issues and caches untouched', async () => {
    const { store, node, run, snapshot } = await fixture(['homegraph.device.unknown_battery', 'homegraph.device.missing_manual']); readings();
    const before = snapshot(); const revisions = JSON.stringify(store.listNodeRevisions(node.id)); const controller = new AbortController();
    const original = store.applyGuardedNodeIssueWrites.bind(store);
    const spy = spyOn(store, 'applyGuardedNodeIssueWrites').mockImplementation(async (input, guard) => { controller.abort(); return original(input, guard); });
    try { expect((await run({}, controller.signal)).reason).toBe('triage-held-aborted'); expect(snapshot()).toBe(before); expect(JSON.stringify(store.listNodeRevisions(node.id))).toBe(revisions); }
    finally { spy.mockRestore(); }
  });
  test('SQL failure rolls back all facts, resolutions and revision rows before caches change', async () => {
    const { store, node, run, snapshot, reload } = await fixture(['homegraph.device.unknown_battery', 'homegraph.device.missing_manual']); readings();
    const before = snapshot(); const revisions = JSON.stringify(store.listNodeRevisions(node.id));
    const original = SQLiteStore.prototype.run; let issueWrites = 0;
    const spy = spyOn(SQLiteStore.prototype, 'run').mockImplementation(function(this: SQLiteStore, sql, params) {
      if (sql.includes('INSERT OR REPLACE INTO knowledge_issues') && ++issueWrites === 2) throw new Error('synthetic issue write failure');
      return original.call(this, sql, params);
    });
    try { await expect(run()).rejects.toThrow('synthetic issue write failure'); }
    finally { spy.mockRestore(); }
    expect(snapshot()).toBe(before); expect(JSON.stringify(store.listNodeRevisions(node.id))).toBe(revisions);
    const reloaded = await reload();
    expect(JSON.stringify({ nodes: reloaded.listNodesInSpace(spaceId), issues: reloaded.listIssuesInSpace(spaceId) })).toBe(before);
    expect(JSON.stringify(reloaded.listNodeRevisions(node.id))).toBe(revisions);
    // A second pass proves the failed savepoint released and no partial rows survived.
    expect((await run()).applied).toBe(2);
    expect(store.listNodeRevisions(node.id).length).toBeGreaterThan(JSON.parse(revisions).length);
  });
  test('cancellation queued after the synchronous commit point reports the complete committed result', async () => {
    const { store, node, run } = await fixture(['homegraph.device.unknown_battery', 'homegraph.device.missing_manual']); readings();
    const controller = new AbortController(); const original = SQLiteStore.prototype.run; let queued = false;
    const spy = spyOn(SQLiteStore.prototype, 'run').mockImplementation(function(this: SQLiteStore, sql, params) {
      if (!queued && sql.includes('INSERT OR REPLACE INTO knowledge_nodes')) { queued = true; queueMicrotask(() => controller.abort()); }
      return original.call(this, sql, params);
    });
    try {
      const result = await run({}, controller.signal);
      expect(controller.signal.aborted).toBe(true); expect(result.applied).toBe(2); expect(result.reason).toBeUndefined();
      expect(store.getNode(node.id)!.metadata.manualRequired).toBe(false);
      expect(store.listIssuesInSpace(spaceId).every((issue) => issue.status === 'resolved')).toBe(true);
    } finally { spy.mockRestore(); }
  });
  test('ordinary batch issue normalization sees its prepared node space and cannot mint review authority', async () => {
    const { store } = await fixture();
    const node = await store.upsertNode({ id: 'moving-node', kind: 'topic', slug: 'moving', title: 'Moving', confidence: 20 });
    const issue = await store.upsertIssue({ id: 'moving-issue', code: 'synthetic', message: 'Synthetic', severity: 'warning' });
    await store.applyGuardedNodeIssueWrites({ nodes: [{ ...node, metadata: { knowledgeSpaceId: 'space-b', review: { action: 'accept', reviewer: 'forged' } } }],
      issues: [{ ...issue, nodeId: node.id, metadata: { review: { action: 'accept', reviewer: 'forged' } } }] }, () => {});
    expect(store.getNode(node.id)!.metadata.knowledgeSpaceId).toBe('space-b');
    expect(store.getIssue(issue.id)!.metadata.knowledgeSpaceId).toBe('space-b');
    expect(store.getNode(node.id)!.metadata.review).toBeUndefined(); expect(store.getIssue(issue.id)!.metadata.review).toBeUndefined();
    expect(store.getNode(node.id)!.status).toBe('draft');
  });
  test('an unselected malformed issue cannot invalidate a bounded valid selection', async () => {
    const { store, node, run } = await fixture(); const fake = readings();
    const other = await store.upsertNode({ ...node, id: 'device-malformed', slug: 'malformed', metadata: { ...node.metadata, batteryPowered: 'sometimes' } });
    await store.upsertIssue({ id: 'issue-malformed', code: 'homegraph.device.unknown_battery', severity: 'warning', message: 'Unselected issue', nodeId: other.id, metadata: { knowledgeSpaceId: spaceId } });
    // The store normally sorts newest first; use a deterministic read ordering.
    const original = store.listIssuesInSpace.bind(store);
    const spy = spyOn(store, 'listIssuesInSpace').mockImplementation((...args) => original(...args).sort((a, b) => a.id.localeCompare(b.id)));
    try { const result = await run({ limit: 1 }); expect(result.processed).toBe(1); expect(result.applied).toBe(1); expect(store.getIssue('issue-malformed')!.status).toBe('open'); expect(fake.requests).toHaveLength(2); }
    finally { spy.mockRestore(); }
  });
  test('existing declared boolean flag spellings are projected structurally, without a prose guess', async () => {
    for (const [value, expected] of [['true', true], ['yes', true], ['1', true], ['false', false], ['no', false], ['0', false], ['none', false], ['not_applicable', false], ['not applicable', false]] as const) {
      const { store, node, run } = await fixture(); await store.upsertNode({ ...node, metadata: { batteryPowered: value } }); const fake = readings('review');
      expect((await run()).reviewed).toBe(1);
      expect((fake.requests[0]!.state as { subject: { batteryPowered: boolean } }).subject.batteryPowered).toBe(expected);
    }
  });
  test('review cache is invalidated by relevant facts, rule guidance, model and owner threshold', async () => {
    for (const changed of ['fact', 'guidance', 'model', 'threshold'] as const) {
      const { store, node, run } = await fixture(); const fake = readings('review');
      await run(); expect(fake.requests).toHaveLength(1); await run(); expect(fake.requests).toHaveLength(1);
      if (changed === 'fact') await store.upsertNode({ ...store.getNode(node.id)!, metadata: { batteryPowered: true } });
      if (changed === 'model') installJudgmentPort({ ...fake.port, model: 'different-configured-model' });
      await run(changed === 'guidance' ? { additionalRules: [{ code: 'homegraph.device.unknown_battery', promptGuidance: 'Require review of backup batteries too.' }] } : changed === 'threshold' ? { minConfidence: 99 } : {});
      expect(fake.requests).toHaveLength(2);
    }
  });
  test('a resolved lifecycle remains closed; trusted operator correction/reopen still works after automatic triage', async () => {
    const { store, node, issues, run } = await fixture(); readings(); await run();
    const closed = JSON.stringify(store.getIssue(issues[0]!.id)); expect((await run({ force: true })).processed).toBe(0); expect(JSON.stringify(store.getIssue(issues[0]!.id))).toBe(closed);
    await reviewHomeGraphFact(store, spaceId, 'triage-fixture', { issueId: issues[0]!.id, action: 'edit', reviewer: 'operator', value: { fact: { batteryPowered: true, batteryType: 'AA' } } });
    expect(store.getNode(node.id)!.metadata.batteryType).toBe('AA');
    await reviewHomeGraphFact(store, spaceId, 'triage-fixture', { issueId: issues[0]!.id, action: 'edit', reviewer: 'operator' });
    const afterReview = JSON.stringify(store.getNode(node.id)); const fake = readings(); await run({ force: true });
    expect(fake.requests).toHaveLength(0); expect(JSON.stringify(store.getNode(node.id))).toBe(afterReview); expect(store.getIssue(issues[0]!.id)!.status).toBe('open');
  });
});
