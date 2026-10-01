/**
 * The chat's header pieces and the settled-turn notice.
 *
 * - ChatTitle: click to rename (only for a real session), Enter/Escape and
 *   blur go through the caller's handlers.
 * - ChatFindButton: named, pressed while the find bar is open.
 * - ChatTurnNotice: the paused-stream Retry is a real, labelled button (F6:
 *   never a hover title that touch cannot reach); nothing renders for a
 *   normal turn.
 *
 * Uses createRoot + flushSync (project pattern).
 */
import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ChatFindButton, ChatTitle, ChatTurnNotice } from './ChatHeader';

function mount(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(element));
  return {
    el: container,
    unmount: () => {
      flushSync(() => root.unmount());
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

function titleProps(overrides: Partial<React.ComponentProps<typeof ChatTitle>> = {}): React.ComponentProps<typeof ChatTitle> {
  return {
    activeSessionId: 's-1',
    title: 'Promises in JavaScript',
    isRenaming: false,
    draft: '',
    onStartRename: mock(() => {}),
    onDraftChange: mock(() => {}),
    onFinishRename: mock(() => {}),
    onKeyDown: mock(() => {}),
    ...overrides,
  };
}

describe('ChatTitle', () => {
  test('shows the chat title as a heading; clicking it starts a rename', () => {
    const props = titleProps();
    const { el, unmount } = mount(React.createElement(ChatTitle, props));
    const button = el.querySelector('h1 .chat-title-button') as HTMLButtonElement;
    expect(button.textContent).toContain('Promises in JavaScript');
    expect(button.disabled).toBe(false);
    flushSync(() => button.click());
    expect(props.onStartRename).toHaveBeenCalledTimes(1);
    unmount();
  });

  test('a new chat (no session yet) cannot be renamed', () => {
    const props = titleProps({ activeSessionId: '', title: 'New chat' });
    const { el, unmount } = mount(React.createElement(ChatTitle, props));
    const button = el.querySelector('.chat-title-button') as HTMLButtonElement;
    expect(button.textContent).toBe('New chat');
    expect(button.disabled).toBe(true);
    unmount();
  });

  test('while renaming, a field carrying the draft replaces the heading', () => {
    const props = titleProps({ isRenaming: true, draft: 'Draft title' });
    const { el, unmount } = mount(React.createElement(ChatTitle, props));
    const input = el.querySelector('input.chat-title-input') as HTMLInputElement;
    expect(input.value).toBe('Draft title');
    expect(el.querySelector('h1')).toBeNull();
    unmount();
  });
});

describe('ChatFindButton', () => {
  test('toggles and is pressed while open', () => {
    const onToggle = mock(() => {});
    const closed = mount(React.createElement(ChatFindButton, { open: false, onToggle }));
    const button = closed.el.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    flushSync(() => button.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
    closed.unmount();

    const open = mount(React.createElement(ChatFindButton, { open: true, onToggle }));
    expect(open.el.querySelector('button')?.getAttribute('aria-pressed')).toBe('true');
    open.unmount();
  });
});

describe('ChatTurnNotice: paused-stream retry affordance', () => {
  test('with onRetryStream, a Retry control renders beside the given notice', () => {
    const onRetryStream = mock(() => {});
    const { el, unmount } = mount(React.createElement(ChatTurnNotice, { label: 'Live updates are off.', onRetryStream }));
    const retry = el.querySelector('.chat-status__retry') as HTMLButtonElement | null;
    expect(retry).not.toBeNull();
    expect(el.textContent).toContain('Live updates are off.');
    unmount();
  });

  test('clicking Retry fires onRetryStream', () => {
    const onRetryStream = mock(() => {});
    const { el, unmount } = mount(React.createElement(ChatTurnNotice, { label: '', onRetryStream }));
    const retry = el.querySelector('.chat-status__retry') as HTMLButtonElement;
    flushSync(() => retry.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(onRetryStream).toHaveBeenCalledTimes(1);
    unmount();
  });

  test('nothing to say and nothing to retry renders nothing', () => {
    const { el, unmount } = mount(React.createElement(ChatTurnNotice, { label: '' }));
    expect(el.innerHTML).toBe('');
    unmount();
  });
});
