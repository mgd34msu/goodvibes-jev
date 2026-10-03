/**
 * Regression tests for ANSI escape sequence stripping in untrusted-content renderers.
 *
 * Covers:
 * - the work tree's bead rows and opened bodies (lane-graph/bead.ts cellText):
 *   a tool call's argument, its error text and its result summary never put
 *   an escape sequence, or its printable remnant, on screen.
 */
import { describe, expect, test } from 'bun:test';
import type { Line, ToolCall } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ConversationMessageSnapshot } from '@goodvibes-jev/engine/sdk/platform/core';
import { appendConversationMessages, type ConversationRenderContext } from '../../core/conversation-rendering.ts';
import { lineToString } from '../setup.ts';

// ─── Work-tree bead integration tests ─────────────────────────────────────────

/**
 * Render one turn holding `toolCall` and its result through the real
 * transcript path, with the bead's body opened so the result text draws too.
 */
function renderCall(toolCall: ToolCall, result: string): Line[] {
  const lines: Line[] = [];
  const messages: ConversationMessageSnapshot[] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', toolCalls: [toolCall] },
    { role: 'tool', callId: toolCall.id, toolName: toolCall.name, content: result },
  ];
  const context: ConversationRenderContext = {
    history: { addLine: (l) => { lines.push(l); }, addLines: (ls) => { lines.push(...ls); }, getLineCount: () => lines.length },
    blockRegistry: [],
    collapseState: new Map([['bead_c:1:0', false]]),
    errorLineRegistry: [],
    configManager: null,
    splashOptions: {},
  };
  appendConversationMessages(context, messages, 80, []);
  return lines;
}

describe('work-tree bead ANSI sanitization', () => {
  /** Printable cell text from rendered lines. */
  function collectText(lines: Line[]): string {
    return lines.map((line) => line.map((c) => c.char).join('')).join('\n');
  }

  /** No escape byte, no BEL, and no printable remnant of a CSI or OSC sequence. */
  function assertNoEscapes(text: string): void {
    expect(text).not.toContain('\x1b');
    expect(text).not.toContain('\x07');
    expect(text).not.toMatch(/\[\?\d+[hl]|\[\d+A|\]0;/);
  }

  test('cursor-move sequence in path argument is stripped from the bead row', () => {
    const text = collectText(renderCall({ id: 'tc-ansi-1', name: 'read_file', arguments: { path: '/tmp/\x1b[2Amalicious' } }, 'ok'));
    assertNoEscapes(text);
    expect(text).toContain('/tmp/malicious');
  });

  test('OSC sequence in query argument is stripped', () => {
    const text = collectText(renderCall({ id: 'tc-ansi-2', name: 'web_search', arguments: { query: 'normal\x1b]0;evil\x07query' } }, 'ok'));
    assertNoEscapes(text);
    expect(text).toContain('normal');
    expect(text).toContain('query');
  });

  test('BEL in an error result is stripped from the summary and the opened body', () => {
    const text = collectText(renderCall({ id: 'tc-ansi-3', name: 'exec', arguments: { cmd: 'ls' } }, 'Error: failed\x07beep'));
    assertNoEscapes(text);
    expect(text).toContain('failed');
  });

  test('alt-screen sequence in a result is stripped from the summary', () => {
    const text = collectText(renderCall({ id: 'tc-ansi-4', name: 'lookup', arguments: { cmd: 'ls' } }, '3 files\x1b[?1049h'));
    assertNoEscapes(text);
    expect(text).toContain('3 files');
  });

  test('DECSET cursor-hide sequence in cmd argument is stripped', () => {
    const text = collectText(renderCall({ id: 'tc-ansi-5', name: 'exec', arguments: { cmd: 'echo\x1b[?25l hello' } }, '{"exit_code":0,"stdout":"hi\x1b[2J"}'));
    assertNoEscapes(text);
    expect(text).toContain('echo');
    expect(text).toContain('hello');
  });
});
