// ---------------------------------------------------------------------------
// conversation-assistant-turn-rendering.test.ts, end-to-end transcript
// behaviour of an assistant turn drawn as a lane-graph work tree (see
// src/core/work-tree-model.ts and src/core/work-tree-render.ts), through the
// real ConversationManager.
//
// The guarantees: a turn is every assistant and tool message between two user
// messages, under ONE header; every tool call is ONE bead row (its status on
// the bead, its result's one-line summary on the same row, no separate result
// row); a result with no call in the turn is its own bead; a bead's result
// body is closed until opened; folding the turn hides
// its beads but never its answer; the turn's block names every result and the
// bead key that reveals it, so /expand and search can reach hidden results;
// hidden rows anchor navigation at a row that is on screen.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { ConversationManager } from '../../core/conversation';

const WIDTH = 100;

function transcript(cm: ConversationManager): string {
  return cm.getDisplayBlocks()
    .map((line) => line.map((cell) => cell.char).join('').replace(/\s+$/, ''))
    .join('\n');
}

const RESULT_A = 'first result body';
const RESULT_B = 'second result body';

/** One assistant turn that ran two web searches, then answered. */
function twoSearchTurn(): ConversationManager {
  const cm = new ConversationManager(() => WIDTH);
  cm.addUserMessage('compare two libraries');            // absolute index 0
  cm.addAssistantMessage('Searching for both.', {        // absolute index 1
    toolCalls: [
      { id: 'call-1', name: 'web_search', arguments: { query: 'library one' } },
      { id: 'call-2', name: 'web_search', arguments: { query: 'library two' } },
    ],
  });
  cm.addToolResults([                                     // absolute indexes 2, 3
    { callId: 'call-1', success: true, output: RESULT_A },
    { callId: 'call-2', success: true, output: RESULT_B },
  ]);
  cm.addAssistantMessage('Library one is smaller.');     // absolute index 4
  return cm;
}

describe('assistant turns as a work tree', () => {
  test('one header per turn, one bead row per call, the result summary on the bead row', () => {
    const text = transcript(twoSearchTurn());
    expect(text.split('\n').filter((l) => l.includes('◆'))).toHaveLength(1);
    expect(text).toMatch(/◆ .*2 tools/);
    const beads = text.split('\n').filter((l) => l.includes('Searching the web'));
    expect(beads).toHaveLength(2);
    expect(beads[0]).toMatch(/✓ .*Searching the web library one .*first result body/);
    expect(beads[1]).toMatch(/✓ .*Searching the web library two .*second result body/);
  });

  test('a bead starts closed and opens on its own key', () => {
    const cm = twoSearchTurn();
    expect(transcript(cm).split('\n').filter((l) => l.includes('first result body'))).toHaveLength(1); // the summary only
    const bead = cm.getBlockRegistry().find((b) => b.collapseKey === 'bead_c:1:0')!;
    expect(cm.isCollapsed(bead.blockIndex)).toBe(true);
    cm.setCollapsed('bead_c:1:0', false);
    const lines = transcript(cm).split('\n');
    expect(lines.filter((l) => l.includes('first result body'))).toHaveLength(2); // summary + body
    expect(lines.some((l) => l.includes('▾ Searching the web library one'))).toBe(true);
    expect(lines.some((l) => l.includes('▸ Searching the web library two'))).toBe(true);
  });

  test('folding a turn hides its beads but NEVER its answer', () => {
    const cm = twoSearchTurn();
    cm.getDisplayBlocks();
    cm.setCollapsed('turn_1', true);
    const text = transcript(cm);
    expect(text).toContain('Library one is smaller.');
    expect(text).toMatch(/◆ .*2 tools.* ▸/);
    expect(text).not.toContain('library one');
    expect(text).not.toContain('first result body');
  });

  test('the turn block names every result and the bead key that reveals it', () => {
    const cm = twoSearchTurn();
    cm.getDisplayBlocks();
    const turn = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn')!;
    expect(turn.collapseKey).toBe('turn_1');
    expect(turn.groupMemberIndexes).toEqual([2, 3]);
    expect(turn.groupMemberKeys).toEqual(['bead_c:1:0', 'bead_c:1:1']);
  });

  test('a result lands on its bead row; folded, it anchors at the turn header', () => {
    const cm = twoSearchTurn();
    cm.getDisplayBlocks();
    const bead = cm.getBlockRegistry().find((b) => b.collapseKey === 'bead_c:1:1')!;
    expect(cm.getMessageLine(3)).toBe(bead.startLine);
    cm.setCollapsed('turn_1', true);
    cm.getDisplayBlocks();
    const turn = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn')!;
    expect(cm.getBlockRegistry().find((b) => b.collapseKey === 'bead_c:1:1')).toBeUndefined();
    expect(cm.getMessageLine(2)).toBe(turn.startLine);
    expect(cm.getMessageLine(3)).toBe(turn.startLine);
  });

  test('a result for a call the turn never issued is its own bead where it sits, never folded into another call', () => {
    const cm = twoSearchTurn();
    const lines = () => transcript(cm).split('\n');
    expect(lines().find((l) => l.includes('◆'))).toMatch(/2 tools/);
    cm.addToolResults([{ callId: 'call-3', success: true, output: 'third' }]);
    expect(lines().find((l) => l.includes('◆'))).toMatch(/3 tools/);
    expect(lines().filter((l) => l.includes('Searching the web'))).toHaveLength(2);
    // A call-less result whose shape names no tool reads "Result", never the bare "Tool".
    expect(lines().some((l) => /✓ +▸ Result .*third/.test(l))).toBe(true);
  });

  test('every assistant message between two user messages is one turn: narration on the spine, the last answer closes it', () => {
    const cm = new ConversationManager(() => WIDTH);
    cm.addUserMessage('do it twice');
    cm.addAssistantMessage('first pass', { toolCalls: [{ id: 'a1', name: 'read', arguments: { path: 'a.md' } }] });
    cm.addToolResults([{ callId: 'a1', success: true, output: 'alpha' }]);
    cm.addAssistantMessage('second pass', { toolCalls: [{ id: 'b1', name: 'exec', arguments: { command: 'ls' } }] });
    cm.addToolResults([{ callId: 'b1', success: true, output: 'gamma' }]);
    cm.addAssistantMessage('all done');
    const lines = transcript(cm).split('\n');
    expect(cm.getBlockRegistry().filter((b) => b.type === 'assistant_turn')).toHaveLength(1);
    expect(lines.find((l) => l.includes('first pass'))).toMatch(/^ {3}│ +first pass/);
    expect(lines.find((l) => l.includes('second pass'))).toMatch(/^ {3}│ +second pass/);
    expect(lines.find((l) => l.includes('all done'))).toMatch(/^ {3}╰─ +all done/);
  });

  test('toggling the turn header at its line folds and unfolds the whole turn', () => {
    const cm = twoSearchTurn();
    cm.getDisplayBlocks();
    const header = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn')!;
    cm.toggleCollapseAtLine(header.startLine);
    expect(transcript(cm)).not.toContain('library one');
    const folded = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn')!;
    cm.toggleCollapseAtLine(folded.startLine);
    expect(transcript(cm)).toContain('library one');
  });
});
