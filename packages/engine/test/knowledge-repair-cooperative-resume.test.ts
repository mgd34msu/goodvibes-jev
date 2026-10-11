import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { promoteRepairSources } from '../sdk/src/platform/knowledge/semantic/self-improvement-promotion.js';

const spaceId = 'cooperative-repair-resume';
const roots: string[] = [], stores: KnowledgeStore[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => {
  installJudgmentPort(previous);
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-repair-resume-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store);
  const input = { id: 'gap', kind: 'knowledge_gap' as const, slug: 'gap', title: 'Display inputs',
    metadata: { knowledgeSpaceId: spaceId } };
  const gap = await upsertObservedKnowledgeNode(store, input, 'research-task', input, () => input);
  const source = await store.upsertSource({ id: 'pending-text', connectorId: 'synthetic', sourceType: 'manual',
    title: 'Awaiting extracted text', status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
  const task = await store.upsertRefinementTask({ spaceId, gapId: gap.id, state: 'applying', trigger: 'manual' });
  let requests = 0;
  installJudgmentPort({ model: 'must-not-read', async ask() {
    requests++; throw new Error('Stopped empty repair must not ask a question');
  } });
  const snapshot = () => JSON.stringify({ nodes: store.listNodes(), sources: store.listSources(),
    edges: store.listEdges(), tasks: store.listRefinementTasks() });
  return { store, gap, source, task, snapshot, requests: () => requests };
}

describe('repair passes resume under their original caller', () => {
  test('native timer cancellation before the next pass prevents questions and bookkeeping', async () => {
    const item = await fixture(), before = item.snapshot(), controller = new AbortController();
    const observed = Promise.withResolvers<void>();
    const timer = setTimeout(() => { controller.abort(); observed.resolve(); }, 0);
    try {
      await expect(promoteRepairSources({ store: item.store, shouldStop: () => controller.signal.aborted },
        spaceId, item.gap, [item.source.id], item.task, Date.now() + 5_000))
        .rejects.toMatchObject({ name: 'KnowledgeSourceQualityHeldError', reason: 'aborted' });
      await observed.promise;
      expect(controller.signal.aborted).toBe(true);
      expect(item.requests()).toBe(0);
      expect(item.snapshot()).toBe(before);
      expect(item.store.getRefinementTask(item.task.id)).toBe(item.task);
    } finally {
      clearTimeout(timer);
    }
  });

  test('native timer mutation of the original request cannot become a new pass baseline', async () => {
    const item = await fixture(), before = item.snapshot(), sourceIds = [item.source.id];
    const observed = Promise.withResolvers<void>();
    const timer = setTimeout(() => { sourceIds.push('later-source'); observed.resolve(); }, 0);
    try {
      await expect(promoteRepairSources({ store: item.store },
        spaceId, item.gap, sourceIds, item.task, Date.now() + 5_000))
        .rejects.toMatchObject({ name: 'KnowledgeRepairSourceAuthorityHeldError', reason: 'stale' });
      await observed.promise;
      expect(sourceIds).toEqual([item.source.id, 'later-source']);
      expect(item.requests()).toBe(0);
      expect(item.snapshot()).toBe(before);
      expect(item.store.getRefinementTask(item.task.id)).toBe(item.task);
    } finally {
      clearTimeout(timer);
    }
  });
});
