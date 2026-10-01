/**
 * DOM render tests for CommandProvider
 *
 * Covers: children rendering, command registration lifecycle (mount/unmount),
 * mod+k opens palette, Escape closes palette via dialog keydown,
 * onNavigate is called by registered nav commands.
 *
 * Uses react-dom/client + flushSync (same pattern as useAnnouncer.test.tsx).
 * Registry is cleaned before/after each test.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import CommandProvider from './CommandProvider';
import { getCommands, unregisterCommand } from '../../lib/commands';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Root = ReturnType<typeof createRoot>;

function renderProvider(
  props: React.ComponentProps<typeof CommandProvider>,
): { container: HTMLElement; root: Root; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => { root.render(<CommandProvider {...props} />); });
  return {
    container,
    root,
    unmount: () => {
      flushSync(() => { root.unmount(); });
      container.parentNode?.removeChild(container);
    },
  };
}

/**
 * Fire a keydown event on the document (where useHotkeys listens),
 * then flush synchronously.
 */
function fireDocKeyDown(key: string, options: KeyboardEventInit = {}): void {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, ...options });
  // Wrap dispatch inside flushSync: the useHotkeys handler calls setState;
  // flushSync forces synchronous commit so the re-render happens before we assert.
  flushSync(() => { document.dispatchEvent(event); });
}

/** Fire a keydown event on a specific element and flush. */
function fireKeyDown(el: HTMLElement, key: string, options: KeyboardEventInit = {}): void {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, ...options });
  el.dispatchEvent(event);
  flushSync(() => {});
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Wipe any commands left over from other test files.
  for (const cmd of getCommands()) {
    unregisterCommand(cmd.id);
  }
});

afterEach(() => {
  for (const cmd of getCommands()) {
    unregisterCommand(cmd.id);
  }
});

// ---------------------------------------------------------------------------
// Children
// ---------------------------------------------------------------------------

describe('CommandProvider: children', () => {
  test('renders children into the DOM', () => {
    const { container, unmount } = renderProvider({
      children: <span data-testid="child">Hello</span>,
    });
    expect(container.querySelector('[data-testid="child"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="child"]')?.textContent).toBe('Hello');
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

describe('CommandProvider: command registration', () => {
  test('registers default commands on mount', () => {
    const { unmount } = renderProvider({});
    const ids = getCommands().map((c) => c.id);
    expect(ids).toContain('nav.chat');
    expect(ids).toContain('nav.knowledge');
    expect(ids).toContain('nav.providers');
    expect(ids).toContain('nav.admin');
    expect(ids).toContain('chat.new');
    expect(ids).toContain('system.palette');
    expect(ids).toContain('system.shortcuts');
    // Every settings section except models (nav.providers) is a Settings command.
    expect(ids).toContain('settings.account');
    expect(ids).not.toContain('settings.models');
    expect(getCommands().find((c) => c.id === 'nav.admin')?.group).toBe('settings');
    unmount();
  });

  test('unregisters default commands on unmount', () => {
    const { unmount } = renderProvider({});
    // Confirm they exist first.
    expect(getCommands().map((c) => c.id)).toContain('nav.chat');
    unmount();
    // After unmount, the cleanup function should have removed them.
    const idsAfter = getCommands().map((c) => c.id);
    expect(idsAfter).not.toContain('nav.chat');
    expect(idsAfter).not.toContain('nav.knowledge');
    expect(idsAfter).not.toContain('system.palette');
  });

  test('onNavigate is called when nav.chat command runs', () => {
    const onNavigate = mock(() => undefined);
    const { unmount } = renderProvider({ onNavigate });
    const chatCmd = getCommands().find((c) => c.id === 'nav.chat');
    expect(chatCmd).toBeDefined();
    chatCmd!.run();
    expect(onNavigate).toHaveBeenCalledTimes(1);
    // onNavigate?.('chat') passes only one argument, no second arg is passed.
    expect(onNavigate).toHaveBeenCalledWith('chat');
    unmount();
  });

  test('the old Providers and Admin commands open the settings dialog instead of a page', () => {
    const onNavigate = mock(() => undefined);
    const onOpenSettings = mock((_section?: string) => undefined);
    const { unmount } = renderProvider({ onNavigate, onOpenSettings });
    getCommands().find((c) => c.id === 'nav.providers')!.run();
    expect(onOpenSettings).toHaveBeenLastCalledWith('models');
    getCommands().find((c) => c.id === 'nav.admin')!.run();
    expect(onOpenSettings).toHaveBeenCalledTimes(2);
    expect(onNavigate).not.toHaveBeenCalled();
    unmount();
  });

  test('onNavigate is called with newChat option for chat.new command', () => {
    const onNavigate = mock(() => undefined);
    const { unmount } = renderProvider({ onNavigate });
    const newChatCmd = getCommands().find((c) => c.id === 'chat.new');
    expect(newChatCmd).toBeDefined();
    newChatCmd!.run();
    expect(onNavigate).toHaveBeenCalledWith('chat', { newChat: true });
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Palette open / close
// ---------------------------------------------------------------------------

describe('CommandProvider: palette open/close', () => {
  test('palette is closed on initial render', () => {
    const { unmount } = renderProvider({});
    expect(document.querySelector('[aria-label="Command palette"]')).toBeNull();
    unmount();
  });

  test('mod+k opens the command palette', () => {
    const { unmount } = renderProvider({});
    // 'mod' normalises to Control in test env (no navigator.platform).
    fireDocKeyDown('k', { ctrlKey: true });
    expect(document.querySelector('[aria-label="Command palette"]')).not.toBeNull();
    unmount();
  });

  test('mod+k toggles palette closed when already open', () => {
    const { unmount } = renderProvider({});
    fireDocKeyDown('k', { ctrlKey: true });
    expect(document.querySelector('[aria-label="Command palette"]')).not.toBeNull();

    // Second mod+k should close it.
    fireDocKeyDown('k', { ctrlKey: true });
    expect(document.querySelector('[aria-label="Command palette"]')).toBeNull();
    unmount();
  });

  test('Escape closes the palette via dialog keydown', () => {
    const { unmount } = renderProvider({});
    // Open first.
    fireDocKeyDown('k', { ctrlKey: true });
    const dialog = document.querySelector('[aria-label="Command palette"]') as HTMLElement | null;
    expect(dialog).not.toBeNull();

    // Fire Escape on the dialog itself (CommandPalette owns Escape via onKeyDown).
    fireKeyDown(dialog!, 'Escape');
    expect(document.querySelector('[aria-label="Command palette"]')).toBeNull();
    unmount();
  });
});
