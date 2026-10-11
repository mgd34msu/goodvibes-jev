import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import type { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { KnowledgeRepairSourceAuthorityHeldError } from '../sdk/src/platform/knowledge/semantic/repair-source-authority/types.js';
import { KnowledgeRepairSubjectSelectionHeldError } from '../sdk/src/platform/knowledge/semantic/repair-subject-selection/types.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { promoteRepairSources } from '../sdk/src/platform/knowledge/semantic/self-improvement-promotion.js';
import { KnowledgeSourceQualityHeldError } from '../sdk/src/platform/knowledge/source-quality.js';
const spaceId = 'empty-repair-pass';
const roots: string[] = [], stores: KnowledgeStore[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => { installJudgmentPort(previous); for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'repair-empty-work-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store);
  const deviceInput = { id: 'device', kind: 'ha_device' as const, slug: 'device', title: 'Living room display', status: 'active' as const,
    metadata: { knowledgeSpaceId: spaceId } };
  const device = await upsertObservedKnowledgeNode(store, deviceInput, 'home-assistant-snapshot', deviceInput, () => deviceInput);
  const gapInput = { id: 'gap', kind: 'knowledge_gap' as const, slug: 'gap', title: 'Display inputs', status: 'active' as const,
    metadata: { knowledgeSpaceId: spaceId, linkedObjectIds: [device.id] } };
  const gap = await upsertObservedKnowledgeNode(store, gapInput, 'research-task', gapInput, () => gapInput);
  const source = await store.upsertSource({ id: 'pending-text', connectorId: 'synthetic', sourceType: 'manual', status: 'indexed',
    title: 'Awaiting extracted text', metadata: { knowledgeSpaceId: spaceId } });
  const task = await store.upsertRefinementTask({ spaceId, gapId: gap.id, state: 'applying', trigger: 'manual' });
  return { store, gap, source, task };
}
describe('mechanically empty repair work', () => {
  test('absent extracted entries and fact candidates count zero without asking subject meaning or claiming repair completion', async () => {
    const item = await fixture(); let requests = 0;
    installJudgmentPort({ model: 'must-not-read', async ask() { requests++; throw new Error('No semantic work exists'); } });
    const beforeNodes = item.store.listNodes(), beforeSource = item.store.getSource(item.source.id);
    const result = await promoteRepairSources({ store: item.store }, spaceId, item.gap, [item.source.id], item.task, Date.now() + 5_000);
    expect(result).toEqual({ promotedFactCount: 0, repairComplete: false, promotedSourceIds: [item.source.id] });
    expect(requests).toBe(0); expect(item.store.listEdges()).toEqual([]);
    expect(item.store.listNodes()).toEqual(beforeNodes); expect(item.store.getSource(item.source.id)).toBe(beforeSource);
    expect(item.store.getRefinementTask(item.task.id)?.state).toBe('applying');
    expect(item.store.getRefinementTask(item.task.id)?.promotedFactCount).toBe(0);
  });
  test('replacement then restoration cannot revive an empty-count admission before bookkeeping', async () => {
    const item = await fixture(); let requests = 0;
    installJudgmentPort({ model: 'must-not-read', async ask() { requests++; throw new Error('No semantic work exists'); } });
    const batch = item.store.batch.bind(item.store); let changed = false;
    item.store.batch = async callback => {
      if (!changed) {
        changed = true;
        await item.store.replaceSourceRecord({ ...item.source, summary: 'Temporary replacement' });
        await item.store.replaceSourceRecord(item.source);
      }
      return batch(callback);
    };
    const beforeTask = item.store.getRefinementTask(item.task.id);
    const error: unknown = await promoteRepairSources({ store: item.store }, spaceId, item.gap, [item.source.id], item.task, Date.now() + 5_000).catch(error => error);
    expect(error).toBeInstanceOf(KnowledgeRepairSourceAuthorityHeldError);
    expect((error as KnowledgeRepairSourceAuthorityHeldError).reason).toBe('stale');
    expect(changed).toBe(true); expect(requests).toBe(0); expect(item.store.listEdges()).toEqual([]);
    expect(item.store.getRefinementTask(item.task.id)).toEqual(beforeTask);
    expect(item.store.getSource(item.source.id)).toEqual(item.source);
    expect(item.store.getSource(item.source.id)).not.toBe(item.source);
  });
  test('normalized legacy source membership cannot be miscounted as mechanically empty', async () => {
    const item = await fixture();
    const draft = await item.store.upsertNode({ id: 'legacy-fact', kind: 'fact', slug: 'legacy-fact', title: 'Display input', status: 'draft',
      metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', factKind: 'specification', subjectIds: ['device'] } });
    // Historical persisted rows may carry whitespace in the raw source_id. The
    // existing count collector normalizes that field even though link collection
    // uses exact IDs. Keep both memberships; do not silently return zero.
    const sql = (item.store as unknown as { sqlite: SQLiteStore }).sqlite;
    sql.run("UPDATE knowledge_nodes SET source_id = ?, status = 'active' WHERE id = ?", [`  ${item.source.id}  `, draft.id]);
    await sql.save(); await item.store.close();
    const store = new KnowledgeStore({ dbPath: item.store.storagePath }); stores.push(store); await store.init();
    expect(store.getNode(draft.id)?.sourceId).toBe(`  ${item.source.id}  `);
    let requests = 0;
    installJudgmentPort({ model: 'hold-subject-selection', async ask(request) {
      expect(Object.keys(request.questions)).toEqual(['repairSubjectSelected']); requests++; throw new Error('Canonical subject unavailable');
    } });
    const task = store.getRefinementTask(item.task.id)!, gap = store.getNode(item.gap.id)!;
    await expect(promoteRepairSources({ store }, spaceId, gap, [item.source.id], task, Date.now() + 5_000))
      .rejects.toBeInstanceOf(KnowledgeRepairSubjectSelectionHeldError);
    expect(requests).toBe(1); expect(store.listEdges()).toEqual([]); expect(store.getRefinementTask(task.id)).toEqual(task);
  });
  test('zero-work observation cannot survive source replacement before final task bookkeeping', async () => {
    const item = await fixture(); let requests = 0;
    installJudgmentPort({ model: 'must-not-read', async ask() { requests++; throw new Error('No semantic work exists'); } });
    const batch = item.store.batch.bind(item.store); let changed = false;
    item.store.batch = async callback => {
      if (!changed) { changed = true; await item.store.replaceSourceRecord({ ...item.source, summary: 'Concurrent new source observation' }); }
      return batch(callback);
    };
    const beforeTask = item.store.getRefinementTask(item.task.id);
    await expect(promoteRepairSources({ store: item.store }, spaceId, item.gap, [item.source.id], item.task, Date.now() + 5_000))
      .rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
    expect(changed).toBe(true); expect(requests).toBe(0); expect(item.store.listEdges()).toEqual([]);
    expect(item.store.getRefinementTask(item.task.id)).toEqual(beforeTask);
    expect(item.store.getSource(item.source.id)?.summary).toBe('Concurrent new source observation');
  });
});
