import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createMemoryConsolidationGateway } from '../../views/memory-consolidation-gateway.ts';
import { createMemoryModalSurface } from '../../views/modals/memory-modal.ts';
import { tabText } from './modals/modal-surface-test-helpers.ts';

test('the product gateway drives the real modal over HTTP and re-resolves after daemon enablement', async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'memory-receipts-adoption-'));
  const requests: string[] = [];
  let enabled = false;
  let status = 200;
  let pendingProposals = [{ kind: 'stale-delete', ids: ['fixture-memory'], route: '/recall review', reason: 'Fixture retention expired.' }];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return status === 200
      ? Response.json({ receipts: [], pendingProposals })
      : Response.json({ error: 'fixture refused' }, { status });
  } });
  const configManager = { get(key: string) {
    if (key === 'daemon.enabled') return enabled;
    if (key === 'controlPlane.publicBaseUrl') return server.url.toString();
    return undefined;
  } } as unknown as ConfigManager;
  const surface = createMemoryModalSurface({
    memoryRegistry: {
      honestSearch: async () => ({ records: [], mode: 'literal', requestedSemantic: false, indexUnavailableReason: null, caveat: null, recallFiltered: false, excludedFlaggedCount: 0, excludedBelowFloorCount: 0, excludedOutOfWindowCount: 0, totalBeforeRecallFilter: 0, recallFloor: 60 }),
      reviewQueue: async () => [],
    },
    resolveConsolidationGateway: () => createMemoryConsolidationGateway({ configManager, homeDirectory }),
  });
  async function refreshUntil(text: string) {
    surface.onClose?.();
    surface.onOpen?.(() => {});
    for (let n = 0; n < 100; n++) {
      if (tabText(surface.buildView(), 'proposals').includes(text)) return;
      await Bun.sleep(10);
    }
    expect(tabText(surface.buildView(), 'proposals')).toContain(text);
  }
  try {
    expect(requests).toEqual([]);
    await refreshUntil('disabled');
    expect(requests).toEqual([]);
    enabled = true;
    await refreshUntil('Fixture retention expired.');
    expect(requests).toEqual(['GET /api/memory/consolidation/receipts']);
    status = 404;
    await refreshUntil('unavailable');
    expect(tabText(surface.buildView(), 'proposals')).not.toContain('Fixture retention expired.');
    expect(tabText(surface.buildView(), 'proposals')).toContain('404');
    status = 401;
    await refreshUntil('Could not fetch');
    expect(tabText(surface.buildView(), 'proposals')).toContain('401');
    status = 200;
    pendingProposals = [];
    await refreshUntil('No pending proposals');
    expect(requests.every(request => request === 'GET /api/memory/consolidation/receipts')).toBe(true);
  } finally {
    surface.onClose?.();
    server.stop(true);
    rmSync(homeDirectory, { recursive: true, force: true });
  }
});
