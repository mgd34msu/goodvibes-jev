// ---------------------------------------------------------------------------
// bookmark-navigation.test.ts, a bookmark stored on a tool result now hidden
// by a collapsed assistant turn (see work-tree-model.ts) must still
// resolve to a real transcript line (the turn's header) rather than reporting
// "Bookmark not found".
//
// Ported from goodvibes-tui's test of the same name.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { ConversationManager } from '../../core/conversation';
import { resolveFoldedBookmarkLine } from '../../core/bookmark-navigation.ts';

function foldedRun(): ConversationManager {
  const cm = new ConversationManager(() => 100);
  cm.addUserMessage('read and write two files');       // absolute index 0
  cm.addAssistantMessage('reading and writing now', {  // absolute index 1
    toolCalls: [
      { id: 'call-1', name: 'read', arguments: { path: 'foo.ts' } },
      { id: 'call-2', name: 'write', arguments: { path: 'bar.ts' } },
    ],
  });
  cm.addToolResults([                                   // absolute indexes 2, 3
    { callId: 'call-1', success: true, output: 'contents of foo.ts' },
    { callId: 'call-2', success: true, output: 'wrote bar.ts' },
  ]);
  cm.getDisplayBlocks(); // warm
  // Turns default EXPANDED (collapsing must never hide prose), so the
  // hidden-row condition this suite is about is created explicitly.
  cm.setCollapsed('turn_1', true);
  cm.getDisplayBlocks();
  return cm;
}

describe('resolveFoldedBookmarkLine', () => {
  test("resolves a hidden result's own msg_<idx> key to its turn header line", () => {
    const cm = foldedRun();
    const groupBlock = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn');
    expect(groupBlock).toBeDefined();

    // A bookmark stored on the SECOND tool message's own collapseKey
    // (absolute index 3), this key is not in the block registry at all while
    // the turn is collapsed.
    expect(cm.getBlockRegistry().find((b) => b.collapseKey === 'msg_3')).toBeUndefined();

    expect(resolveFoldedBookmarkLine(cm, 'msg_3')).toBe(groupBlock!.startLine);
  });

  test('a bookmark on the first result resolves to the same turn header line', () => {
    const cm = foldedRun();
    const groupBlock = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn');
    expect(resolveFoldedBookmarkLine(cm, 'msg_2')).toBe(groupBlock!.startLine);
  });

  test('a key that is not a message bookmark resolves to null', () => {
    expect(resolveFoldedBookmarkLine(foldedRun(), 'code_1_4')).toBeNull();
    expect(resolveFoldedBookmarkLine(foldedRun(), 'turn_1')).toBeNull();
  });

  test('a message index that was never rendered resolves to null', () => {
    expect(resolveFoldedBookmarkLine(foldedRun(), 'msg_999')).toBeNull();
  });
});
