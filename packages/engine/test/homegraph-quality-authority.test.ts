import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ArtifactStore } from '../sdk/src/platform/artifacts/index.js';
import { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { refreshHomeGraphQualityIssues, homeGraphQualityNamespace } from '../sdk/src/platform/knowledge/home-graph/quality.js';
import { refreshHomeGraphDevicePassport } from '../sdk/src/platform/knowledge/home-graph/generated-pages.js';
import { runHomeGraphSnapshotSync } from '../sdk/src/platform/knowledge/home-graph/sync.js';
import { reviewHomeGraphFact } from '../sdk/src/platform/knowledge/home-graph/review.js';
import type { KnowledgeNodeRecord } from '../sdk/src/platform/knowledge/types.js';
import { buildIssue, readRecord, stableHash } from '../sdk/src/platform/knowledge/home-graph/helpers.js';
import { readHomeGraphState } from '../sdk/src/platform/knowledge/home-graph/state.js';
let previous: JudgmentPort | undefined;
const roots: string[] = [];
const spaceId = 'homeassistant:quality-fixture', installationId = 'quality-fixture';
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function readings(battery = 0.99, manual = 0.99) {
  const fake = fakePort((name) => {
    if (name === 'batteryApplicable') return noulAnswer(battery);
    if (['manualApplicable', 'manufacturerPresent', 'modelPresent', 'batteryTypePresent'].includes(name)) return noulAnswer(manual);
    throw new Error(`Unexpected quality fixture question: ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-quality-')); roots.push(root);
  const dbPath = join(root, 'knowledge.sqlite'), store = new KnowledgeStore({ dbPath });
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const node = await seedHomeAssistantObservation(store, { id: 'LOCAL_DEVICE', kind: 'ha_device', slug: 'lamp', title: 'Mains service hub', summary: 'Physical equipment with internal backup battery.', aliases: [], status: 'active', metadata: { knowledgeSpaceId: spaceId, homeAssistant: { objectKind: 'device', objectId: 'lamp' }, private: 'DO_NOT_TRANSMIT' } });
  const entity = await seedHomeAssistantObservation(store, { id: 'LOCAL_ENTITY', kind: 'ha_entity', slug: 'sensor', title: 'Telemetry', status: 'active', metadata: { knowledgeSpaceId: spaceId, homeAssistant: { entityId: 'binary_sensor.lamp' } } });
  await store.upsertEdge({ fromKind: 'node', fromId: entity.id, toKind: 'node', toId: node.id, relation: 'belongs_to_device', metadata: { knowledgeSpaceId: spaceId } });
  const run = (signal?: AbortSignal) => refreshHomeGraphQualityIssues(store, spaceId, installationId, { signal });
  const snapshot = () => JSON.stringify(readHomeGraphState(store, spaceId));
  return { root, dbPath, store, node, entity, artifactStore, run, snapshot };
}
/** The exact previous generator algorithm, used only to detect a real legacy content change. */
function legacyHomeGraphQualityFingerprint(node: KnowledgeNodeRecord, code: string): string {
  const homeAssistant = readRecord(node.metadata.homeAssistant), attributes = readRecord(node.metadata.attributes);
  return stableHash(JSON.stringify({ code, kind: node.kind, title: node.title,
    manufacturer: node.metadata.manufacturer, model: node.metadata.model,
    batteryPowered: node.metadata.batteryPowered, batteryType: node.metadata.batteryType,
    manualRequired: node.metadata.manualRequired,
    objectKind: homeAssistant.objectKind, objectId: homeAssistant.objectId, entityId: homeAssistant.entityId,
    deviceId: homeAssistant.deviceId, integrationId: homeAssistant.integrationId, domain: homeAssistant.domain,
    deviceClass: attributes.device_class,
  }));
}

describe('Home Graph whole-pass quality authority', () => {
  test('creates new issues with reading provenance, relation scope and no operator authority; settled no removes only ordinary issues', async () => {
    const { store, run } = await fixture(); const fake = readings();
    const issues = await run(); expect(issues).toHaveLength(2);
    for (const issue of issues) { expect(issue.metadata.qualityReading).toBeDefined(); expect(issue.metadata.review).toBeUndefined(); }
    const sent = JSON.stringify(fake.requests); expect(sent).toContain('binary_sensor.lamp');
    for (const absent of ['LOCAL_DEVICE', 'LOCAL_ENTITY', 'DO_NOT_TRANSMIT', 'issueLifecycle']) expect(sent).not.toContain(absent);
    readings(0.01, 0.01); expect(await run()).toHaveLength(0); expect(store.listIssuesInSpace(spaceId)).toHaveLength(0);
  });
  test('later uncertainty, unavailable, protected input or cancellation leaves every old issue byte-identical', async () => {
    for (const mode of ['uncertain', 'unavailable', 'protected', 'cancelled', 'missing'] as const) {
      const { store, node, run, snapshot } = await fixture(); readings(); await run(); const fake = readings(0.01, 0.5); const controller = new AbortController();
      if (mode === 'unavailable') installJudgmentPort({ ...fake.port, ask: async () => { throw new Error('offline'); } });
      if (mode === 'missing') installJudgmentPort(undefined);
      if (mode === 'protected') await seedHomeAssistantObservation(store, { ...node, summary: 'Authorization: Bearer synthetic' });
      if (mode === 'cancelled') installJudgmentPort({ ...fake.port, async ask(request) { const result = await fake.port.ask(request); controller.abort(); return result; } });
      const before = snapshot(); await expect(run(controller.signal)).rejects.toThrow(); expect(snapshot()).toBe(before);
      if (mode === 'protected') expect(fake.requests).toHaveLength(0);
    }
  });
  test('full selected-device preflight refuses a later protected device before the first request', async () => {
    const { store, run } = await fixture();
    await seedHomeAssistantObservation(store, { id: 'LATE_DEVICE', kind: 'ha_device', slug: 'late', title: 'Late', summary: 'Authorization: Bearer synthetic', metadata: { knowledgeSpaceId: spaceId } });
    const fake = readings(); await expect(run()).rejects.toThrow(); expect(fake.requests).toHaveLength(0);
  });
  test('snapshots nodes, entities, relations, source membership and operator issues before awaited reads', async () => {
    for (const changed of ['node', 'entity', 'edge', 'source', 'review'] as const) {
      const { store, node, entity, run, snapshot } = await fixture(); readings(); const issues = await run();
      const fake = readings(0.01, 0.01); let done = false, afterChange = ''; let mutationError: unknown;
      installJudgmentPort({ ...fake.port, async ask(request) {
        const result = await fake.port.ask(request);
        if (!done) { done = true; try {
          if (changed === 'node' || changed === 'entity') { const current = changed === 'node' ? node : entity; await seedHomeAssistantObservation(store, { ...current, summary: 'Concurrent correction.' }); }
          if (changed === 'edge') await store.upsertEdge({ fromKind: 'node', fromId: entity.id, toKind: 'node', toId: node.id, relation: 'related_to', metadata: { knowledgeSpaceId: spaceId } });
          if (changed === 'source') await store.upsertSource({ connectorId: 'manual', sourceType: 'manual', title: 'New source', status: 'indexed', canonicalUri: 'manual://new-source', metadata: { knowledgeSpaceId: spaceId } });
          if (changed === 'review') await reviewHomeGraphFact(store, spaceId, installationId, { knowledgeSpaceId: spaceId, issueId: issues[0]!.id, action: 'accept', reviewer: 'owner' });
          afterChange = snapshot();
        } catch (error) { mutationError = error; throw error; } }
        return result;
      } });
      let failure: unknown; try { await run(); } catch (error) { failure = error; }
      expect(mutationError).toBeUndefined(); expect(failure).toMatchObject({ reason: 'stale' }); expect(snapshot()).toBe(afterChange);
    }
  });
  test('resolved and explicitly reopened operator issues survive absent regenerated set', async () => {
    const { store, run } = await fixture(); readings(); const issues = await run();
    await reviewHomeGraphFact(store, spaceId, installationId, { knowledgeSpaceId: spaceId, issueId: issues[0]!.id, action: 'accept', reviewer: 'owner' });
    await reviewHomeGraphFact(store, spaceId, installationId, { knowledgeSpaceId: spaceId, issueId: issues[1]!.id, action: 'accept', reviewer: 'owner' });
    await reviewHomeGraphFact(store, spaceId, installationId, { knowledgeSpaceId: spaceId, issueId: issues[1]!.id, action: 'edit', reviewer: 'owner' });
    const before = JSON.stringify(store.listIssuesInSpace(spaceId)); readings(0.01, 0.01); await run();
    expect(JSON.stringify(store.listIssuesInSpace(spaceId))).toBe(before);
  });
  test('final store boundary checks cancellation before any new issue or delete', async () => {
    const { store, run, snapshot } = await fixture(); readings(); await run(); readings(0.01, 0.01);
    const before = snapshot(), controller = new AbortController(), original = store.replaceIssuesGuarded.bind(store);
    const spy = spyOn(store, 'replaceIssuesGuarded').mockImplementation(async (...args) => { controller.abort(); return original(...args); });
    try { await expect(run(controller.signal)).rejects.toThrow('aborted'); expect(snapshot()).toBe(before); } finally { spy.mockRestore(); }
  });
  test('a legacy review arriving at store entry is a typed stale hold before replacement', async () => {
    const { store, node, run, snapshot } = await fixture();
    const legacy = buildIssue(spaceId, installationId, 'homegraph.device.missing_manual', 'Legacy', { nodeId: node.id });
    const issue = await store.upsertIssue({ ...legacy, metadata: { ...legacy.metadata, generated: true } });
    readings(0.01, 0.99); const original = store.replaceIssuesGuarded.bind(store); let afterReview = '';
    const spy = spyOn(store, 'replaceIssuesGuarded').mockImplementation(async (...args) => {
      await reviewHomeGraphFact(store, spaceId, installationId, { issueId: issue.id, action: 'accept', reviewer: 'owner' });
      afterReview = snapshot(); return original(...args);
    });
    try { await expect(run()).rejects.toThrow('stale'); expect(snapshot()).toBe(afterReview); } finally { spy.mockRestore(); }
  });
  test('SQL failures restore rows and caches atomically before reload, including a fresh issue replacement', async () => {
    const { store, dbPath, run, snapshot } = await fixture(); readings(); const before = snapshot();
    const original = SQLiteStore.prototype.run; let writes = 0, database: SQLiteStore | undefined;
    const spy = spyOn(SQLiteStore.prototype, 'run').mockImplementation(function(this: SQLiteStore, sql, params) {
      database = this; if (sql.includes('INSERT OR REPLACE INTO knowledge_issues') && ++writes === 2) throw new Error('synthetic SQL failure');
      return original.call(this, sql, params);
    });
    try { await expect(run()).rejects.toThrow('synthetic SQL failure'); } finally { spy.mockRestore(); }
    expect(snapshot()).toBe(before); expect(database!.exec('SELECT COUNT(*) FROM knowledge_issues')[0]!.values[0]![0]).toBe(0);
    const reloaded = new KnowledgeStore({ dbPath }); await reloaded.init(); expect(JSON.stringify(readHomeGraphState(reloaded, spaceId))).toBe(before);
    expect(await run()).toHaveLength(2); expect(store.listIssuesInSpace(spaceId)).toHaveLength(2);
  });
  test('quality hold reporting does not falsely undo the structural snapshot import', async () => {
    const { store, artifactStore } = await fixture(); installJudgmentPort(undefined);
    const result = await runHomeGraphSnapshotSync({ store, artifactStore, snapshot: { installationId, devices: [{ id: 'new', name: 'New physical device' }], pageAutomation: { enabled: false } } });
    expect(result.ok).toBe(true); expect(result.quality).toEqual({ status: 'held', reason: 'unconfigured' }); expect(result.created.issues).toBe(0);
    expect(store.getSource(result.source.id)).not.toBeNull(); expect(store.listNodesInSpace(spaceId).some((node) => node.title === 'New physical device')).toBe(true);
  });
  test('snapshot reports retained legacy authority as partial derived quality', async () => {
    const { store, artifactStore, node } = await fixture();
    const legacy = buildIssue(spaceId, installationId, 'homegraph.device.missing_manual', 'Legacy', { nodeId: node.id });
    const issue = await store.upsertIssue({ ...legacy, metadata: { ...legacy.metadata, generated: true, subjectFingerprint: legacyHomeGraphQualityFingerprint(node, legacy.code) } });
    await reviewHomeGraphFact(store, spaceId, installationId, { issueId: issue.id, action: 'accept', reviewer: 'owner' });
    const before = store.getIssue(issue.id); readings(0.01, 0.99);
    const result = await runHomeGraphSnapshotSync({ store, artifactStore, snapshot: { installationId, pageAutomation: { enabled: false } } });
    expect(result.quality).toEqual({ status: 'partial', reason: 'legacy-reviewed-state-retained', retainedLegacyIssues: 1 });
    expect(store.getIssue(issue.id)).toEqual(before);
  });
  test('passport uncertainty is before node, fact, source, edge or artifact writes', async () => {
    const { store, artifactStore, snapshot } = await fixture(); readings(0.5);
    const before = snapshot();
    await expect(refreshHomeGraphDevicePassport({ store, artifactStore, spaceId, installationId, input: { deviceId: 'lamp' } })).rejects.toThrow('unsettled');
    expect(snapshot()).toBe(before); expect(artifactStore.list(20)).toEqual([]);
  });
  test('changed related entity, summary or aliases creates a new lifecycle after resolution; reordering does not', async () => {
    for (const change of ['entity', 'summary', 'aliases'] as const) {
      const { store, node, entity, run } = await fixture(); readings(); const [issue] = await run();
      await reviewHomeGraphFact(store, spaceId, installationId, { issueId: issue!.id, action: 'accept', reviewer: 'owner' });
      const resolved = store.getIssue(issue!.id)!; await run(); expect(store.getIssue(issue!.id)).toEqual(resolved);
      if (change === 'entity') await seedHomeAssistantObservation(store, { ...entity, summary: 'New evidence about physical operating controls.' });
      if (change === 'summary') await seedHomeAssistantObservation(store, { ...node, summary: 'New evidence about physical operating controls.' });
      if (change === 'aliases') await seedHomeAssistantObservation(store, { ...node, aliases: ['New exact variant name'] });
      await run(); const reopened = store.getIssue(issue!.id)!;
      expect(reopened.status).toBe('open'); expect(reopened.metadata.review).toBeUndefined();
      expect(reopened.metadata.subjectFingerprint).not.toBe(resolved.metadata.subjectFingerprint);
    }
  });
  test('literal declarations need no port or unrelated protected semantics and never claim judgment provenance', async () => {
    const { store, node, run } = await fixture();
    await seedHomeAssistantObservation(store, { ...node, summary: 'Authorization: Bearer synthetic', metadata: { batteryPowered: 'yes', manualRequired: 'false' } });
    const [issue] = await run(); expect(issue!.code).toBe('homegraph.device.unknown_battery');
    expect(issue!.metadata.qualityReading).toEqual({ origin: 'declared-fields' });
  });
  test('legacy namespace migration only consumes exact generated quality rows and preserves all other plain-space issues', async () => {
    const { store, node, run } = await fixture();
    const legacy = buildIssue(spaceId, installationId, 'homegraph.device.unknown_battery', 'Legacy generated issue', { nodeId: node.id });
    const old = await store.upsertIssue({ ...legacy, metadata: { ...legacy.metadata, generated: true } });
    const unrelated = await store.upsertIssue({ id: 'UNRELATED', nodeId: node.id, code: 'homegraph.device.unknown_battery', severity: 'warning', message: 'Other producer', metadata: { knowledgeSpaceId: spaceId, namespace: spaceId, generated: true, homeGraph: true, subjectId: node.id } });
    readings(0.99, 0.01); await run(); expect(store.getIssue(old.id)!.metadata.namespace).toBe(homeGraphQualityNamespace(spaceId)); expect(store.getIssue(unrelated.id)).toEqual(unrelated);
    readings(0.01, 0.01); await run(); expect(store.getIssue(old.id)).toBeNull(); expect(store.getIssue(unrelated.id)).toEqual(unrelated);
  });
  test('invalid legacy marker, code or subject never broadens the removal scope; reviewed-open legacy remains exact', async () => {
    for (const bad of ['marker', 'code', 'subject', 'review'] as const) {
      const { store, node, run } = await fixture();
      const legacy = buildIssue(spaceId, installationId, 'homegraph.device.unknown_battery', 'Legacy generated issue', { nodeId: node.id });
      const issue = await store.upsertIssue({ ...legacy, ...(bad === 'code' ? { code: 'custom' } : {}),
        metadata: { ...legacy.metadata, ...(bad !== 'marker' ? { generated: true } : {}), ...(bad === 'subject' ? { subjectId: 'other' } : {}) } });
      if (bad === 'review') {
        await reviewHomeGraphFact(store, spaceId, installationId, { issueId: issue.id, action: 'accept', reviewer: 'owner' });
        await reviewHomeGraphFact(store, spaceId, installationId, { issueId: issue.id, action: 'edit', reviewer: 'owner' });
      }
      const before = store.getIssue(issue.id); readings(0.01, 0.01); await run(); expect(store.getIssue(issue.id)).toEqual(before);
    }
  });
  test('fingerprint version upgrade preserves unchanged legacy resolved and reviewed-open rows byte for byte', async () => {
    for (const reopen of [false, true]) {
      const { store, node, run } = await fixture();
      const input = buildIssue(spaceId, installationId, 'homegraph.device.missing_manual', 'Legacy generated issue', { nodeId: node.id });
      const issue = await store.upsertIssue({ ...input, metadata: { ...input.metadata, generated: true, subjectFingerprint: legacyHomeGraphQualityFingerprint(node, input.code) } });
      await reviewHomeGraphFact(store, spaceId, installationId, { issueId: issue.id, action: 'accept', reviewer: 'owner' });
      if (reopen) await reviewHomeGraphFact(store, spaceId, installationId, { issueId: issue.id, action: 'edit', reviewer: 'owner' });
      const before = JSON.stringify(store.getIssue(issue.id)); readings(0.01, 0.99); await run();
      expect(JSON.stringify(store.getIssue(issue.id))).toBe(before);
      await seedHomeAssistantObservation(store, { ...node, metadata: { model: 'Changed physical variant' } });
      await run(); expect(JSON.stringify(store.getIssue(issue.id))).toBe(before); // Legacy hashes cannot prove a semantic change.
    }
  });
  test('equivalent declared-flag spellings do not clear a versioned explicit review', async () => {
    const { store, node, run } = await fixture();
    await seedHomeAssistantObservation(store, { ...node, metadata: { batteryPowered: true, manualRequired: true } });
    const issues = await run();
    for (const issue of issues) await reviewHomeGraphFact(store, spaceId, installationId, { issueId: issue.id, action: 'accept', reviewer: 'owner' });
    const before = JSON.stringify(store.listIssuesInSpace(spaceId));
    await seedHomeAssistantObservation(store, { ...node, metadata: { batteryPowered: 'yes', manualRequired: '1' } }); await run();
    expect(JSON.stringify(store.listIssuesInSpace(spaceId))).toBe(before);
  });
  test('same-name devices keep distinct evidence and exact local issue subjects', async () => {
    const { store, node, run } = await fixture();
    const other = await seedHomeAssistantObservation(store, { ...node, id: 'OTHER_DEVICE', slug: 'other', summary: 'Software-only namesake.' });
    installJudgmentPort(fakePort((_name, _question, state) => noulAnswer((state as { subject: { summary: string } }).subject.summary === 'Software-only namesake.' ? 0.01 : 0.99)).port);
    const issues = await run(); expect(issues).toHaveLength(2); expect(issues.every((issue) => issue.nodeId === node.id)).toBe(true);
    expect(issues.some((issue) => issue.nodeId === other.id)).toBe(false);
  });
  test('passport rerun preserves its existing derived fields and artifact when a later reading is held', async () => {
    const { store, artifactStore, snapshot } = await fixture(); readings(0.99);
    const context = { store, artifactStore, spaceId, installationId, input: { deviceId: 'lamp' } };
    const first = await refreshHomeGraphDevicePassport(context);
    const before = snapshot(), artifacts = JSON.stringify(artifactStore.list(20)); readings(0.5);
    await expect(refreshHomeGraphDevicePassport(context)).rejects.toThrow('unsettled');
    expect(snapshot()).toBe(before); expect(JSON.stringify(artifactStore.list(20))).toBe(artifacts);
    expect(store.getNode(first.passport.id)?.metadata.missingFields).toEqual(first.passport.metadata.missingFields);
  });
  test('all declared boolean-like mappings work end to end without a judgment port', async () => {
    for (const [value, expected] of [[true, 2], ['true', 2], ['yes', 2], ['1', 2], [false, 0], ['false', 0], ['no', 0], ['0', 0], ['none', 0], ['not_applicable', 0], ['not applicable', 0]] as const) {
      const { store, node, run } = await fixture();
      await seedHomeAssistantObservation(store, { ...node, metadata: { batteryPowered: value, manualRequired: value } });
      const issues = await run(); expect(issues).toHaveLength(expected);
      expect(issues.every((issue) => (issue.metadata.qualityReading as { origin: string }).origin === 'declared-fields')).toBe(true);
    }
  });
  test('bounded replacement rejects cross-space identity and cannot fabricate review authority', async () => {
    const { store, node } = await fixture();
    await expect(store.replaceIssuesGuarded([{ id: 'bad', nodeId: node.id, code: 'test', severity: 'warning', message: 'Bad space', metadata: { knowledgeSpaceId: 'wiki:other', namespace: homeGraphQualityNamespace(spaceId) } }], homeGraphQualityNamespace(spaceId), () => {})).rejects.toThrow('malformed');
    expect(store.getIssue('bad')).toBeNull();
    const [record] = await store.replaceIssuesGuarded([{ id: 'safe', nodeId: node.id, code: 'test', severity: 'warning', message: 'Ordinary issue', metadata: { knowledgeSpaceId: spaceId, namespace: homeGraphQualityNamespace(spaceId), review: { action: 'reject', reviewer: 'pretend' } } }], homeGraphQualityNamespace(spaceId), () => {});
    expect(record!.metadata.review).toBeUndefined();
  });
});
