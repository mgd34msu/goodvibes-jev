import { describe, expect, test } from 'bun:test';
import { ConversationManager, type ConversationMessageSnapshot } from '../sdk/src/platform/core/conversation.ts';
import { buildSyntheticResult } from '../sdk/src/platform/core/tool-reconciliation.ts';
import type { ToolResult } from '../sdk/src/platform/types/tools.ts';

function tools(cm: ConversationManager) {
  return cm.getMessageSnapshot().filter((message) => message.role === 'tool');
}

function reload(cm: ConversationManager): ConversationManager {
  const restored = new ConversationManager();
  restored.fromJSON(JSON.parse(JSON.stringify(cm.toJSON())) as Parameters<ConversationManager['fromJSON']>[0]);
  return restored;
}

describe('stored tool outcome is explicit execution state', () => {
  test.each([
    [{ callId: 'ok', success: true, output: 'Error: this is successful file content' }, 'ok'],
    [{ callId: 'bad', success: false, output: 'partial', error: 'failed' }, 'error'],
    [{ callId: 'cancel', success: false, cancelled: true, output: 'partial', error: 'stopped' }, 'cancelled'],
    [{ callId: 'late', success: true, cancelled: true, output: 'partial' }, 'cancelled'],
    [{ callId: 'wording', success: false, error: 'cancelled by user' }, 'error'],
  ] satisfies [ToolResult, 'ok' | 'error' | 'cancelled'][])('%s records %s without reading prose', (result, outcome) => {
    const cm = new ConversationManager();
    cm.addToolResults([result]);
    expect(tools(cm)[0]?.outcome).toBe(outcome);
    expect(tools(reload(cm))[0]).toEqual(tools(cm)[0]);
    expect(cm.getMessagesForLLM()[0]).not.toHaveProperty('outcome');
  });

  test('a synthetic unresolved call is an error, not an inferred cancellation', () => {
    const cm = new ConversationManager();
    cm.addToolResults([buildSyntheticResult({ id: 'unresolved', name: 'read', arguments: {} }, 'loop-exit-with-tool-use')]);
    expect(tools(cm)[0]?.outcome).toBe('error');
  });

  test('legacy Error-prefixed results retain an unknown outcome through save and compaction', () => {
    const legacy: Extract<ConversationMessageSnapshot, { role: 'tool' }>[] = [
      { role: 'tool', callId: 'old', content: 'Error: historical content', toolName: 'read' },
    ];
    const cm = new ConversationManager();
    cm.fromJSON({ messages: legacy });
    cm.replaceMessagesForLLM(cm.getMessagesForLLM());
    expect(tools(reload(cm))).toEqual(legacy);
    expect(tools(cm)[0]).not.toHaveProperty('outcome');
  });

  test('successful Error-prefixed content and failure diagnostics remain byte-identical for providers', () => {
    const cm = new ConversationManager();
    cm.addToolResults([
      { callId: 'ok', success: true, output: 'Error: literal contents' },
      { callId: 'bad', success: false, output: 'stdout\nstderr', error: 'exit 1' },
      { callId: 'cancel', success: false, cancelled: true, output: 'partial', error: 'stopped' },
    ]);
    expect(cm.getMessagesForLLM().map((message) => message.content)).toEqual([
      'Error: literal contents', 'Error: exit 1\nstdout\nstderr', 'Error: stopped\npartial',
    ]);
  });

  test('branch switches and JSON replay preserve outcome alongside all other tool fields', () => {
    const cm = new ConversationManager();
    cm.addUserMessage('synthetic question');
    cm.addAssistantMessage('', { toolCalls: [{ id: 'c', name: 'read', arguments: {} }] });
    cm.addToolResults([{ callId: 'c', success: false, cancelled: true, output: 'partial' }]);
    const before = cm.getMessageSnapshot();
    cm.forkBranch('alternate');
    expect(cm.switchBranch('alternate')).toBe(true);
    cm.addUserMessage('alternate question');
    expect(cm.switchBranch('main')).toBe(true);
    expect(cm.getMessageSnapshot()).toEqual(before);
    expect(reload(cm).getMessageSnapshot()).toEqual(before);
    expect(tools(cm)[0]).toMatchObject({ callId: 'c', toolName: 'read', outcome: 'cancelled' });
  });
});
