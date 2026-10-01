/**
 * The Agent's fleet union: this process's registry rows plus the adopted
 * daemon's, over the SDK's poll + local-wins merge policy.
 *
 * Driven through the real seam (a DaemonVerbCaller double), so what is proven
 * here is the binding the sidebar actually reads, not a restatement of the
 * SDK's merge rule.
 */
import { describe, expect, test } from 'bun:test';
import type { DaemonReachability, DaemonVerbCaller } from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import type { ProcessNode } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import { createAgentFleetUnion } from '../../runtime/client/fleet-union.ts';

function nodeOf(id: string, overrides: Partial<ProcessNode> = {}): ProcessNode {
  return {
    id,
    kind: 'agent',
    label: id,
    state: 'running',
    elapsedMs: 0,
    costState: 'unknown',
    capabilities: {},
    ...overrides,
  } as ProcessNode;
}

function verbsDouble(options: {
  reachable?: boolean;
  reason?: string;
  answer?: () => unknown;
}): DaemonVerbCaller & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    probe: (): DaemonReachability => (options.reachable === false
      ? { available: false, reason: options.reason ?? 'no connected host is configured.' }
      : { available: true }),
    invoke: async (method: string) => {
      calls.push(method);
      if (!options.answer) throw new Error('the daemon refused');
      return options.answer();
    },
    calls,
  } as DaemonVerbCaller & { readonly calls: string[] };
}

/** The poller refreshes once on construction; let that microtask settle. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('createAgentFleetUnion', () => {
  test('with no daemon configured the local rows ARE the fleet, and nothing is polled', async () => {
    const verbs = verbsDouble({ reachable: false });
    const union = createAgentFleetUnion({
      local: { nodes: () => [nodeOf('local-1')] },
      verbs,
    });
    await settle();
    expect(union.nodes().map((node) => node.id)).toEqual(['local-1']);
    expect(union.hasDaemonRows()).toBe(false);
    expect(verbs.calls).toEqual([]);
    union.stop();
  });

  test('the daemon\'s rows fill in what this process did not start', async () => {
    const union = createAgentFleetUnion({
      local: { nodes: () => [nodeOf('local-1')] },
      verbs: verbsDouble({ answer: () => ({ nodes: [nodeOf('daemon-1')], capturedAt: 42 }) }),
    });
    await settle();
    expect(union.nodes().map((node) => node.id)).toEqual(['local-1', 'daemon-1']);
    expect(union.hasDaemonRows()).toBe(true);
    union.stop();
  });

  test('a row both halves carry is shown from the local copy: the live one', async () => {
    const union = createAgentFleetUnion({
      local: { nodes: () => [nodeOf('shared', { label: 'live here' })] },
      verbs: verbsDouble({
        answer: () => ({ nodes: [nodeOf('shared', { label: 'stale copy' })], capturedAt: 42 }),
      }),
    });
    await settle();
    expect(union.nodes()).toHaveLength(1);
    expect(union.nodes()[0]?.label).toBe('live here');
    union.stop();
  });

  test('a daemon that cannot answer leaves the local half intact rather than emptying the view', async () => {
    const union = createAgentFleetUnion({
      local: { nodes: () => [nodeOf('local-1')] },
      verbs: verbsDouble({}),
    });
    await settle();
    expect(union.nodes().map((node) => node.id)).toEqual(['local-1']);
    expect(union.hasDaemonRows()).toBe(false);
    union.stop();
  });

  test('the local source is re-read on every call, so live registry changes show up', async () => {
    let local = [nodeOf('local-1')];
    const union = createAgentFleetUnion({
      local: { nodes: () => local },
      verbs: verbsDouble({ answer: () => ({ nodes: [nodeOf('daemon-1')], capturedAt: 42 }) }),
    });
    await settle();
    local = [nodeOf('local-1'), nodeOf('local-2')];
    expect(union.nodes().map((node) => node.id)).toEqual(['local-1', 'local-2', 'daemon-1']);
    union.stop();
  });

  test('stop is idempotent', () => {
    const union = createAgentFleetUnion({
      local: { nodes: () => [] },
      verbs: verbsDouble({ reachable: false }),
    });
    union.stop();
    expect(() => union.stop()).not.toThrow();
  });
});
