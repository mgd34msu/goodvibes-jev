/**
 * Unit tests for the honest-lineage view model (lineage.ts).
 *
 * The daemon retains superseded messages (regenerate/edit fork history) in the message
 * list, flagged with supersededAt/supersededReason, and links an edited replacement back
 * to its original via revisionOf. buildLineage must turn that flat, server-authoritative
 * list into a render model where the active conversation reads cleanly AND every
 * superseded message stays attached and viewable, never silently dropped.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildLineage,
  isSuperseded,
  lineageNodeKey,
  revisionOf,
  retainedHistoryLabel,
  supersededReason,
} from './lineage';
import type { ChatMessage } from './types';
import type { LineageNode } from './lineage';

function msg(id: string, role: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, content, sessionId: 's1', createdAt: 1_000, ...extra };
}

describe('superseded accessors', () => {
  test('isSuperseded reads a numeric supersededAt', () => {
    expect(isSuperseded(msg('a', 'assistant', 'x', { supersededAt: 123 }))).toBe(true);
    expect(isSuperseded(msg('a', 'assistant', 'x', { supersededAt: 0 }))).toBe(false);
    expect(isSuperseded(msg('a', 'assistant', 'x'))).toBe(false);
  });

  test('isSuperseded also accepts an ISO-string supersededAt', () => {
    expect(isSuperseded(msg('a', 'assistant', 'x', { supersededAt: '2026-07-06T00:00:00Z' }))).toBe(true);
    expect(isSuperseded(msg('a', 'assistant', 'x', { supersededAt: '' }))).toBe(false);
  });

  test('supersededReason normalizes to the known reasons', () => {
    expect(supersededReason(msg('a', 'assistant', 'x', { supersededReason: 'regenerate' }))).toBe('regenerate');
    expect(supersededReason(msg('a', 'user', 'x', { supersededReason: 'edit' }))).toBe('edit');
    expect(supersededReason(msg('a', 'user', 'x'))).toBe('unknown');
  });

  test('revisionOf reads the forward lineage link', () => {
    expect(revisionOf(msg('u2', 'user', 'x', { revisionOf: 'u1' }))).toBe('u1');
    expect(revisionOf(msg('u2', 'user', 'x'))).toBe('');
  });
});

describe('buildLineage', () => {
  test('a plain conversation has no retained history', () => {
    const nodes = buildLineage([
      msg('u1', 'user', 'Hello'),
      msg('a1', 'assistant', 'Hi there'),
    ]);
    expect(nodes.length).toBe(2);
    expect(nodes[0].priorMessages.length).toBe(0);
    expect(nodes[0].reason).toBeUndefined();
    expect(nodes[1].priorMessages.length).toBe(0);
  });

  test('a regenerate attaches the superseded response to the new active response', () => {
    const nodes = buildLineage([
      msg('u1', 'user', 'Tell me a joke'),
      msg('a1', 'assistant', 'First answer', { supersededAt: 2_000, supersededReason: 'regenerate' }),
      msg('a2', 'assistant', 'Fresh answer'),
    ]);
    // Two active nodes: the user turn and the regenerated (active) assistant response.
    expect(nodes.length).toBe(2);
    expect(nodes[0].message.id).toBe('u1');
    expect(nodes[1].message.id).toBe('a2');
    // The superseded prior response is retained on the new response's node.
    expect(nodes[1].priorMessages.map((m) => m.id)).toEqual(['a1']);
    expect(nodes[1].reason).toBe('regenerate');
  });

  test('an edit attaches the original message AND its reply as retained history', () => {
    const nodes = buildLineage([
      msg('u1', 'user', 'Original question', { supersededAt: 2_000, supersededReason: 'edit' }),
      msg('a1', 'assistant', 'Answer to original', { supersededAt: 2_000, supersededReason: 'edit' }),
      msg('u2', 'user', 'Edited question', { revisionOf: 'u1' }),
      msg('a2', 'assistant', 'Answer to edit'),
    ]);
    // Active chain: the edited user message + its fresh reply.
    expect(nodes.length).toBe(2);
    expect(nodes[0].message.id).toBe('u2');
    expect(nodes[0].revisionOf).toBe('u1');
    // Both the original user message and its old reply are kept, in order.
    expect(nodes[0].priorMessages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(nodes[0].reason).toBe('edit');
    expect(nodes[1].message.id).toBe('a2');
    expect(nodes[1].priorMessages.length).toBe(0);
  });

  test('a trailing superseded run is never dropped; it attaches to the last active node', () => {
    const nodes = buildLineage([
      msg('u1', 'user', 'Hello'),
      msg('a1', 'assistant', 'Reply'),
      msg('a0', 'assistant', 'Orphaned superseded', { supersededAt: 3_000, supersededReason: 'regenerate' }),
    ]);
    expect(nodes.length).toBe(2);
    expect(nodes[1].priorMessages.map((m) => m.id)).toEqual(['a0']);
  });

  test('a list with only superseded messages still surfaces them as viewable history', () => {
    const nodes = buildLineage([
      msg('a1', 'assistant', 'gone-1', { supersededAt: 1, supersededReason: 'regenerate' }),
      msg('a2', 'assistant', 'gone-2', { supersededAt: 2, supersededReason: 'regenerate' }),
    ]);
    // Nothing is lost: the run is surfaced rather than yielding an empty view.
    expect(nodes.length).toBe(1);
    expect(nodes[0].priorMessages.length + 1).toBe(2);
  });
});

describe('retainedHistoryLabel', () => {
  test('edit and regenerate get distinct labels, carrying the count', () => {
    expect(retainedHistoryLabel('edit', 1)).not.toBe(retainedHistoryLabel('regenerate', 1));
    expect(retainedHistoryLabel('regenerate', 3)).toContain('3');
  });
});

describe('lineageNodeKey', () => {
  function node(message: ChatMessage): LineageNode {
    return { message, priorMessages: [] };
  }

  test('uses the message id alone, with no index baked in', () => {
    expect(lineageNodeKey(node(msg('msg-7', 'assistant', 'hi')), 3)).toBe('msg-7');
  });

  test('the key does NOT change when the same message moves to a different array position', () => {
    // A merge (optimistic local copy -> server-fetched history) can re-render the same
    // message at a different index; the key must stay stable so an open <details> fold
    // (retained history, compaction handoff, or a folded tool-activity group) survives
    // the re-render instead of being remounted closed.
    const message = msg('msg-stable', 'assistant', 'hi');
    expect(lineageNodeKey(node(message), 0)).toBe(lineageNodeKey(node(message), 5));
  });

  test('falls back to a clearly-ordinal key, shaped so it can never collide with a real id, when the message has no id', () => {
    const noIdMessage = { role: 'assistant', content: 'hi', createdAt: 1 } as ChatMessage;
    expect(lineageNodeKey(node(noIdMessage), 2)).toBe('node-2');
  });
});
