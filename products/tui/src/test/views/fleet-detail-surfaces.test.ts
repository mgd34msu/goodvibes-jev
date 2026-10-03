// ---------------------------------------------------------------------------
// fleet-detail-surfaces.test.ts, the in-view review checklist (7b) and the
// task-graph edges/pool posture (7c) rendered under a chain/workstream row.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { ProcessNode } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import { renderFleetDetailLines, renderGraphPostureLines } from '../../views/fleet-format.ts';
import type { WorkstreamGraphSnapshot } from '../../views/workstream-graph-render.ts';
import { FleetActs, type FleetDiffSurface } from '../../views/fleet-acts.ts';
import type { FleetGateway, FleetGraphSnapshot } from '../../views/fleet-gateway.ts';
import { contractFixture } from '../helpers/contract-work-tree-fixtures.ts';
import { lineToString } from '../setup.ts';

const text = (lines: ReturnType<typeof renderGraphPostureLines>): string => lines.map(lineToString).join('\n');

const graph: WorkstreamGraphSnapshot = {
  workstreamId: 'ws-1',
  title: 'ship the feature',
  nodes: [
    { id: 'a', title: 'schema', state: 'done', files: [], orphaned: false, remainingDepth: 0, stalled: false } as WorkstreamGraphSnapshot['nodes'][number],
    { id: 'b', title: 'API', state: 'running', files: [], orphaned: false, remainingDepth: 1, stalled: false } as WorkstreamGraphSnapshot['nodes'][number],
  ],
  edges: [{ from: 'a', to: 'b' }],
  pool: { ready: 1, running: 1, atCap: true, capKey: 'fleet.maxSize', maxSize: 2 } as WorkstreamGraphSnapshot['pool'],
};

describe('task-graph posture render (7c)', () => {
  test('renders the pool posture and the dependency edges by title', () => {
    const t = text(renderGraphPostureLines(graph, 100));
    expect(t).toContain('1 ready, 1 running');
    expect(t).toContain('at cap (fleet.maxSize=2)');
    expect(t).toContain('1 dependency link(s)');
    expect(t).toContain('schema → API');
  });

  test('an edgeless graph states so honestly', () => {
    const t = text(renderGraphPostureLines({ ...graph, edges: [] }, 100));
    expect(t).toContain('no dependency edges');
  });
});

describe('fleet-acts graph fetch/cache (7c wiring)', () => {
  function makeActs(getGraph: FleetGateway['getGraph'], available = true) {
    const gateway = { getGraph } as unknown as FleetGateway;
    const acts = new FleetActs({
      resolveGateway: () => (available ? { available: true, gateway } : { available: false, reason: 'daemon off' }),
      diffSurface: { show: () => {}, armConfirm: () => {}, close: () => {} } as FleetDiffSurface,
      notify: () => {},
      markDirty: () => {},
      findNode: () => null,
    });
    return acts;
  }
  const contract = contractFixture({ id: 'ctr' });
  const wsNode: ProcessNode = { id: 'group:ctr:g1', kind: 'contract-group', label: 'group', state: 'done', elapsedMs: 0, costState: 'unpriced', capabilities: { interruptible: false, killable: false, resumable: false, pausable: false, steerable: false }, raw: { contract, group: contract.groups[0] } };

  test('ensureGraphFor fetches once and caches; graphFor returns the snapshot', async () => {
    let calls = 0;
    const acts = makeActs(async () => { calls += 1; return graph as unknown as FleetGraphSnapshot; });
    acts.ensureGraphFor(wsNode);
    acts.ensureGraphFor(wsNode); // second call must not refetch (in-flight/cache guard)
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toBe(1);
    expect(acts.graphFor(wsNode.id)).toBeTruthy();
  });

  test('a non-workstream node never triggers a fetch', () => {
    let calls = 0;
    const acts = makeActs(async () => { calls += 1; return graph as unknown as FleetGraphSnapshot; });
    acts.ensureGraphFor({ id: 'agent:1', kind: 'agent' } as ProcessNode);
    expect(calls).toBe(0);
    expect(acts.graphFor('agent:1')).toBeUndefined();
  });

  test('an unavailable daemon caches null (no per-frame nag)', () => {
    const acts = makeActs(async () => graph as unknown as FleetGraphSnapshot, false);
    acts.ensureGraphFor(wsNode);
    expect(acts.graphFor(wsNode.id)).toBeNull();
  });
});
