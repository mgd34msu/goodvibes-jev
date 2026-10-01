import { describe, expect, test } from 'bun:test';
import type { ApprovalRecord, FleetProcessNode } from './goodvibes';
import {
  activeCount,
  approvalsForNode,
  attemptGroupIds,
  attemptGroupRef,
  attentionCount,
  attentionReasonLabel,
  buildFleetRows,
  costLabel,
  readHeadline,
  readStallTell,
  stallTellLabel,
  formatDurationMs,
  isAwaitingApprovalState,
  isKnownProcessKind,
  isKnownProcessState,
  isStalledState,
  isTerminalState,
  kindLabel,
  needsAttention,
  stateLabel,
  unbackedCapabilityNote,
  wireBackedActions,
} from './fleet';

function node(overrides: Partial<FleetProcessNode> & { id: string }): FleetProcessNode {
  return {
    kind: 'agent',
    label: overrides.id,
    state: 'thinking',
    elapsedMs: 0,
    costUsd: null,
    costState: 'unpriced',
    capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: true },
    ...overrides,
  };
}

describe('isKnownProcessKind / isKnownProcessState', () => {
  test('known kinds/states return true', () => {
    expect(isKnownProcessKind('agent')).toBe(true);
    expect(isKnownProcessKind('workflow')).toBe(true);
    expect(isKnownProcessState('thinking')).toBe(true);
    expect(isKnownProcessState('stalled')).toBe(true);
  });

  test('an unknown future kind/state is NOT known; rendered verbatim, not dropped', () => {
    expect(isKnownProcessKind('quantum-process')).toBe(false);
    expect(isKnownProcessState('quantum-state')).toBe(false);
  });
});

describe('kindLabel / stateLabel', () => {
  test('empty string falls back to a non-blank label', () => {
    expect(kindLabel('').length).toBeGreaterThan(0);
    expect(stateLabel('').length).toBeGreaterThan(0);
  });

  test('non-empty values render verbatim', () => {
    expect(kindLabel('contract')).toBe('contract');
    expect(stateLabel('awaiting-approval')).toBe('awaiting-approval');
  });
});

describe('isTerminalState / isStalledState / isAwaitingApprovalState', () => {
  test('done/failed/killed/interrupted are terminal', () => {
    for (const s of ['done', 'failed', 'killed', 'interrupted']) expect(isTerminalState(s)).toBe(true);
  });

  test('thinking/executing-tool/stalled are NOT terminal', () => {
    for (const s of ['thinking', 'executing-tool', 'stalled', 'awaiting-approval']) expect(isTerminalState(s)).toBe(false);
  });

  test('stalled/awaiting-approval flags', () => {
    expect(isStalledState('stalled')).toBe(true);
    expect(isStalledState('thinking')).toBe(false);
    expect(isAwaitingApprovalState('awaiting-approval')).toBe(true);
    expect(isAwaitingApprovalState('stalled')).toBe(false);
  });
});

describe('costLabel', () => {
  test('unpriced state never shows a dollar figure, even if costUsd is somehow set', () => {
    const label = costLabel(node({ id: 'n1', costState: 'unpriced', costUsd: 1.23 }));
    expect(label).not.toContain('$');
    expect(label).not.toContain('1.23');
  });

  test('priced state with a costUsd shows a dollar figure', () => {
    expect(costLabel(node({ id: 'n1', costState: 'priced', costUsd: 1.5 }))).toBe('$1.50');
  });

  test('priced state with a sub-dollar amount shows 4 decimal places', () => {
    expect(costLabel(node({ id: 'n1', costState: 'priced', costUsd: 0.0032 }))).toBe('$0.0032');
  });

  test('estimated state prefixes with a tilde', () => {
    expect(costLabel(node({ id: 'n1', costState: 'estimated', costUsd: 2 }))).toBe('~$2.00');
  });

  test('estimated state with no costUsd yet shows "estimating…" rather than a fake number', () => {
    expect(costLabel(node({ id: 'n1', costState: 'estimated', costUsd: null }))).not.toContain('$');
  });

  test('costUsd entirely absent (undefined, per the SDK contract, not just null) never throws', () => {
    const { costUsd: _omit, ...rest } = node({ id: 'n1', costState: 'priced', costUsd: 5 });
    expect(costLabel(rest as FleetProcessNode)).not.toContain('$');
  });

  test('estimated state with costUsd undefined (not null) still shows "estimating…", no throw', () => {
    const { costUsd: _omit, ...rest } = node({ id: 'n1', costState: 'estimated', costUsd: 5 });
    expect(costLabel(rest as FleetProcessNode)).not.toContain('$');
  });
});

describe('formatDurationMs', () => {
  test('formats seconds', () => {
    expect(formatDurationMs(45_000)).toBe('45s');
  });

  test('formats minutes and seconds', () => {
    expect(formatDurationMs(125_000)).toBe('2m 5s');
  });

  test('formats hours and minutes', () => {
    expect(formatDurationMs(3_725_000)).toBe('1h 2m');
  });

  test('non-finite/negative/undefined is honestly "unknown", never 0s', () => {
    const unknown = formatDurationMs(undefined);
    expect(unknown).not.toContain('0s');
    expect(formatDurationMs(-5)).toBe(unknown);
    expect(formatDurationMs(NaN)).toBe(unknown);
  });
});

describe('activeCount', () => {
  test('counts only non-terminal nodes', () => {
    const nodes = [
      node({ id: 'a', state: 'thinking' }),
      node({ id: 'b', state: 'done' }),
      node({ id: 'c', state: 'stalled' }),
      node({ id: 'd', state: 'killed' }),
    ];
    expect(activeCount(nodes)).toBe(2);
  });
});

describe('buildFleetRows', () => {
  test('a flat list with no parentId is all roots at depth 0', () => {
    const nodes = [node({ id: 'a' }), node({ id: 'b' })];
    const rows = buildFleetRows(nodes);
    expect(rows.map((r) => r.depth)).toEqual([0, 0]);
    expect(rows.map((r) => r.node.id).sort()).toEqual(['a', 'b']);
  });

  test('children are nested immediately after their parent, at depth+1', () => {
    const nodes = [
      node({ id: 'root', startedAt: 100 }),
      node({ id: 'child', parentId: 'root', startedAt: 90 }),
      node({ id: 'grandchild', parentId: 'child', startedAt: 80 }),
    ];
    const rows = buildFleetRows(nodes);
    expect(rows.map((r) => r.node.id)).toEqual(['root', 'child', 'grandchild']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
  });

  test('a parentId pointing outside the snapshot is treated as a root (not dropped)', () => {
    const nodes = [node({ id: 'orphan', parentId: 'not-in-snapshot' })];
    const rows = buildFleetRows(nodes);
    expect(rows).toHaveLength(1);
    expect(rows[0].depth).toBe(0);
  });

  test('roots and sibling groups sort newest-started-first', () => {
    const nodes = [
      node({ id: 'old-root', startedAt: 10 }),
      node({ id: 'new-root', startedAt: 20 }),
    ];
    const rows = buildFleetRows(nodes);
    expect(rows.map((r) => r.node.id)).toEqual(['new-root', 'old-root']);
  });

  test('a parentId cycle degrades to a flat list instead of hanging', () => {
    const nodes = [
      node({ id: 'a', parentId: 'b' }),
      node({ id: 'b', parentId: 'a' }),
    ];
    const rows = buildFleetRows(nodes);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.node.id).sort()).toEqual(['a', 'b']);
  });

  test('every node in the input appears exactly once in the output', () => {
    const nodes = [
      node({ id: 'r1' }),
      node({ id: 'r2' }),
      node({ id: 'c1', parentId: 'r1' }),
      node({ id: 'c2', parentId: 'r1' }),
      node({ id: 'gc1', parentId: 'c1' }),
    ];
    const rows = buildFleetRows(nodes);
    expect(rows).toHaveLength(nodes.length);
    expect(new Set(rows.map((r) => r.node.id)).size).toBe(nodes.length);
  });

  test('a needsAttention node floats to the TOP of its sibling group, ahead of a newer one', () => {
    const nodes = [
      node({ id: 'newer', startedAt: 100 }),
      node({ id: 'blocked', startedAt: 10, needsAttention: { reason: 'input' } }),
      node({ id: 'oldest', startedAt: 5 }),
    ];
    const rows = buildFleetRows(nodes);
    // Without attention, recency would give newer, oldest, blocked. Attention floats
    // 'blocked' to the front of the root group even though it started earliest.
    expect(rows.map((r) => r.node.id)).toEqual(['blocked', 'newer', 'oldest']);
  });

  test('attention-first sorting is scoped to a sibling group, not across the tree', () => {
    const nodes = [
      node({ id: 'root-a', startedAt: 100 }),
      node({ id: 'root-b', startedAt: 90 }),
      node({ id: 'child-b', parentId: 'root-b', startedAt: 80, needsAttention: { reason: 'approval' } }),
    ];
    const rows = buildFleetRows(nodes);
    // The blocked child stays nested under root-b (depth 1), it does not jump to
    // the top of the whole tree, only ahead of its own siblings (it has none here).
    expect(rows.map((r) => r.node.id)).toEqual(['root-a', 'root-b', 'child-b']);
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 1]);
  });
});

describe('attention (needs-a-human) helpers', () => {
  test('needsAttention reflects the daemon-derived marker, absent → false', () => {
    expect(needsAttention(node({ id: 'a' }))).toBe(false);
    expect(needsAttention(node({ id: 'b', needsAttention: { reason: 'input' } }))).toBe(true);
  });

  test('attentionCount counts only flagged nodes', () => {
    const nodes = [
      node({ id: 'a' }),
      node({ id: 'b', needsAttention: { reason: 'input' } }),
      node({ id: 'c', needsAttention: { reason: 'approval', detail: 'bash' } }),
    ];
    expect(attentionCount(nodes)).toBe(2);
    expect(attentionCount([])).toBe(0);
  });

  // 'pick' and 'conflict' (SDK 1.8.0) are the SAME waiting-on-human class as
  // approval/input, attentionCount already treats every reason identically (it only
  // checks `needsAttention` truthiness), so both are counted with no code change.
  test('attentionCount counts pick and conflict nodes exactly like approval/input', () => {
    const nodes = [
      node({ id: 'a', needsAttention: { reason: 'pick' } }),
      node({ id: 'b', needsAttention: { reason: 'conflict', detail: 'merge conflict in src/foo.ts' } }),
      node({ id: 'c' }),
    ];
    expect(attentionCount(nodes)).toBe(2);
  });

  test('attentionReasonLabel maps known reasons and renders an unknown one verbatim', () => {
    const known = ['approval', 'input', 'pick', 'conflict'].map(attentionReasonLabel);
    expect(new Set(known).size).toBe(known.length);
    expect(attentionReasonLabel('future-reason')).toBe('future-reason');
    expect(attentionReasonLabel('').length).toBeGreaterThan(0);
  });

  test('a pick-blocked node floats to the top of its sibling group exactly like approval/input', () => {
    const nodes = [
      node({ id: 'root-a', startedAt: 100 }),
      node({ id: 'child-a', parentId: 'root-a', startedAt: 10 }),
      node({ id: 'child-b', parentId: 'root-a', startedAt: 90, needsAttention: { reason: 'pick' } }),
    ];
    const rows = buildFleetRows(nodes);
    const childRows = rows.filter((r) => r.node.parentId === 'root-a');
    expect(childRows[0]?.node.id).toBe('child-b');
  });
});

describe('acp-agent node kind (SDK 1.8.0)', () => {
  test('is a known kind; renders with the honest generic KindBadge, not the unknown-kind warning', () => {
    expect(isKnownProcessKind('acp-agent')).toBe(true);
    expect(kindLabel('acp-agent')).toBe('acp-agent');
  });
});

describe('wireBackedActions (WEBUI-FLEET-DEPTH)', () => {
  test('an agent node with a live sessionRef and steerable=true gets steer + detach', () => {
    const n = node({ id: 'a1', kind: 'agent', sessionRef: { sessionId: 's-1', agentId: 'a1' } });
    const actions = wireBackedActions(n);
    expect(actions.has('steer')).toBe(true);
    expect(actions.has('detach')).toBe(true);
    expect(actions.has('stop')).toBe(false);
  });

  test('an agent node with steerable=false (no messageBus) gets detach only, never a fabricated steer', () => {
    const n = node({
      id: 'a1', kind: 'agent', sessionRef: { sessionId: 's-1', agentId: 'a1' },
      capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: false },
    });
    const actions = wireBackedActions(n);
    expect(actions.has('steer')).toBe(false);
    expect(actions.has('detach')).toBe(true);
  });

  test('an agent node with NO sessionRef gets neither steer nor detach', () => {
    const n = node({ id: 'a1', kind: 'agent' });
    const actions = wireBackedActions(n);
    expect(actions.has('steer')).toBe(false);
    expect(actions.has('detach')).toBe(false);
  });

  test('a watcher node with killable=true gets stop, never steer/detach', () => {
    const n = node({
      id: 'w1', kind: 'watcher',
      capabilities: { interruptible: false, killable: true, pausable: false, resumable: false, steerable: false },
    });
    const actions = wireBackedActions(n);
    expect(actions.has('stop')).toBe(true);
    expect(actions.has('steer')).toBe(false);
    expect(actions.has('detach')).toBe(false);
  });

  test('a non-watcher killable node (e.g. contract) never gets stop, no wire verb for it', () => {
    const n = node({
      id: 'c1', kind: 'contract',
      capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: false },
    });
    expect(wireBackedActions(n).has('stop')).toBe(false);
  });
});

describe('unbackedCapabilityNote (WEBUI-FLEET-DEPTH)', () => {
  test('a watcher whose only true capability (killable) IS wire-backed gets no note', () => {
    const n = node({
      id: 'w1', kind: 'watcher',
      capabilities: { interruptible: false, killable: true, pausable: false, resumable: false, steerable: false },
    });
    expect(unbackedCapabilityNote(n)).toBeNull();
  });

  test('an agent (killable/interruptible, no wire verb for either) gets an honest note naming its kind', () => {
    const n = node({ id: 'a1', kind: 'agent' });
    const note = unbackedCapabilityNote(n);
    expect(note).not.toBeNull();
    expect(note).toContain('agent');
  });

  test('a trigger (pausable/resumable, no wire verb) gets an honest note', () => {
    const n = node({
      id: 't1', kind: 'trigger',
      capabilities: { interruptible: false, killable: false, pausable: true, resumable: false, steerable: false },
    });
    expect(unbackedCapabilityNote(n)).toContain('trigger');
  });

  test('a contract group (every capability false) gets no note, nothing to be honest about', () => {
    const n = node({
      id: 'p1', kind: 'contract-group',
      capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false },
    });
    expect(unbackedCapabilityNote(n)).toBeNull();
  });
});

describe('approvalsForNode (WEBUI-FLEET-DEPTH: "approve from the tree")', () => {
  function approval(overrides: Partial<ApprovalRecord> & { id: string }): ApprovalRecord {
    return {
      callId: `call-${overrides.id}`,
      status: 'pending',
      request: {
        callId: `call-${overrides.id}`,
        tool: 'bash',
        args: {},
        category: 'shell',
        analysis: { classification: 'x', riskLevel: 'medium', summary: 'x', reasons: [] },
      },
      createdAt: 1,
      updatedAt: 1,
      metadata: {},
      ...overrides,
    };
  }

  test('matches by sessionId when the node has a live sessionRef', () => {
    const n = node({ id: 'a1', kind: 'agent', sessionRef: { sessionId: 's-1', agentId: 'a1' } });
    const matching = approval({ id: 'appr-1', sessionId: 's-1' });
    const other = approval({ id: 'appr-2', sessionId: 's-2' });
    expect(approvalsForNode(n, [matching, other])).toEqual([matching]);
  });

  test('matches an agent-kind node by metadata.agentId when sessionId is absent on both sides', () => {
    const n = node({ id: 'agent-42', kind: 'agent' });
    const matching = approval({ id: 'appr-1', metadata: { agentId: 'agent-42' } });
    const other = approval({ id: 'appr-2', metadata: { agentId: 'someone-else' } });
    expect(approvalsForNode(n, [matching, other])).toEqual([matching]);
  });

  test('a non-agent node (e.g. contract-unit) never matches via metadata.agentId, even if the id happens to collide', () => {
    const n = node({ id: 'agent-42', kind: 'contract-unit' });
    const wouldMatchIfAgent = approval({ id: 'appr-1', metadata: { agentId: 'agent-42' } });
    expect(approvalsForNode(n, [wouldMatchIfAgent])).toEqual([]);
  });

  test('no match returns an empty array, never throws', () => {
    const n = node({ id: 'a1', kind: 'agent' });
    expect(approvalsForNode(n, [approval({ id: 'appr-1', sessionId: 's-unrelated' })])).toEqual([]);
    expect(approvalsForNode(n, [])).toEqual([]);
  });
});

describe('attemptGroupRef / attemptGroupIds (best-of-N sibling markers, read defensively)', () => {
  test('reads a well-formed attemptGroup marker off an otherwise-untyped node field', () => {
    const n = { ...node({ id: 'a1' }), attemptGroup: { groupId: 'g-1', index: 1, total: 3, held: true } } as FleetProcessNode;
    expect(attemptGroupRef(n)).toEqual({ groupId: 'g-1', index: 1, total: 3, held: true });
  });

  test('returns null when there is no marker (an older daemon omits it), nothing collapses', () => {
    expect(attemptGroupRef(node({ id: 'a1' }))).toBeNull();
    const partial = { ...node({ id: 'a2' }), attemptGroup: { index: 0 } } as FleetProcessNode;
    expect(attemptGroupRef(partial)).toBeNull(); // no groupId → not a usable marker
  });

  test('attemptGroupIds collects the distinct group ids present among the nodes', () => {
    const nodes = [
      { ...node({ id: 'a1' }), attemptGroup: { groupId: 'g-1' } },
      { ...node({ id: 'a2' }), attemptGroup: { groupId: 'g-1' } },
      { ...node({ id: 'a3' }), attemptGroup: { groupId: 'g-2' } },
      node({ id: 'a4' }),
    ] as FleetProcessNode[];
    expect(attemptGroupIds(nodes)).toEqual(new Set(['g-1', 'g-2']));
  });
});

describe('readHeadline / readStallTell / stallTellLabel (read-model tells)', () => {
  test('reads a well-formed headline and stall tell off the open node shape', () => {
    const n = node({
      id: 'n1',
      headline: { text: 'Migrating the store', updatedAt: 100 },
      stall: { since: 1_700_000_000_000, quietForMs: 360_000 },
    } as never);
    expect(readHeadline(n)).toEqual({ text: 'Migrating the store', updatedAt: 100 });
    expect(readStallTell(n)).toEqual({ since: 1_700_000_000_000, quietForMs: 360_000 });
    expect(stallTellLabel({ since: 1_700_000_000_000, quietForMs: 360_000 })).toContain(formatDurationMs(360_000));
  });

  test('absent fields read as null, a pre-tells daemon fabricates nothing', () => {
    expect(readHeadline(node({ id: 'n1' }))).toBeNull();
    expect(readStallTell(node({ id: 'n1' }))).toBeNull();
  });

  test('malformed shapes read as null (wrong types, empty text, negative quiet)', () => {
    expect(readHeadline(node({ id: 'n1', headline: { text: '', updatedAt: 1 } } as never))).toBeNull();
    expect(readHeadline(node({ id: 'n1', headline: { text: 42, updatedAt: 1 } } as never))).toBeNull();
    expect(readHeadline(node({ id: 'n1', headline: 'busy' } as never))).toBeNull();
    expect(readStallTell(node({ id: 'n1', stall: { since: 'x', quietForMs: 1 } } as never))).toBeNull();
    expect(readStallTell(node({ id: 'n1', stall: { since: 1, quietForMs: -5 } } as never))).toBeNull();
  });
});
