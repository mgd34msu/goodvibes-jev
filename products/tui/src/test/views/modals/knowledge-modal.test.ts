import { describe, test, expect } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { redactSensitiveDataAsync } from '@goodvibes-jev/engine/sdk/platform/utils';
import { createKnowledgeModalSurface, type KnowledgeModalDeps } from '../../../views/modals/knowledge-modal.ts';
import { actionCtx, captureCommands, findAction, open, tabText } from './modal-surface-test-helpers.ts';

function fixedDeps(): KnowledgeModalDeps {
  return {
    knowledgeApi: {
      graph: {
        nodes: { list: async () => [{ id: 'node-1', kind: 'topic', title: 'Release cadence', summary: 'Batched releases.' }] },
        issues: { list: async () => [
          { id: 'issue-1', severity: 'warning', code: 'stale-source', message: 'Recrawl overdue.', status: 'open', sourceId: 'source-1' },
          { id: 'issue-2', severity: 'error', code: 'broken-link', message: 'Link 404s.', status: 'resolved' },
        ] },
      },
      sources: { list: async () => [{ id: 'source-1', sourceType: 'repo', status: 'indexed', title: 'goodvibes-tui', summary: 'Primary repo.' }] },
      jobs: { schedules: { list: () => [{ id: 'sched-1', label: 'Nightly reindex', enabled: true }] } },
    },
  };
}

describe('knowledge modal surface', () => {
  test('surface identity', () => { expect(createKnowledgeModalSurface(fixedDeps()).name).toBe('knowledge-modal'); });

  test('Browse tab lists sources/nodes/issues with counts + readiness; Review tab holds the open queue', async () => {
    const surface = createKnowledgeModalSurface(fixedDeps());
    open(surface);
    await surface.whenLoaded();
    const view = surface.buildView();
    expect(view.tabs.map((t) => t.id)).toEqual(['browse', 'review']);
    const browse = tabText(view, 'browse');
    expect(browse).toContain('sources 1  nodes 1  issues 2');
    expect(browse).toContain('retrieval ready');
    expect(browse).toContain('goodvibes-tui');
    expect(browse).toContain('Release cadence');
    expect(browse).toContain('Nightly reindex');
    expect(view.tabs[0]!.rows.map((r) => r.id)).toEqual(['source:source-1', 'node:node-1', 'issue:issue-1', 'issue:issue-2', 'sched:title', 'sched:0']);
    const review = view.tabs.find((t) => t.id === 'review')!;
    expect(review.rows.map((r) => r.id)).toEqual(['issue:issue-1']); // resolved issue excluded
  });

  test('review actions route to /knowledge review-issue, gated to the Review tab + issue rows', () => {
    const surface = createKnowledgeModalSurface(fixedDeps());
    open(surface);
    const row = { id: 'issue:issue-1', label: '' };
    expect(findAction(surface, 'accept')?.enabledFor?.(row, 'browse')).toBe(false);
    expect(findAction(surface, 'accept')?.enabledFor?.(row, 'review')).toBe(true);
    const cap = captureCommands();
    surface.onAction?.('accept', actionCtx(row, cap.extra));
    expect(cap.calls).toEqual([['knowledge', ['review-issue', 'issue-1', 'accept', '--reviewer', 'tui']]]);
  });

  test('openMemory cross-opens the memory-modal surface', () => {
    const surface = createKnowledgeModalSurface(fixedDeps());
    open(surface);
    const opened: string[] = [];
    surface.onAction?.('openMemory', actionCtx(null, { openModal: (n) => opened.push(n) }));
    expect(opened).toEqual(['memory-modal']);
  });

  test('load failure renders an honest degraded state', async () => {
    const previous = installJudgmentPort(fakePort((name, question) => {
      if (question.type !== 'noul') throw new Error('Unexpected graph error redaction fixture');
      return noulAnswer(name === 'identifying' ? 0.99 : 0.01);
    }).port);
    try {
      expect(await redactSensitiveDataAsync('graph unavailable')).toBe('graph unavailable');
      const surface = createKnowledgeModalSurface({
        knowledgeApi: {
          graph: { nodes: { list: async () => { throw new Error('graph unavailable'); } }, issues: { list: async () => [] } },
          sources: { list: async () => [] }, jobs: { schedules: { list: () => [] } },
        },
      });
      open(surface);
      await surface.whenLoaded();
      const view = surface.buildView();
      expect(view.degraded).toContain('Knowledge graph load failed');
      expect(view.degraded).toContain('graph unavailable');
    } finally { installJudgmentPort(previous); }
  });

  test('closing the modal cancels source ownership and ignores a late result', async () => {
    const deps = fixedDeps();
    const delayed = Promise.withResolvers<Awaited<ReturnType<typeof deps.knowledgeApi.graph.nodes.list>>>();
    let readingSignal: AbortSignal | undefined;
    let repaints = 0;
    const surface = createKnowledgeModalSurface({ knowledgeApi: {
      ...deps.knowledgeApi,
      graph: { ...deps.knowledgeApi.graph, nodes: { list: async (_limit, options) => {
        readingSignal = options?.signal;
        return delayed.promise;
      } } },
    } });
    surface.onOpen?.(() => repaints++);
    expect(tabText(surface.buildView(), 'browse')).toContain('Loading knowledge graph');
    const pending = surface.whenLoaded();
    surface.onClose?.();
    expect(readingSignal?.aborted).toBe(true);
    delayed.resolve([{ id: 'late', title: 'Retired result', kind: 'topic' }]);
    await pending;
    expect(repaints).toBe(0);
    expect(tabText(surface.buildView(), 'browse')).not.toContain('Retired result');
  });

  test('a refreshed source wins over an older uncooperative request', async () => {
    const deps = fixedDeps();
    const delayed = Promise.withResolvers<Awaited<ReturnType<typeof deps.knowledgeApi.graph.nodes.list>>>();
    let reads = 0;
    let oldSignal: AbortSignal | undefined;
    const surface = createKnowledgeModalSurface({ knowledgeApi: {
      ...deps.knowledgeApi,
      graph: { ...deps.knowledgeApi.graph, nodes: { list: async (_limit, options) => {
        if (++reads === 1) { oldSignal = options?.signal; return delayed.promise; }
        return [{ id: 'current', title: 'Current source', kind: 'topic' }];
      } } },
    } });
    surface.onOpen?.(() => {});
    const older = surface.whenLoaded();
    surface.onAction?.('refresh', actionCtx(null));
    await surface.whenLoaded();
    expect(oldSignal?.aborted).toBe(true);
    expect(tabText(surface.buildView(), 'browse')).toContain('Current source');
    delayed.resolve([{ id: 'late', title: 'Retired source', kind: 'topic' }]);
    await older;
    expect(tabText(surface.buildView(), 'browse')).toContain('Current source');
    expect(tabText(surface.buildView(), 'browse')).not.toContain('Retired source');
    surface.onClose?.();
  });
});
