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
import type { BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let closes = 0;
let opener: HTMLButtonElement;
const originalFetch = globalThis.fetch;
type RankRequest = BrowserJudgmentRequest<'webui.palette.command-rank'>;
function answer(request: RankRequest, outcome: 'act' | 'confirm' | 'escalate' = 'act', selected = 0): Response {
  const count = request.input.candidates.length;
  return new Response(JSON.stringify({ protocolVersion: 1, battery: request.battery, batteryVersion: 1, requestId: request.requestId,
    ...(outcome === 'act' ? { status: 'settled', value: { registryVersion: request.input.registryVersion,
      accepted: [{ candidateIndex: selected, probability: 0.93 }], rejected: Array.from({ length: count }, (_, i) => i).filter((i) => i !== selected) } }
      : { status: 'held', reason: 'uncertain' }), outcome,
    readings: Object.fromEntries(Array.from({ length: count }, (_, i) => [`candidate_${i}`, { kind: 'yes-no',
      probability: i === selected ? 0.93 : 0.03, verdict: i === selected ? 'yes' : 'no', outcome: i === selected ? outcome : 'act' }])),
    evidence: Array.from({ length: count }, (_, i) => ({ decisionId: `fixture-${i}`, model: 'fixture-v1', requestedModel: 'fixture', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 })),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Expected palette state did not appear');
}

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
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ status: 'held', error: { code: 'JUDGMENT_UNAVAILABLE' } }), { status: 503 })) as typeof fetch;
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
  globalThis.fetch = originalFetch;
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

  test('Enter runs an explicitly browsed command and closes', () => {
    for (const c of getCommands()) unregisterCommand(c.id);
    let ran = '';
    registerCommand(cmd('run', { title: 'Run me', group: 'navigation', run: () => { ran = 'run'; } }));
    renderPalette(true);
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

  test('typing clears unranked rows while reading; clearing restores manual browse', () => {
    registerCommand(cmd('a', { title: 'Alpha command' }));
    registerCommand(cmd('b', { title: 'Beta command' }));
    registerCommand(cmd('c', { title: 'Gamma place', group: 'navigation' }));
    renderPalette(true);
    expect(options().length).toBe(3);
    type('command');
    expect(options()).toHaveLength(0);
    expect(document.querySelector('[data-search-status="loading"]')).not.toBeNull();
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

describe('CommandPalette: admitted semantic search', () => {
  let ran: string[];
  beforeEach(() => {
    for (const c of getCommands()) unregisterCommand(c.id);
    ran = [];
    registerCommand(cmd('chat.new', { title: 'New Chat', group: 'chat', run: () => ran.push('chat.new') }));
    registerCommand(cmd('nav.chat', { title: 'Go to Chat', group: 'navigation', run: () => ran.push('nav.chat') }));
  });

  test('a nonlexical answer selects only the real indexed command and keeps Enter behavior', async () => {
    globalThis.fetch = (async (_url, init) => answer(JSON.parse(String(init?.body)) as RankRequest)) as typeof fetch;
    renderPalette(true); type('begin afresh');
    key('Enter'); expect(ran).toEqual([]);
    await until(() => options().length === 1);
    expect(activeTitle()).toBe('New Chat');
    key('Enter'); expect(ran).toEqual(['chat.new']); expect(closes).toBe(1);
  });

  test('ArrowDown during a deferred reading preserves the first actionable result', async () => {
    let pending!: { request: RankRequest; finish: (response: Response) => void };
    globalThis.fetch = ((_url, init) => new Promise<Response>((finish) => {
      pending = { request: JSON.parse(String(init?.body)) as RankRequest, finish };
    })) as typeof fetch;
    renderPalette(true); type('begin afresh');
    await until(() => Boolean(pending));
    key('ArrowDown'); key('ArrowDown'); key('Enter');
    expect(ran).toEqual([]);
    pending.finish(answer(pending.request));
    await until(() => options().length === 1);
    expect(activeTitle()).toBe('New Chat');
    key('Enter'); expect(ran).toEqual(['chat.new']); expect(closes).toBe(1);
  });

  test.each(['confirm', 'escalate'] as const)('%s holds have no inferred executable rows', async (outcome) => {
    globalThis.fetch = (async (_url, init) => answer(JSON.parse(String(init?.body)) as RankRequest, outcome)) as typeof fetch;
    renderPalette(true); type('New Chat');
    await until(() => document.querySelector('[data-search-status="held"]') !== null);
    expect(options()).toHaveLength(0);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(outcome === 'confirm' ? 'need review' : 'could not resolve');
    key('Enter'); expect(ran).toEqual([]); expect(closes).toBe(0);
  });

  test('an unavailable service offers explicit manual browse without invented matches', async () => {
    renderPalette(true); type('New Chat');
    await until(() => document.querySelector('[data-search-status="unavailable"]') !== null);
    key('Enter'); expect(ran).toEqual([]); expect(options()).toHaveLength(0);
    const browse = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Browse all commands');
    browse!.focus();
    flushSync(() => browse!.click());
    expect(document.activeElement).toBe(document.querySelector('input[aria-label="Search commands"]'));
    expect(document.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe('Browse all commands');
    expect(options()).toHaveLength(2);
    key('ArrowDown'); expect(activeTitle()).toBe('New Chat');
    key('Enter'); expect(ran).toEqual(['chat.new']);
  });

  test('editing the query aborts the old request and a late answer cannot replace newer matches', async () => {
    let first!: { request: RankRequest; signal: AbortSignal; finish: (response: Response) => void };
    globalThis.fetch = ((_url, init) => {
      const request = JSON.parse(String(init?.body)) as RankRequest;
      if (request.input.query.kind === 'inline' && request.input.query.text === 'first') {
        return new Promise<Response>((finish) => { first = { request, signal: init!.signal!, finish }; });
      }
      return Promise.resolve(answer(request, 'act', 1));
    }) as typeof fetch;
    renderPalette(true); type('first');
    await until(() => Boolean(first));
    type('second'); expect(first.signal.aborted).toBe(true);
    await until(() => options().length === 1);
    expect(activeTitle()).toBe('Go to Chat');
    first.finish(answer(first.request, 'act', 0));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(activeTitle()).toBe('Go to Chat');
    key('Enter'); expect(ran).toEqual(['nav.chat']);
  });

  test('closing aborts a pending request and reopening starts from manual browse', async () => {
    let pending!: { request: RankRequest; signal: AbortSignal; finish: (response: Response) => void };
    globalThis.fetch = ((_url, init) => new Promise<Response>((finish) => { pending = { request: JSON.parse(String(init?.body)) as RankRequest, signal: init!.signal!, finish }; })) as typeof fetch;
    renderPalette(true); type('New Chat');
    await until(() => Boolean(pending));
    renderPalette(false); expect(pending.signal.aborted).toBe(true);
    pending.finish(answer(pending.request));
    renderPalette(true);
    expect((document.querySelector('input[aria-label="Search commands"]') as HTMLInputElement).value).toBe('');
    expect(options()).toHaveLength(2); expect(ran).toEqual([]);
  });
});
