import { describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { rankHomeGraphPageCandidates } from '../sdk/src/platform/knowledge/home-graph/page-priority.js';
import { homeGraphPagePriority } from '../sdk/src/platform/knowledge/home-graph/batteries/page-priority.js';
import { useKnowledgeAnswerReadings } from './_helpers/knowledge-answer-readings.js';
import { createHomeGraphService, useHomeGraphFixtures } from './_helpers/homegraph-service-fixtures.js';

const readings = useKnowledgeAnswerReadings();
useHomeGraphFixtures();

async function withPort<T>(port: JudgmentPort | undefined, operation: () => Promise<T>): Promise<T> {
  const previous = installJudgmentPort(port);
  try { return await operation(); } finally { installJudgmentPort(previous); }
}

const rank = <T extends { title: string }>(candidates: readonly T[], signal?: AbortSignal) => rankHomeGraphPageCandidates({
  candidates, content: candidate => candidate, purpose: 'Order useful home references', signal,
});

describe('Home Graph page priority', () => {
  test('reads the complete candidate set, retains settled no rows and preserves ties', async () => {
    const candidates = [{ title: 'TV router appliance' }, { title: 'Home Assistant backup' }, { title: 'Vela' }] as const;
    const port = fakePort((_name, _question, state) => noulAnswer(
      (state as { candidate: { title: string } }).candidate.title === candidates[0]!.title ? 0.01 : 0.99,
    ));
    await withPort(port.port, async () => {
      const ranked = await rank(candidates);
      expect(ranked).toEqual([candidates[1], candidates[2], candidates[0]]);
      expect(port.requests).toHaveLength(3);
      expect(port.requests.every(request => request.context?.site === homeGraphPagePriority.name)).toBe(true);
    });
  });

  test('missing and unsettled readings hold the complete ordering', async () => {
    await withPort(undefined, async () => { await expect(rank([{ title: 'Vela' }])).rejects.toMatchObject({ reason: 'unavailable' }); });
    const port = fakePort(() => noulAnswer(0.5));
    await withPort(port.port, async () => { await expect(rank([{ title: 'Vela' }])).rejects.toMatchObject({ reason: 'uncertain' }); });
  });

  test('a protected later candidate is refused before the first request', async () => {
    const port = fakePort(() => noulAnswer(0.99));
    await withPort(port.port, async () => {
      await expect(rank([{ title: 'Vela' }, { title: 'Backup', metadata: { card: '4111111111111111' } }])).rejects.toMatchObject({ problem: 'card-material' });
      expect(port.requests).toHaveLength(0);
    });
  });

  test('hidden private tails remain part of complete page admission', async () => {
    const port = fakePort(() => noulAnswer(0.99));
    const candidate = Object.defineProperty({ title: 'Vela' }, 'hidden', {
      value: { card: '4111111111111111' }, enumerable: false,
    });
    await withPort(port.port, async () => {
      await expect(rank([candidate])).rejects.toMatchObject({ problem: 'card-material' });
      expect(port.requests).toHaveLength(0);
    });
  });

  test('candidate mutation and model replacement cannot publish an earlier ranking', async () => {
    const candidates = [{ title: 'Vela', description: 'Original description' }];
    const changed = fakePort(() => { candidates[0]!.description = 'Changed description'; return noulAnswer(0.99); });
    await withPort(changed.port, async () => { await expect(rank(candidates)).rejects.toMatchObject({ reason: 'stale' }); });
    const next = fakePort(() => noulAnswer(0.99));
    const retired = fakePort(() => { installJudgmentPort(next.port); return noulAnswer(0.99); });
    await withPort(retired.port, async () => {
      await expect(rank([{ title: 'Vela' }])).rejects.toMatchObject({ reason: 'stale' });
      expect(next.requests).toHaveLength(0);
    });
  });

  test('cancellation interrupts a reader that never settles', async () => {
    const controller = new AbortController();
    let asked = 0;
    let started: () => void = () => {};
    const ready = new Promise<void>(resolve => { started = resolve; });
    const port: JudgmentPort = { model: 'jev-1.13.0', ask: async () => { asked++; started(); return new Promise<never>(() => {}); } };
    await withPort(port, async () => {
      const pending = rank([{ title: 'Vela' }], controller.signal);
      await ready;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ reason: 'aborted' });
      expect(asked).toBe(1);
    });
  });

  test('an unsettled generation ordering publishes no page or artifact', async () => {
    readings.set({ pagePriorityDefault: 0.5 });
    const { service, store, artifactStore } = createHomeGraphService();
    await expect(service.syncSnapshot({ installationId: 'held-ordering', devices: [{ id: 'vela', name: 'Vela' }], pageAutomation: { roomPages: false } }))
      .rejects.toMatchObject({ reason: 'uncertain' });
    expect(store.listSources().filter(source => source.metadata.generatedProjection === true)).toEqual([]);
    expect(store.listNodes().filter(node => node.kind === 'ha_device_passport')).toEqual([]);
    expect(artifactStore.list()).toEqual([]);
  });

  test('generation and display apply their limits after authored useful-reference readings', async () => {
    readings.set({ pagePriority: [['TV router appliance', 0.01], ['Vela', 0.99], ['Vela passport', 0.01], ['Home Assistant backup passport', 0.99]] });
    const { service } = createHomeGraphService();
    const synced = await service.syncSnapshot({ installationId: 'priority-home', devices: [
      { id: 'noise', name: 'TV router appliance' }, { id: 'unfamiliar', name: 'Vela' },
    ], pageAutomation: { maxDevicePassports: 1, roomPages: false } });
    expect(synced.generated.devicePassports).toBe(1);
    const initial = await service.listPages({ installationId: 'priority-home', includeMarkdown: false });
    expect(initial.pages.map(page => page.source.title)).toEqual(['Vela passport']);
    await service.syncSnapshot({ installationId: 'priority-home', devices: [
      { id: 'unfamiliar', name: 'Vela' }, { id: 'backup', name: 'Home Assistant backup' },
    ], pageAutomation: { enabled: false } });
    await service.refreshDevicePassport({ installationId: 'priority-home', deviceId: 'backup' });
    const start = readings.requests.length;
    const listed = await service.listPages({ installationId: 'priority-home', limit: 1, includeMarkdown: false });
    expect(listed.pages.map(page => page.source.title)).toEqual(['Home Assistant backup passport']);
    const priorityCalls = readings.requests.slice(start).filter(request => request.context?.site === homeGraphPagePriority.name);
    expect(priorityCalls).toHaveLength(2);
  });
});
