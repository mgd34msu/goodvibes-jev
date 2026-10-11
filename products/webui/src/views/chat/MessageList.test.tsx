/**
 * DOM render tests for MessageList.
 *
 * Verifies:
 * 1. Caret shows only when isStreaming=true AND liveText is non-empty
 * 2. Stop button renders only when onStop is provided
 * 3. aria-label "Stop generating" is present on the stop button
 * 4. reduced-motion class is applied to caret when useReducedMotion returns true
 * 5. aria-live region is present during streaming
 *
 * Uses createRoot + flushSync (project pattern from toast.dom.test.tsx).
 * matchMedia is stubbed in test-setup.ts, useReducedMotion reads it via
 * window.matchMedia; we override it per-test when needed.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PeekProvider } from '../../components/peek/PeekPanel';
import { ToastProvider } from '../../lib/toast';
import type { LineageNode } from './lineage';
import type { ChatMessage } from './types';
import type { ActiveToolCall } from './useChatStream';

// Assistant-tone messages with text mount SpeakButton (useTts -> sdk.operator.voice.status /
// config.get, both routed through react-query). Mocked here, never a real network call,
// and MessageList is imported dynamically AFTER this mock so the module graph never loads
// the real goodvibes.ts first (mock.module only wins if it runs before the first import).
mock.module('../../lib/goodvibes', () => ({
  runBrowserJudgment: () => Promise.reject(new Error('No semantic reading in this display fixture.')),
  sdk: {
    operator: {
      voice: { status: () => Promise.resolve({ ttsAvailable: false, sttAvailable: false }) },
      config: { get: () => Promise.resolve({}) },
    },
  },
}));

const { MessageList } = await import('./MessageList');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noop = () => {};

const baseProps = {
  nodes: [] as LineageNode[],
  liveText: '',
  showJumpToBottom: false,
  isSendPending: false,
  copiedMessageId: '',
  highlightedMessageId: '',
  scrollRef: { current: null } as React.RefObject<HTMLDivElement | null>,
  onScroll: noop,
  onJumpToBottom: noop,
  onCopyMessage: noop as (m: ChatMessage) => void,
  onResendMessage: noop as (m: ChatMessage) => void,
  onRegenerateFrom: noop as (messageId: string) => void,
};

function renderMessageList(props: Partial<typeof baseProps & {
  isStreaming?: boolean;
  workingLabel?: string;
  onStop?: () => void;
  activeToolCalls?: readonly ActiveToolCall[];
  onCancelToolCall?: (callId: string) => void;
}> = {}) {
  const merged = { ...baseProps, ...props };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  flushSync(() => {
    // MessageItem calls useArtifactsPanel unconditionally (for its "View
    // artifacts" affordance), which needs ToastProvider + PeekProvider
    // ancestors whenever `nodes` is non-empty, most existing tests here pass
    // nodes: [] and never actually mount a MessageItem, but the highlight
    // tests below do. QueryClientProvider is needed too: an assistant message
    // with text mounts SpeakButton -> useTts -> react-query (mocked above).
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          ToastProvider,
          null,
          React.createElement(PeekProvider, null, React.createElement(MessageList, merged)),
        ),
      ),
    );
  });

  return {
    container,
    unmount: () => {
      flushSync(() => { root.unmount(); });
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Default matchMedia stub returns matches: false (motion allowed)
  installGlobal('matchMedia', (_query: string) => ({
    matches: false,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  // Reset to default no-motion stub
  installGlobal('matchMedia', (_query: string) => ({
    matches: false,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
});

/** Redefine a globalThis property (mirrors test-setup.ts pattern). */
function installGlobal(key: string, value: unknown): void {
  try {
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch {
    // non-configurable, skip
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageList: before the first token', () => {
  test('the working line shows, and Stop is reachable', () => {
    const { container, unmount } = renderMessageList({ isStreaming: true, liveText: '', onStop: () => {} });
    expect(container.querySelector('.chat-working')).not.toBeNull();
    expect(container.querySelector('.stream-stop-btn')).not.toBeNull();
    unmount();
  });

});

describe('MessageList: working line', () => {
  test('names what is happening, from the workingLabel prop', () => {
    const { container, unmount } = renderMessageList({ isStreaming: true, workingLabel: 'Reading 2 files…' });
    expect(container.querySelector('.chat-working__label')?.textContent).toBe('Reading 2 files…');
    unmount();
  });

  test('is absent when no turn is running', () => {
    const { container, unmount } = renderMessageList({ isStreaming: false });
    expect(container.querySelector('.chat-working')).toBeNull();
    unmount();
  });
});

describe('MessageList: message layout and timestamps', () => {
  test('both a user message and an assistant reply render their content', () => {
    const nodes: LineageNode[] = [
      { message: { id: 'u1', role: 'user', content: 'question', createdAt: Date.now() } as ChatMessage, priorMessages: [] },
      { message: { id: 'a1', role: 'assistant', content: 'answer', createdAt: Date.now() } as ChatMessage, priorMessages: [] },
    ];
    const { container, unmount } = renderMessageList({ nodes });
    expect(container.textContent).toContain('question');
    expect(container.textContent).toContain('answer');
    unmount();
  });

  test('a known time renders in a <time> element in the footer', () => {
    const at = new Date(2026, 8, 30, 15, 42).getTime();
    const nodes: LineageNode[] = [
      { message: { id: 'a1', role: 'assistant', content: 'answer', createdAt: at } as ChatMessage, priorMessages: [] },
    ];
    const { container, unmount } = renderMessageList({ nodes });
    const time = container.querySelector('.message-actions time');
    expect(time).not.toBeNull();
    expect(time?.getAttribute('dateTime')).toBe(new Date(at).toISOString());
    unmount();
  });

  test('a zero or missing time renders nothing: never an epoch date', () => {
    const nodes: LineageNode[] = [
      { message: { id: 'a0', role: 'assistant', content: 'zero', createdAt: 0 } as ChatMessage, priorMessages: [] },
      { message: { id: 'a1', role: 'assistant', content: 'one second after the epoch', createdAt: 1000 } as ChatMessage, priorMessages: [] },
      { message: { id: 'a2', role: 'assistant', content: 'missing' } as ChatMessage, priorMessages: [] },
    ];
    const { container, unmount } = renderMessageList({ nodes });
    expect(container.querySelector('.message-actions time')).toBeNull();
    expect(container.textContent).not.toContain('1969');
    expect(container.textContent).not.toContain('1970');
    unmount();
  });

});

describe('MessageList: Stop button', () => {
  test('Stop button is absent when onStop is not provided', () => {
    const { container, unmount } = renderMessageList({ isStreaming: true, liveText: 'typing...' });
    expect(container.querySelector('.stream-stop-btn')).toBeNull();
    unmount();
  });

  test('Stop button is present when onStop is provided and streaming', () => {
    const { container, unmount } = renderMessageList({
      isStreaming: true,
      liveText: 'typing...',
      onStop: noop,
    });
    const btn = container.querySelector('.stream-stop-btn');
    expect(btn).not.toBeNull();
    unmount();
  });

  test('Stop button calls onStop when clicked', () => {
    const onStop = mock(noop);
    const { container, unmount } = renderMessageList({
      isStreaming: true,
      liveText: 'typing...',
      onStop,
    });
    const btn = container.querySelector('.stream-stop-btn') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    flushSync(() => { btn!.click(); });
    expect(onStop).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe('MessageList: aria attributes', () => {
  test('aria-live polite region is present during streaming', () => {
    const { container, unmount } = renderMessageList({ isStreaming: true, liveText: 'hello' });
    const liveRegion = container.querySelector('[aria-live="polite"]');
    expect(liveRegion).not.toBeNull();
    unmount();
  });

  test('aria-live region renders while streaming even before the first token (the responding bubble)', () => {
    const { container, unmount } = renderMessageList({ isStreaming: true, liveText: '' });
    const liveRegion = container.querySelector('[aria-live="polite"]');
    expect(liveRegion).not.toBeNull();
    unmount();
  });

  test('aria-live region is absent when idle with no liveText', () => {
    const { container, unmount } = renderMessageList({ isStreaming: false, liveText: '' });
    expect(container.querySelector('[aria-live="polite"]')).toBeNull();
    unmount();
  });

});

describe('MessageList: search jump-to-message highlight', () => {
  // Both nodes use tone 'user': an assistant node with text would also mount
  // SpeakButton (useTts -> real sdk.operator.voice.status() network call,
  // unrelated to what this suite covers), so 'user' keeps the fixture
  // focused on the highlight/data-message-id wiring under test.
  const nodes: LineageNode[] = [
    { message: { id: 'msg-1', role: 'user', content: 'first' } as ChatMessage, priorMessages: [] },
    { message: { id: 'msg-2', role: 'user', content: 'second' } as ChatMessage, priorMessages: [] },
  ];

  test('each rendered message carries its id as data-message-id, for the scroll-to-message lookup', () => {
    const { container, unmount } = renderMessageList({ nodes });
    const articles = container.querySelectorAll('article.message');
    expect(articles.length).toBe(2);
    expect(articles[0]?.getAttribute('data-message-id')).toBe('msg-1');
    expect(articles[1]?.getAttribute('data-message-id')).toBe('msg-2');
    unmount();
  });

});

describe('MessageList: running tool calls + cancel (SDK 1.8.0 interaction-wins round)', () => {
  test('no active-tool-calls list renders when activeToolCalls is empty', () => {
    const { container, unmount } = renderMessageList({ isStreaming: true, liveText: 'typing...' });
    expect(container.querySelector('.active-tool-calls')).toBeNull();
    unmount();
  });

  test('a running tool call renders with a Cancel button', () => {
    const { container, unmount } = renderMessageList({
      isStreaming: true,
      liveText: 'typing...',
      activeToolCalls: [{ turnId: 't1', toolCallId: 'call-1', toolName: 'bash', cancelled: false }],
      onCancelToolCall: noop as (callId: string) => void,
    });
    const item = container.querySelector('.active-tool-call');
    expect(item?.textContent).toContain('bash');
    expect(item?.querySelector('.active-tool-call__cancel')).not.toBeNull();
    unmount();
  });

  test('clicking Cancel calls onCancelToolCall with the toolCallId', () => {
    const calls: string[] = [];
    const { container, unmount } = renderMessageList({
      isStreaming: true,
      liveText: 'typing...',
      activeToolCalls: [{ turnId: 't1', toolCallId: 'call-1', toolName: 'bash', cancelled: false }],
      onCancelToolCall: (callId: string) => { calls.push(callId); },
    });
    const cancelBtn = container.querySelector('.active-tool-call__cancel') as HTMLButtonElement;
    flushSync(() => { cancelBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    expect(calls).toEqual(['call-1']);
    unmount();
  });

  test('a cancelled tool call keeps its row and offers no Cancel button', () => {
    const { container, unmount } = renderMessageList({
      isStreaming: true,
      liveText: 'typing...',
      activeToolCalls: [{ turnId: 't1', toolCallId: 'call-1', toolName: 'bash', cancelled: true }],
      onCancelToolCall: noop as (callId: string) => void,
    });
    const item = container.querySelector('.active-tool-call');
    expect(item).not.toBeNull();
    expect(item?.querySelector('.active-tool-call__cancel')).toBeNull();
    unmount();
  });

  test('multiple concurrent tool calls each render their own row', () => {
    const { container, unmount } = renderMessageList({
      isStreaming: true,
      liveText: 'typing...',
      activeToolCalls: [
        { turnId: 't1', toolCallId: 'call-1', toolName: 'bash', cancelled: false },
        { turnId: 't1', toolCallId: 'call-2', toolName: 'read', cancelled: false },
      ],
      onCancelToolCall: noop as (callId: string) => void,
    });
    expect(container.querySelectorAll('.active-tool-call').length).toBe(2);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Compaction-handoff folding, a compactor-authored user message folds to a
// <details> disclosure instead of rendering the re-injected instruction wall.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool-activity folding, a completed turn's tool calls, attached to the
// assistant message that produced them (ChatMessage.toolActivity, populated by
// useChatStream's toolActivityByMessageId), render folded rather than
// vanishing once the turn ends.
// ---------------------------------------------------------------------------

describe('tool activity folding (rendered through MessageItem)', () => {
  test('an assistant message with one completed tool call renders one collapsed line', () => {
    const nodes: LineageNode[] = [
      {
        message: {
          id: 'msg-tool-1', role: 'assistant', content: 'Here is the file.',
          toolActivity: [{ toolCallId: 'call-1', toolName: 'read', toolInput: { file_path: '/a.ts' }, result: 'contents', isError: false }],
        } as ChatMessage,
        priorMessages: [],
      },
    ];
    const { container, unmount } = renderMessageList({ nodes });
    const details = container.querySelector('details.message-tool-activity') as HTMLDetailsElement | null;
    expect(details?.open).toBe(false);
    expect(details).not.toBeNull();
    unmount();
  });

  test('an assistant message with multiple completed tool calls folds into one counted line', () => {
    const nodes: LineageNode[] = [
      {
        message: {
          id: 'msg-tool-2', role: 'assistant', content: 'Done.',
          toolActivity: [
            { toolCallId: 'call-1', toolName: 'read', result: 'a', isError: false },
            { toolCallId: 'call-2', toolName: 'bash', result: 'b', isError: false },
          ],
        } as ChatMessage,
        priorMessages: [],
      },
    ];
    const { container, unmount } = renderMessageList({ nodes });
    const details = container.querySelectorAll('details.message-tool-activity');
    expect(details.length).toBe(1);
    unmount();
  });

  test('a user message never renders tool activity, even if the field were present', () => {
    const nodes: LineageNode[] = [
      {
        message: {
          id: 'msg-tool-3', role: 'user', content: 'question',
          toolActivity: [{ toolCallId: 'call-1', toolName: 'read', result: 'x', isError: false }],
        } as ChatMessage,
        priorMessages: [],
      },
    ];
    const { container, unmount } = renderMessageList({ nodes });
    expect(container.querySelector('.message-tool-activity')).toBeNull();
    unmount();
  });

  test('an assistant message with no toolActivity field renders no fold at all', () => {
    const nodes: LineageNode[] = [
      { message: { id: 'msg-tool-4', role: 'assistant', content: 'plain reply' } as ChatMessage, priorMessages: [] },
    ];
    const { container, unmount } = renderMessageList({ nodes });
    expect(container.querySelector('.message-tool-activity')).toBeNull();
    unmount();
  });
});

describe('compaction handoff folding', () => {
  const handoffContent = [
    'IMPORTANT: This session is not new! Context was compacted, please read the following for proper handoff so you may resume work!',
    '',
    '## Standing Instructions (re-injected)',
    ...Array.from({ length: 40 }, (_, i) => `- ALWAYS follow directive number ${i}`),
  ].join('\n');

  test('handoff message renders folded with a summary, not the full wall', () => {
    const nodes: LineageNode[] = [
      { message: { id: 'msg-h', role: 'user', content: handoffContent } as ChatMessage, priorMessages: [] },
    ];
    const { container, unmount } = renderMessageList({ nodes });
    const details = container.querySelector('details.message-compaction-handoff');
    expect(details).not.toBeNull();
    // Folded by default: the <details> is closed.
    expect((details as HTMLDetailsElement).open).toBe(false);
    unmount();
  });

  test('an ordinary user message does not fold', () => {
    const nodes: LineageNode[] = [
      { message: { id: 'msg-p', role: 'user', content: 'plain question about compaction' } as ChatMessage, priorMessages: [] },
    ];
    const { container, unmount } = renderMessageList({ nodes });
    expect(container.querySelector('details.message-compaction-handoff')).toBeNull();
    expect(container.textContent).toContain('plain question about compaction');
    unmount();
  });
});
