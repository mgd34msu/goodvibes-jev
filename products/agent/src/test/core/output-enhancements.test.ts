import { describe, test, expect, beforeEach } from 'bun:test';
import { ConversationManager } from '../../core/conversation';

describe('ConversationManager: collapse state', () => {
  let cm: ConversationManager;

  beforeEach(() => {
    cm = new ConversationManager(() => 80);
  });

  test('tool results over threshold are auto-collapsed', () => {
    // Add a tool result with more than 30 lines (default threshold)
    const longContent = Array.from({ length: 35 }, (_, i) => `line ${i + 1}`).join('\n');
    cm.addUserMessage('run something');
    cm.addToolResults([{ callId: 'c1', success: true, output: longContent }]);
    cm.getDisplayBlocks(); // trigger render

    // The first block (index 0) should be auto-collapsed
    expect(cm.isCollapsed(0)).toBe(true);
  });

  test('toggleCollapseAtLine toggles collapse state and marks dirty', () => {
    const longContent = Array.from({ length: 35 }, (_, i) => `line ${i + 1}`).join('\n');
    cm.addUserMessage('run something');
    cm.addToolResults([{ callId: 'c1', success: true, output: longContent }]);
    cm.getDisplayBlocks(); // trigger render, auto-collapses block 0

    expect(cm.isCollapsed(0)).toBe(true);
    cm.toggleCollapseAtLine(0);
    expect(cm.isCollapsed(0)).toBe(false);
    cm.toggleCollapseAtLine(0);
    expect(cm.isCollapsed(0)).toBe(true);
  });

  test('toggleCollapseAtLine returns -1 when no blocks registered', () => {
    const result = cm.toggleCollapseAtLine(0);
    expect(result).toBe(-1);
  });

  test('short tool results start closed too: a bead shows no result rows until it is opened', () => {
    cm.addUserMessage('run something');
    cm.addToolResults([{ callId: 'c2', success: true, output: 'short result' }]);
    cm.getDisplayBlocks();

    expect(cm.isCollapsed(0)).toBe(true);
  });
});

describe('ConversationManager: getBlockContentAtLine / getDiffAtLine', () => {
  let cm: ConversationManager;

  beforeEach(() => {
    cm = new ConversationManager(() => 80);
  });

  test('getBlockContentAtLine returns null when no blocks', () => {
    expect(cm.getBlockContentAtLine(0)).toBeNull();
  });

  test('getBlockContentAtLine returns raw content of nearest block', () => {
    cm.addUserMessage('run something');
    cm.addToolResults([{ callId: 'c1', success: true, output: 'tool output here' }]);
    cm.getDisplayBlocks();

    const content = cm.getBlockContentAtLine(0);
    expect(content).toBe('tool output here');
  });

  test('getDiffAtLine returns null when no diff blocks', () => {
    cm.addUserMessage('run something');
    cm.addToolResults([{ callId: 'c1', success: true, output: 'plain text output' }]);
    cm.getDisplayBlocks();

    expect(cm.getDiffAtLine(0)).toBeNull();
  });

  test('getDiffAtLine returns diff data for a diff block', () => {
    const diff = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,1 @@',
      '-old line',
      '+new line',
    ].join('\n');

    cm.addUserMessage('run something');
    cm.addToolResults([{ callId: 'c1', success: true, output: diff }]);
    cm.getDisplayBlocks();

    const result = cm.getDiffAtLine(0);
    expect(result).toEqual(expect.objectContaining({
      filePath: 'src/foo.ts',
      original: expect.stringContaining('old line'),
      updated: expect.stringContaining('new line'),
    }));
  });
});

describe('ConversationManager: diff detection (no false positives)', () => {
  let cm: ConversationManager;

  beforeEach(() => {
    cm = new ConversationManager(() => 80);
  });

  test('tool output containing diff-like strings mid-line is not a diff', () => {
    // This content has diff-like words but NOT at line start
    const fakeDiff = 'The file had --- changes and +++ additions and @@ markers inside strings';
    cm.addUserMessage('run something');
    cm.addToolResults([{ callId: 'c1', success: true, output: fakeDiff }]);
    cm.getDisplayBlocks();

    // getDiffAtLine should return null, it's not a real diff
    expect(cm.getDiffAtLine(0)).toBeNull();
  });

  test('real diff with headers at line start is recognized', () => {
    const realDiff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    cm.addUserMessage('run something');
    cm.addToolResults([{ callId: 'c1', success: true, output: realDiff }]);
    cm.getDisplayBlocks();

    expect(cm.getDiffAtLine(0)).toEqual(expect.objectContaining({
      filePath: 'file.ts',
    }));
  });
});
