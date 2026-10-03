// ---------------------------------------------------------------------------
// search-folded-groups.test.ts, in-transcript search must reach text that
// exists only inside a collapsed block or a tool result hidden by a collapsed
// assistant turn, WITHOUT expanding anything on a keystroke.
//
// The contract: typing a query counts hits inside collapsed content honestly
// (a collapsed turn's results render nothing and register no BlockMeta, so
// without reading the raw corpus a needle living inside a result would report
// "no matches" for text the user watched stream by) but never expands
// anything, a single keystroke must not collapse-destroy a transcript the
// user folded on purpose. Expansion happens only when the user NAVIGATES to a
// hidden match (revealCurrentMatch), and only the specific block (and its
// containing turn) needed to reveal that hit.
// Auto-expanded blocks are re-collapsed when search closes, unless the user
// explicitly touched them (toggle/copy/bookmark) while they were open.
//
// Adapted from goodvibes-tui's search test.
// ---------------------------------------------------------------------------

import { describe, expect, test, beforeEach } from 'bun:test';
import { SearchManager } from '../../input/search.ts';
import { ConversationManager } from '../../core/conversation.ts';

const NEEDLE = 'zzzGroupedMarkerZzz';

let sm: SearchManager;
beforeEach(() => { sm = new SearchManager(); });

/** Two results for one assistant turn sit behind its beads under a single
 *  'assistant_turn' header (see work-tree-model.ts). Once that turn is folded
 *  the header is its entire visible representation and no bead registers a
 *  BlockMeta of its own, so the needle, which lives ONLY in the second
 *  result's content, never in the header's summary, is reachable only
 *  through the turn's groupMemberIndexes, and revealed by the bead key
 *  groupMemberKeys pairs with it. */
function buildFoldedToolGroup(): { cm: ConversationManager; hitMemberIdx: number; hitKey: string; otherKey: string } {
  const cm = new ConversationManager(() => 80);
  // Long enough that each member is collapsed-by-default on its own too,
  // so expanding the group header alone would not reveal the needle.
  const padded = (marker: string) => `alpha\nbeta ${marker} inside\n` + 'padding '.repeat(60);
  cm.addUserMessage('run the tools');
  cm.addAssistantMessage('', { toolCalls: [
    { id: 'c1', name: 'read', arguments: {} },
    { id: 'c2', name: 'exec', arguments: {} },
  ] });
  cm.addToolResults([
    { callId: 'c1', success: true, output: padded('nothing to see') },
    { callId: 'c2', success: true, output: padded(NEEDLE) },
  ]);
  cm.getDisplayBlocks();
  // Turns default EXPANDED (collapsing must never hide prose), so the
  // hidden-content condition this suite is about is created explicitly.
  cm.setCollapsed('turn_1', true);
  cm.getDisplayBlocks();
  const group = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn');
  expect(group).toBeDefined();
  expect(group!.groupMemberIndexes).toHaveLength(2);
  expect(group!.groupMemberKeys).toEqual(['bead_c:1:0', 'bead_c:1:1']);
  return { cm, hitMemberIdx: group!.groupMemberIndexes![1]!, hitKey: group!.groupMemberKeys![1]!, otherKey: group!.groupMemberKeys![0]! };
}

/** A single long tool result (>200 chars, no recognized summarizer shape)
 *  stays collapsed by default, its needle is nowhere in the 1-line
 *  collapsed preview, only in the raw content.
 *
 *  The needle sits AFTER a long run of padding on purpose. The collapsed row's
 *  preview flattens newlines into one run (the shared fold policy's rule) and
 *  truncates to the columns the badge leaves, so the only way to keep a marker
 *  genuinely hidden, which is the condition this whole suite is about, is to
 *  put it past that budget rather than merely on a later line. */
function buildLongToolResult(): { cm: ConversationManager; needle: string } {
  const cm = new ConversationManager(() => 80);
  const needle = 'zzzFindableMarkerZzz';
  const longContent = `line one\n${'padding '.repeat(60)}\nlast line with ${needle} inside`;
  cm.addAssistantMessage('', { toolCalls: [{ id: 'c1', name: 'exec', arguments: {} }] });
  cm.addToolResults([{ callId: 'c1', success: true, output: longContent }]);
  cm.getDisplayBlocks();
  return { cm, needle };
}

describe('search() with a conversationManager counts matches inside collapsed content without expanding it', () => {
  test('a query matching only the raw (collapsed) content finds nothing without a conversationManager', () => {
    const { cm, needle } = buildLongToolResult();
    sm.open();
    sm.search(needle, cm.history); // no conversationManager passed, pre-existing behavior
    expect(sm.matches).toHaveLength(0);
  });

  test('the same query counts a match once a conversationManager is passed, but leaves the block collapsed', () => {
    const { cm, needle } = buildLongToolResult();
    const block = cm.getBlockRegistry().find((b) => b.type === 'tool');
    expect(block).toBeDefined();
    expect(cm.isCollapsed(block!.blockIndex)).toBe(true);

    sm.open();
    sm.search(needle, cm.history, cm);

    // Honest count: the hit is real even though nothing expanded.
    expect(sm.matches.length).toBeGreaterThan(0);
    // A single keystroke must never expand a block it merely matched.
    expect(cm.isCollapsed(block!.blockIndex)).toBe(true);
    // getCurrentMatchLine() reports -1 for a still-hidden match, there is
    // no real line to scroll to until the user navigates there.
    expect(sm.getCurrentMatchLine()).toBe(-1);
  });

  test('repeated keystrokes never expand the block either', () => {
    const { cm, needle } = buildLongToolResult();
    const block = cm.getBlockRegistry().find((b) => b.type === 'tool');
    sm.open();
    sm.search(needle.slice(0, 3), cm.history, cm);
    sm.search(needle.slice(0, 6), cm.history, cm);
    sm.search(needle, cm.history, cm);
    expect(cm.isCollapsed(block!.blockIndex)).toBe(true);
    expect(sm.matches.length).toBeGreaterThan(0);
  });

  test('revealCurrentMatch() expands exactly that block and lands on a real, navigable line', () => {
    const { cm, needle } = buildLongToolResult();
    const block = cm.getBlockRegistry().find((b) => b.type === 'tool');
    sm.open();
    sm.search(needle, cm.history, cm);
    expect(cm.isCollapsed(block!.blockIndex)).toBe(true);

    sm.lock();
    sm.revealCurrentMatch(cm.history, cm);

    expect(cm.isCollapsed(block!.blockIndex)).toBe(false);
    const matchLine = sm.getCurrentMatchLine();
    expect(matchLine).toBeGreaterThanOrEqual(0);
    const renderedLineText = cm.history.getAllLines()[matchLine].map((c) => c.char).join('');
    expect(renderedLineText).toContain(needle);
  });

  test('search close (with no user interaction) re-collapses the block search revealed', () => {
    const { cm, needle } = buildLongToolResult();
    const block = cm.getBlockRegistry().find((b) => b.type === 'tool');
    sm.open();
    sm.search(needle, cm.history, cm);
    sm.lock();
    sm.revealCurrentMatch(cm.history, cm);
    expect(cm.isCollapsed(block!.blockIndex)).toBe(false);

    sm.close(cm);
    expect(cm.isCollapsed(block!.blockIndex)).toBe(true);
  });

  test('a block the user explicitly toggled while search had it open stays expanded after close', () => {
    const { cm, needle } = buildLongToolResult();
    const block = cm.getBlockRegistry().find((b) => b.type === 'tool');
    sm.open();
    sm.search(needle, cm.history, cm);
    sm.lock();
    sm.revealCurrentMatch(cm.history, cm);
    expect(cm.isCollapsed(block!.blockIndex)).toBe(false);

    // The user explicitly acts on the block (e.g. Ctrl+Y copy, Ctrl+B
    // bookmark, or re-toggling it) while it sits auto-expanded.
    cm.noteUserTouch(block!.collapseKey);

    sm.close(cm);
    expect(cm.isCollapsed(block!.blockIndex)).toBe(false);
  });

  test('closing search never disturbs a block the user had already expanded before search opened', () => {
    const { cm, needle } = buildLongToolResult();
    const block = cm.getBlockRegistry().find((b) => b.type === 'tool');
    // User expands it themselves, before search ever runs.
    cm.toggleCollapseAtLine(block!.startLine);
    expect(cm.isCollapsed(block!.blockIndex)).toBe(false);

    sm.open();
    sm.search(needle, cm.history, cm);
    sm.lock();
    sm.revealCurrentMatch(cm.history, cm); // no-op: already visible, not hidden
    sm.close(cm);

    expect(cm.isCollapsed(block!.blockIndex)).toBe(false);
  });
});

describe('search() reaches text hidden inside a collapsed assistant turn', () => {
  test('the turn is collapsed and its own rawContent is only the summary line', () => {
    const { cm } = buildFoldedToolGroup();
    const group = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn');
    // The defect this covers: the needle is in no block's rawContent at all,
    // because the hidden results contributed no BlockMeta.
    expect(cm.isCollapsed(group!.blockIndex)).toBe(true);
    expect(group!.rawContent).not.toContain(NEEDLE);
    expect(cm.getBlockRegistry().some((b) => b.rawContent.includes(NEEDLE))).toBe(false);
  });

  test('a result-only needle finds nothing without a conversationManager', () => {
    const { cm } = buildFoldedToolGroup();
    sm.open();
    sm.search(NEEDLE, cm.history);
    expect(sm.matches).toHaveLength(0);
  });

  test('a keystroke counts the result-only hit honestly but expands nothing', () => {
    const { cm } = buildFoldedToolGroup();
    const group = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn');
    sm.open();
    sm.search(NEEDLE, cm.history, cm);

    expect(sm.matches.length).toBeGreaterThan(0);
    expect(cm.isCollapsed(group!.blockIndex)).toBe(true);
    expect(cm.getBlockRegistry().some((b) => b.collapseKey.startsWith('bead_'))).toBe(false);
  });

  test('revealCurrentMatch() expands the turn AND the hit result (and only that result), landing on the needle line', () => {
    const { cm, hitKey, otherKey } = buildFoldedToolGroup();

    sm.open();
    sm.search(NEEDLE, cm.history, cm);
    sm.lock();
    sm.revealCurrentMatch(cm.history, cm);

    expect(sm.matches.length).toBeGreaterThan(0);

    const registry = cm.getBlockRegistry();
    const groupAfter = registry.find((b) => b.type === 'assistant_turn');
    expect(cm.isCollapsed(groupAfter!.blockIndex)).toBe(false);
    // The hit result's bead now has a block of its own, and it is open: the
    // header alone would have left its content invisible.
    const member = registry.find((b) => b.collapseKey === hitKey);
    expect(member).toBeDefined();
    expect(cm.isCollapsed(member!.blockIndex)).toBe(false);
    // Its sibling bead (no hit inside it) is left exactly as it was: the turn
    // unfolds, but only the hit bead was opened, so the sibling stays closed.
    const otherMember = registry.find((b) => b.collapseKey === otherKey);
    expect(otherMember).toBeDefined();
    expect(cm.isCollapsed(otherMember!.blockIndex)).toBe(true);
    // The landed line is the real one.
    const matchLine = sm.getCurrentMatchLine();
    expect(matchLine).toBeGreaterThanOrEqual(0);
    const renderedLineText = cm.history.getAllLines()[matchLine].map((c) => c.char).join('');
    expect(renderedLineText).toContain(NEEDLE);
  });

  test('search close re-collapses the turn; the result is inaccessible again until re-expanded (turn and result fold as one)', () => {
    const { cm, hitKey } = buildFoldedToolGroup();
    sm.open();
    sm.search(NEEDLE, cm.history, cm);
    sm.lock();
    sm.revealCurrentMatch(cm.history, cm);

    let registry = cm.getBlockRegistry();
    expect(cm.isCollapsed(registry.find((b) => b.type === 'assistant_turn')!.blockIndex)).toBe(false);
    expect(cm.isCollapsed(registry.find((b) => b.collapseKey === hitKey)!.blockIndex)).toBe(false);

    sm.close(cm);
    cm.getDisplayBlocks();

    registry = cm.getBlockRegistry();
    const groupAfter = registry.find((b) => b.type === 'assistant_turn');
    expect(groupAfter).toBeDefined();
    expect(cm.isCollapsed(groupAfter!.blockIndex)).toBe(true);
    // The result no longer materializes its own BlockMeta, hidden again
    // right along with its turn, exactly as it was before search opened.
    expect(registry.some((b) => b.collapseKey === hitKey)).toBe(false);
  });

  test('a needle present nowhere finds nothing and expands nothing', () => {
    const { cm } = buildFoldedToolGroup();
    sm.open();
    sm.search('absolutely_not_present_anywhere', cm.history, cm);
    expect(sm.matches).toHaveLength(0);
    const group = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn');
    expect(cm.isCollapsed(group!.blockIndex)).toBe(true);
  });

  test('an empty query clears matches and expands nothing', () => {
    const { cm } = buildFoldedToolGroup();
    sm.open();
    sm.search('', cm.history, cm);
    expect(sm.matches).toHaveLength(0);
    const group = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn');
    expect(cm.isCollapsed(group!.blockIndex)).toBe(true);
  });

  test('a turn whose results are already expanded still matches, and search never touches its collapse state', () => {
    const { cm, hitKey } = buildFoldedToolGroup();
    const group = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn');
    cm.setCollapsed(group!.collapseKey, false);
    for (const memberKey of group!.groupMemberKeys!) {
      cm.setCollapsed(memberKey, false);
    }
    cm.getDisplayBlocks();

    sm.open();
    sm.search(NEEDLE, cm.history, cm);
    sm.lock();
    sm.revealCurrentMatch(cm.history, cm); // no-op: already visible

    expect(sm.matches.length).toBeGreaterThan(0);
    const registry = cm.getBlockRegistry();
    expect(cm.isCollapsed(registry.find((b) => b.type === 'assistant_turn')!.blockIndex)).toBe(false);
    expect(cm.isCollapsed(registry.find((b) => b.collapseKey === hitKey)!.blockIndex)).toBe(false);
  });

  test('result indexes that outlived their messages are skipped, not thrown on', () => {
    // undo() splices the messages tail while the (unflushed) block registry
    // still names the turn's result indexes, so the lookup runs against a
    // snapshot shorter than those indexes.
    const { cm } = buildFoldedToolGroup();
    expect(cm.undo()).toBe(true);
    expect(cm.getMessageSnapshot().length).toBe(0);
    expect(cm.getBlockRegistry().some((b) => b.type === 'assistant_turn')).toBe(true);

    sm.open();
    expect(() => sm.search(NEEDLE, cm.history, cm)).not.toThrow();
    expect(sm.matches).toHaveLength(0);
  });
});
