import { describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { handleRecallQueue } from '../../input/commands/recall-review.ts';

function makeContext(
  printed: string[],
  options: {
    queue?: ReadonlyArray<{ id: string; scope: string; cls: string; summary: string; reviewState: string; confidence: number; staleReason?: string }>;
    proposals?: ReadonlyArray<{ kind: 'contradiction' | 'cross-scope-duplicate' | 'stale-delete'; ids: readonly string[]; route: string; reason: string }>;
    withMemoryConsolidationClient?: boolean;
  } = {},
): CommandContext {
  const queue = options.queue ?? [];
  const proposals = options.proposals ?? [];
  return {
    session: { conversationManager: {} as never, runtime: {} as never },
    provider: { providerRegistry: {} as never },
    workspace: {} as never,
    platform: { config: {} as never, configManager: {} as never },
    ops: {},
    extensions: { toolRegistry: {} as never, mcpRegistry: {} as never },
    clients: {
      agentKnowledgeApi: {
        memory: {
          reviewQueue: () => queue,
        } as never,
      } as never,
      ...(options.withMemoryConsolidationClient === false
        ? {}
        : { memoryConsolidation: { listPendingProposals: () => proposals } }),
    },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  } as unknown as CommandContext;
}

describe('handleRecallQueue (memory review surface)', () => {
  test('an empty queue and no proposals prints the honest empty message', () => {
    const printed: string[] = [];
    handleRecallQueue([], makeContext(printed));
    expect(printed).toEqual(['[memory] Review queue is empty.']);
  });

  test('lists queued records as before when there are no pending proposals', () => {
    const printed: string[] = [];
    handleRecallQueue([], makeContext(printed, {
      queue: [{ id: 'mem-1', scope: 'project', cls: 'fact', summary: 'deploys run on Fridays', reviewState: 'contradicted', confidence: 40 }],
    }));
    expect(printed[0]).toBe('[memory] Review queue (1):');
    expect(printed.some((line) => line.includes('mem-1'))).toBe(true);
    expect(printed.some((line) => line.includes('Pending consolidation proposals'))).toBe(false);
  });

  test('surfaces pending consolidation proposals alongside the review queue, legible and jumpable', () => {
    const printed: string[] = [];
    handleRecallQueue([], makeContext(printed, {
      queue: [{ id: 'mem-1', scope: 'project', cls: 'fact', summary: 'deploys run on Fridays', reviewState: 'contradicted', confidence: 40 }],
      proposals: [{ kind: 'contradiction', ids: ['mem-1', 'mem-2'], route: '/memory/review', reason: 'mem-1 and mem-2 disagree' }],
    }));
    const text = printed.join('\n');
    expect(text).toContain('[memory] Review queue (1):');
    expect(text).toContain('[memory] Pending consolidation proposals (1):');
    expect(text).toContain('contradiction');
    expect(text).toContain('mem-1 and mem-2 disagree');
    expect(text).toContain('/memory review mem-1');
  });

  test('proposals appear even when the review queue itself is empty (a proposal with no other queue entries)', () => {
    const printed: string[] = [];
    handleRecallQueue([], makeContext(printed, {
      queue: [],
      proposals: [{ kind: 'stale-delete', ids: ['mem-7'], route: '/memory/review', reason: 'never referenced' }],
    }));
    const text = printed.join('\n');
    expect(text).toContain('[memory] Review queue is empty.');
    expect(text).toContain('[memory] Pending consolidation proposals (1):');
    expect(text).toContain('mem-7');
  });

  test('an entrypoint that never wires clients.memoryConsolidation degrades gracefully (no crash, no phantom section)', () => {
    const printed: string[] = [];
    handleRecallQueue([], makeContext(printed, {
      queue: [{ id: 'mem-1', scope: 'project', cls: 'fact', summary: 'x', reviewState: 'fresh', confidence: 60 }],
      withMemoryConsolidationClient: false,
    }));
    const text = printed.join('\n');
    expect(text).toContain('mem-1');
    expect(text).not.toContain('Pending consolidation proposals');
  });
});
