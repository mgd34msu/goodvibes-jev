/**
 * CommandPalette on the kit: a labelled modal dialog portaled to the body,
 * results grouped Chats / Go to / Actions / Settings in that order, keyboard
 * order equal to screen order, Enter runs, Escape closes the palette only, the
 * scrim closes it, and focus returns to the opener.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { CommandPalette, formatShortcut } from './CommandPalette';
import { getCommands, registerCommand, unregisterCommand, type CommandDef } from '../../lib/commands';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let closes = 0;
let opener: HTMLButtonElement;

function renderPalette(open: boolean): void {
  flushSync(() => {
    root.render(<CommandPalette open={open} onClose={() => { closes += 1; }} />);
  });
}

function key(k: string, shiftKey = false, target?: Element | null): KeyboardEvent {
  const el = target ?? document.querySelector('input[aria-label="Search commands"]');
  if (!el) throw new Error('palette input not found');
  const event = new window.KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true });
  flushSync(() => { el.dispatchEvent(event); });
  return event;
}

function type(text: string): void {
  const input = document.querySelector('input[aria-label="Search commands"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  flushSync(() => {
    setter.call(input, text);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

const options = () => [...document.querySelectorAll('[role="option"]')] as HTMLElement[];
const activeTitle = () => document.querySelector('[role="option"][aria-selected="true"] .cmd-item-title')?.textContent;

function cmd(id: string, overrides: Partial<CommandDef> = {}): CommandDef {
  return { id, title: id, group: 'system', run: () => undefined, ...overrides };
}

beforeEach(() => {
  for (const c of getCommands()) unregisterCommand(c.id);
  closes = 0;
  opener = document.createElement('button');
  document.body.appendChild(opener);
  opener.focus();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  opener.remove();
  for (const c of getCommands()) unregisterCommand(c.id);
});

describe('CommandPalette: rendering', () => {
  test('renders nothing when closed', () => {
    renderPalette(false);
    expect(document.querySelector('[aria-label="Command palette"]')).toBeNull();
  });

  test('opening puts focus in the search field', () => {
    registerCommand(cmd('a'));
    renderPalette(true);
    expect(document.querySelector('[aria-label="Command palette"]')).not.toBeNull();
    const input = document.querySelector('input[aria-label="Search commands"]')!;
    expect(document.activeElement).toBe(input);
  });

  test('orders results by group: chats, navigation, system, settings', () => {
    registerCommand(cmd('s', { title: 'Account', group: 'settings' }));
    registerCommand(cmd('a', { title: 'Toggle theme', group: 'system' }));
    registerCommand(cmd('g', { title: 'Go to Work', group: 'navigation' }));
    registerCommand(cmd('c', { title: 'Release notes chat', group: 'chats' }));
    renderPalette(true);
    expect(options().map((o) => o.querySelector('.cmd-item-title')?.textContent)).toEqual([
      'Release notes chat',
      'Go to Work',
      'Toggle theme',
      'Account',
    ]);
  });

  test('shows each command formatted shortcut', () => {
    registerCommand(cmd('a', { shortcut: 'mod+shift+n' }));
    registerCommand(cmd('b', { shortcut: 'g c' }));
    renderPalette(true);
    const kbds = [...document.querySelectorAll('.cmd-item-kbd')].map((k) => k.textContent);
    expect(kbds).toContain(formatShortcut('mod+shift+n'));
    expect(kbds).toContain(formatShortcut('g c'));
  });

  test('a query matching nothing leaves no options', () => {
    registerCommand(cmd('a'));
    renderPalette(true);
    type('zzzzzz');
    expect(options().length).toBe(0);
  });
});

describe('CommandPalette: keyboard', () => {
  beforeEach(() => {
    registerCommand(cmd('one', { title: 'Settings one', group: 'settings' }));
    registerCommand(cmd('two', { title: 'Go two', group: 'navigation' }));
    registerCommand(cmd('three', { title: 'Act three', group: 'system' }));
  });

  test('the first on-screen result is active; Down and Up follow screen order and clamp', () => {
    renderPalette(true);
    expect(activeTitle()).toBe('Go two');
    key('ArrowDown');
    expect(activeTitle()).toBe('Act three');
    key('ArrowDown');
    key('ArrowDown');
    expect(activeTitle()).toBe('Settings one');
    key('ArrowUp');
    key('ArrowUp');
    key('ArrowUp');
    expect(activeTitle()).toBe('Go two');
  });

  test('Tab and Shift Tab step through results and keep focus in the field', () => {
    renderPalette(true);
    const input = document.querySelector('input[aria-label="Search commands"]');
    const event = key('Tab');
    expect(event.defaultPrevented).toBe(true);
    expect(activeTitle()).toBe('Act three');
    expect(document.activeElement).toBe(input);
    key('Tab', true);
    expect(activeTitle()).toBe('Go two');
  });

  test('aria-activedescendant names the active option', () => {
    renderPalette(true);
    const input = document.querySelector('input[aria-label="Search commands"]')!;
    key('ArrowDown');
    const active = document.querySelector('[role="option"][aria-selected="true"]')!;
    expect(input.getAttribute('aria-activedescendant')).toBe(active.id);
  });

  test('Enter runs the active command and closes', () => {
    let ran = '';
    registerCommand(cmd('run', { title: 'Run me', group: 'navigation', run: () => { ran = 'run'; } }));
    renderPalette(true);
    type('run me');
    key('Enter');
    expect(ran).toBe('run');
    expect(closes).toBe(1);
  });

  test('Escape closes the palette only: window listeners underneath never see it', () => {
    renderPalette(true);
    let windowSaw = false;
    const onWindow = (e: KeyboardEvent) => { if (e.key === 'Escape') windowSaw = true; };
    window.addEventListener('keydown', onWindow);
    key('Escape');
    window.removeEventListener('keydown', onWindow);
    expect(closes).toBe(1);
    expect(windowSaw).toBe(false);
  });
});

describe('CommandPalette: pointer, filter, registry, focus', () => {
  test('clicking a result runs it; clicking the scrim closes without running', () => {
    let ran = 0;
    registerCommand(cmd('click', { title: 'Click me', run: () => { ran += 1; } }));
    renderPalette(true);
    flushSync(() => (document.querySelector('.cmd-overlay > .scrim') as HTMLElement).click());
    expect(closes).toBe(1);
    expect(ran).toBe(0);
    flushSync(() => options()[0].click());
    expect(ran).toBe(1);
    expect(closes).toBe(2);
  });

  test('typing narrows the results; clearing restores them', () => {
    registerCommand(cmd('a', { title: 'Alpha command' }));
    registerCommand(cmd('b', { title: 'Beta command' }));
    registerCommand(cmd('c', { title: 'Gamma place', group: 'navigation' }));
    renderPalette(true);
    expect(options().length).toBe(3);
    type('command');
    expect(options().map((o) => o.querySelector('.cmd-item-title')?.textContent).sort()).toEqual(['Alpha command', 'Beta command']);
    type('');
    expect(options().length).toBe(3);
  });

  test('registry changes show up while open', () => {
    registerCommand(cmd('a'));
    renderPalette(true);
    expect(options().length).toBe(1);
    flushSync(() => registerCommand(cmd('b')));
    expect(options().length).toBe(2);
  });

  test('closing returns focus to the opener', () => {
    registerCommand(cmd('a'));
    renderPalette(true);
    renderPalette(false);
    expect(document.activeElement).toBe(opener);
  });
});
