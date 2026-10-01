/**
 * WorkView against a mocked SDK: Needs you comes first and the first item
 * opens by itself; the approval detail approves (with a Remember tier, an
 * exec-prompt answer, a hunk subset) and denies (with a reason); the push
 * hand-off fragments complete; the kind filter, the old Checkpoints link, the
 * hosted attach and detach, process actions behind the confirm sheet, and the
 * honesty rules (no "price unknown", no polling text).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const calls = {
  approve: [] as { id: string; input?: unknown }[],
  deny: [] as { id: string; input?: unknown }[],
  watchersStop: [] as string[],
  observedSteer: [] as { id: string; text: string }[],
  attach: [] as string[],
  detach: [] as string[],
  close: [] as string[],
  tasksCancel: [] as string[],
};

const T = 1_700_000_000_000;

const PENDING = {
  id: 'ap-1', callId: 'c1', sessionId: 's-agent', status: 'pending', createdAt: T, updatedAt: T, metadata: {},
  request: {
    callId: 'c1', tool: 'bash', args: { command: 'bun test --timeout=60000' }, category: 'shell',
    analysis: { riskLevel: 'medium', summary: 'Run the full test suite', reasons: ['Runs code'] },
    rememberOptions: [{ tier: 'exact', label: 'This exact command', detail: 'Never ask again for exactly this command.' }],
  },
};
const EXEC_PROMPT = {
  id: 'ap-2', callId: 'c2', status: 'pending', createdAt: T - 10, updatedAt: T, metadata: {},
  request: {
    callId: 'c2', tool: 'exec:prompt', args: { command: 'npm init', prompt: 'package name:', recentOutput: '' }, category: 'exec',
    analysis: { riskLevel: 'low', summary: '', reasons: [] },
    attribution: { kind: 'exec-prompt', command: 'npm init', prompt: 'package name:' },
  },
};
const EDIT = {
  id: 'ap-3', callId: 'c3', status: 'pending', createdAt: T - 20, updatedAt: T, metadata: {},
  request: {
    callId: 'c3', tool: 'edit', category: 'write',
    args: { edits: [{ path: 'a.ts', find: 'a', replace: 'b' }, { path: 'b.ts', find: 'c', replace: 'd' }] },
    analysis: { riskLevel: 'low', summary: 'Edit a.ts', reasons: [] },
  },
};

let approvals: unknown[] = [PENDING];
let contextWindow: number | null | undefined = 10000;
let contextUsagePct: number | null = 10;
let contextError: Error | null = null;
const NODES = [
  {
    id: 'agent-1', kind: 'agent', label: 'Root agent', state: 'thinking', elapsedMs: 5000, startedAt: T,
    costUsd: null, costState: 'unpriced',
    capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: true },
    sessionRef: { sessionId: 's-agent', agentId: 'agent-1' },
  },
  {
    id: 'watcher-1', kind: 'watcher', label: 'PR watcher', state: 'idle', elapsedMs: 1000, startedAt: T,
    costUsd: 0.3, costState: 'priced',
    capabilities: { interruptible: false, killable: true, pausable: false, resumable: false, steerable: false },
  },
  {
    id: 'ext-1', kind: 'observed-external', label: 'Claude Code', state: 'thinking', elapsedMs: 1000, startedAt: T,
    costUsd: null, costState: 'unpriced',
    capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false },
    observed: { pid: 4242, liveness: { state: 'active', detail: 'cpu advancing' }, steer: { kind: 'tmux', paneId: '%3' } },
  },
];
const SESSIONS = {
  totals: {},
  sessions: [{ id: 's-agent', kind: 'tui', project: 'goodvibes', title: 'Refactor the spine', status: 'active', createdAt: T, updatedAt: T, messageCount: 3, surfaceKinds: [] }],
};
const HOSTED = [
  { id: 'h-1', title: 'Hosted one', status: 'idle', workspaceRoot: '/w', turnCount: 1, messageCount: 1, createdAt: T, updatedAt: T, effectiveDetachPolicy: 'survive', attachedClients: [] },
  { id: 'h-2', title: 'Hosted two', status: 'idle', workspaceRoot: '/w2', turnCount: 0, messageCount: 0, createdAt: T, updatedAt: T - 1, effectiveDetachPolicy: 'kill', attachedClients: [] },
];

mock.module('../../lib/goodvibes', () => ({
  DEFAULT_SSE_RECONNECT: { enabled: true, baseDelayMs: 1, maxDelayMs: 2, backoffFactor: 2, maxAttempts: 3 },
  WEBUI_SURFACE_ID: 'goodvibes-webui',
  WEBUI_SURFACE_KIND: 'webui',
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  hostedSessionDetachBeacon: () => {},
  sdk: {
    streams: { open: () => Promise.resolve(() => {}) },
    operator: {
      fleet: {
        snapshot: () => Promise.resolve({ capturedAt: T, truncated: false, totalCount: NODES.length, nodes: NODES }),
        archivedList: () => Promise.resolve({ capturedAt: T, nodes: [] }),
        archiveFinished: () => Promise.resolve({ archivedCount: 0 }),
        archive: () => Promise.resolve({ archived: true, count: 1 }),
        unarchive: () => Promise.resolve({ restored: 1 }),
        attempts: { list: () => Promise.resolve({ groups: [] }) },
        observed: {
          steer: (id: string, text: string) => {
            calls.observedSteer.push({ id, text });
            return Promise.resolve({ queued: true, messageId: 'm' });
          },
        },
      },
      watchers: {
        stop: (id: string) => {
          calls.watchersStop.push(id);
          return Promise.resolve({ id, kind: 'watcher', label: 'x', state: 'killed' });
        },
      },
      approvals: {
        list: () => Promise.resolve({ approvals }),
        approve: (id: string, input?: unknown) => {
          calls.approve.push({ id, input });
          return Promise.resolve({ approval: { ...PENDING, id, status: 'approved' }, recorded: { approved: true, rememberTier: 'exact', reasonStored: false, modifiedArgsDelivered: true } });
        },
        deny: (id: string, input?: unknown) => {
          calls.deny.push({ id, input });
          return Promise.resolve({ approval: { ...PENDING, id, status: 'denied' }, recorded: { approved: false, rememberTier: null, reasonStored: true, modifiedArgsDelivered: false } });
        },
        claim: () => Promise.resolve({ approval: {} }),
        cancel: () => Promise.resolve({ approval: {} }),
      },
      sessions: {
        list: () => Promise.resolve(SESSIONS),
        messages: { list: () => Promise.resolve({ messages: [{ id: 'm1', role: 'user', body: 'hello there' }] }) },
        close: (id: string) => { calls.close.push(id); return Promise.resolve({}); },
        reopen: () => Promise.resolve({}),
        delete: () => Promise.resolve({}),
        steer: () => Promise.resolve({}),
        followUp: () => Promise.resolve({}),
        detach: () => Promise.resolve({}),
        permissionMode: { get: () => Promise.resolve({ mode: 'normal' }), set: () => Promise.resolve({}) },
        contextUsage: { get: () => contextError ? Promise.reject(contextError) : Promise.resolve({ estimatedContextTokens: 1000, contextWindow, contextUsagePct, estimated: true }) },
        hosted: {
          list: () => Promise.resolve({ sessions: HOSTED }),
          attach: (id: string) => {
            calls.attach.push(id);
            return Promise.resolve({ session: HOSTED.find((h) => h.id === id), history: [{ role: 'user', content: 'from history', at: 1 }] });
          },
          detach: (id: string) => {
            calls.detach.push(id);
            return Promise.resolve({ session: HOSTED.find((h) => h.id === id) });
          },
          kill: () => Promise.resolve({}),
          create: () => Promise.resolve({}),
        },
      },
      tasks: {
        list: () => Promise.resolve({ queued: 0, running: 1, blocked: 0, totals: {}, tasks: [{ id: 't-1', kind: 'exec', title: 'Nightly build', status: 'running', owner: 'me', queuedAt: T, cancellable: true }] }),
        cancel: (id: string) => { calls.tasksCancel.push(id); return Promise.resolve({}); },
        retry: () => Promise.resolve({}),
        create: () => Promise.resolve({}),
      },
      ci: { watches: { list: () => Promise.resolve({ watches: [] }) } },
      checkpoints: {
        list: () => Promise.resolve({ checkpoints: [{ id: 'wcp_1', kind: 'manual', label: 'Before the pass', createdAt: T, parentId: null, retentionClass: 'standard', commit: 'aaaa', sizeBytes: 10 }] }),
      },
      control: { methodInfo: () => Promise.resolve({}) },
      cost: { attribution: { get: () => Promise.resolve({ rows: [] }) } },
      permissions: { rules: { list: () => Promise.resolve({ rules: [] }) } },
    },
  },
}));

const { WorkView } = await import('./WorkView');
const { ToastProvider } = await import('../../lib/toast');
const { ToastViewport } = await import('../../components/toast/ToastViewport');

let tabChanges: string[] = [];

function render(tab?: string): { el: HTMLElement; unmount: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        ToastProvider,
        null,
        React.createElement(WorkView, { tab, onTabChange: (next: string) => { tabChanges.push(next); } }),
        React.createElement(ToastViewport),
      ),
    ));
  });
  return {
    // document.body: kit overlays (dialogs, drawers, menus) portal there.
    el: document.body,
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

function click(el: Element | null | undefined) {
  if (!el) throw new Error('click target missing');
  flushSync(() => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

function type(el: Element | null | undefined, value: string) {
  if (!el) throw new Error('type target missing');
  const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

function button(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text);
}

function rowButton(scope: ParentNode, title: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('.gv-row__main')].find((b) => b.textContent?.includes(title));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync(() => {});
  }
}

afterEach(() => {
  for (const list of Object.values(calls)) list.length = 0;
  approvals = [PENDING];
  contextWindow = 10000;
  contextUsagePct = 10;
  contextError = null;
  tabChanges = [];
  window.history.replaceState(null, '', '/');
  document.body.innerHTML = '';
});

describe('the Work list', () => {
  test('the first item that needs you opens in the detail', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('.dv-detail')));
    const detail = el.querySelector('.dv-detail')!;
    expect(detail.textContent).toContain('Run the full test suite');
    expect(detail.textContent).toContain('bun test --timeout=60000');
    unmount();
  });

  test('a priced process shows its cost', async () => {
    const { el, unmount } = render();
    await waitFor(() => (el.textContent ?? '').includes('PR watcher'));
    expect(rowButton(el, 'PR watcher')?.closest('.gv-row')?.textContent).toContain('$0.30');
    unmount();
  });

  test('the kind filter keeps only that kind; the segmented control reports the change', async () => {
    const { el, unmount } = render('processes');
    await waitFor(() => (el.textContent ?? '').includes('PR watcher'));
    expect(el.textContent).toContain('Nightly build');
    expect(rowButton(el, 'Refactor the spine')).toBeUndefined();
    expect(rowButton(el, 'Root agent')).toBeUndefined();
    click([...el.querySelectorAll('[role="radio"]')].find((r) => r.textContent === 'Sessions'));
    expect(tabChanges).toEqual(['sessions']);
    unmount();
  });
});

describe('the approval detail', () => {
  test('Approve with a Remember tier sends the tier', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('button[aria-label="Remember scope for bash"]')));
    click(el.querySelector('button[aria-label="Remember scope for bash"]'));
    click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes('This exact command')));
    click(button(el.querySelector('.dv-detail')!, 'Approve'));
    await waitFor(() => calls.approve.length === 1);
    expect(calls.approve[0]).toMatchObject({ id: 'ap-1', input: { rememberTier: 'exact', remember: true } });
    unmount();
  });

  test('Deny sends the optional reason on both wire fields', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('input[aria-label="Deny reason for bash"]')));
    type(el.querySelector('input[aria-label="Deny reason for bash"]'), 'not now');
    click(button(el.querySelector('.dv-detail')!, 'Deny'));
    await waitFor(() => calls.deny.length === 1);
    expect(calls.deny[0]).toEqual({ id: 'ap-1', input: { note: 'not now', reason: 'not now' } });
    unmount();
  });

  test('an exec prompt is answered: the answer rides modifiedArgs', async () => {
    approvals = [EXEC_PROMPT];
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('input[aria-label="Answer for npm init"]')));
    type(el.querySelector('input[aria-label="Answer for npm init"]'), 'my-pkg');
    click(button(el, 'Send answer'));
    await waitFor(() => calls.approve.length === 1);
    expect(calls.approve[0]).toMatchObject({ id: 'ap-2', input: { modifiedArgs: { answer: 'my-pkg' } } });
    unmount();
  });

  test('an edit approval can approve a subset of hunks, by index only', async () => {
    approvals = [EDIT];
    const { el, unmount } = render();
    await waitFor(() => el.querySelectorAll('.work-hunks input[type="checkbox"]').length === 2);
    expect(el.querySelector('.dv-detail .dv-code')?.textContent).toContain('a.ts');
    click(el.querySelectorAll('.work-hunks input[type="checkbox"]')[1]);
    click(button(el, 'Approve selected (1)'));
    await waitFor(() => calls.approve.length === 1);
    expect(calls.approve[0]).toMatchObject({ id: 'ap-3', input: { selectedHunks: [1] } });
    unmount();
  });

  test('a push notification hand-off completes the approval on mount and scrubs the fragment', async () => {
    window.history.replaceState(null, '', '/?view=work#approval-action=approve&approval-id=ap-1');
    const { unmount } = render();
    await waitFor(() => calls.approve.length === 1);
    expect(calls.approve[0].id).toBe('ap-1');
    expect(window.location.hash).toBe('');
    unmount();
  });
});

describe('details', () => {
  test('a needs-input deep link opens that process', async () => {
    window.history.replaceState(null, '', '/?view=work#fleet-node=agent-1&fleet-session=s-agent');
    const { el, unmount } = render();
    await waitFor(() => (el.querySelector('.dv-detail')?.textContent ?? '').includes('Root agent'));
    expect(el.querySelector('.dv-detail')?.textContent).toContain('s-agent');
    unmount();
  });

  test('stopping a watcher confirms first, then calls watchers.stop', async () => {
    const { el, unmount } = render('processes');
    await waitFor(() => Boolean(rowButton(el, 'PR watcher')));
    click(rowButton(el, 'PR watcher'));
    click(button(el.querySelector('.dv-detail')!, 'Stop'));
    expect(calls.watchersStop).toEqual([]);
    await waitFor(() => Boolean(document.querySelector('.gv-confirm__confirm')));
    click(document.querySelector('.gv-confirm__confirm'));
    await waitFor(() => calls.watchersStop.length === 1);
    expect(calls.watchersStop).toEqual(['watcher-1']);
    unmount();
  });

  test('an observed external agent can be steered over its tmux channel and offers no stop', async () => {
    const { el, unmount } = render('agents');
    await waitFor(() => Boolean(rowButton(el, 'Claude Code')));
    click(rowButton(el, 'Claude Code'));
    const detail = el.querySelector('.dv-detail')!;
    expect(button(detail, 'Stop')).toBeUndefined();
    type(detail.querySelector('textarea'), 'please rebase');
    click(button(detail, 'Send'));
    await waitFor(() => calls.observedSteer.length === 1);
    expect(calls.observedSteer[0]).toEqual({ id: 'ext-1', text: 'please rebase' });
    unmount();
  });

  test('the old Checkpoints link opens the first session on its Checkpoints tab', async () => {
    const { el, unmount } = render('checkpoints');
    await waitFor(() => (el.querySelector('.dv-detail')?.textContent ?? '').includes('Before the pass'));
    const checked = el.querySelector('.dv-detail [role="radio"][aria-checked="true"]');
    expect(checked?.textContent).toBe('Checkpoints');
    expect(el.querySelector('.dv-detail')?.textContent).toContain('Refactor the spine');
    unmount();
  });

  test('a session closes only after the confirm sheet', async () => {
    approvals = [];
    const { el, unmount } = render('sessions');
    await waitFor(() => Boolean(rowButton(el, 'Refactor the spine')));
    click(rowButton(el, 'Refactor the spine'));
    await waitFor(() => (el.querySelector('.dv-detail')?.textContent ?? '').includes('hello there'));
    click(button(el.querySelector('.dv-detail')!, 'Close session'));
    await waitFor(() => Boolean(document.querySelector('.gv-confirm__confirm')));
    expect(calls.close).toEqual([]);
    click(document.querySelector('.gv-confirm__confirm'));
    await waitFor(() => calls.close.length === 1);
    unmount();
  });

  test('a hosted session attaches when opened and detaches when another is opened', async () => {
    approvals = [];
    const { el, unmount } = render('sessions');
    await waitFor(() => Boolean(rowButton(el, 'Hosted one')));
    click(rowButton(el, 'Hosted one'));
    await waitFor(() => (el.querySelector('.dv-detail')?.textContent ?? '').includes('from history'));
    expect(calls.attach).toEqual(['h-1']);
    click(rowButton(el, 'Hosted two'));
    await waitFor(() => calls.attach.length === 2);
    expect(calls.attach).toEqual(['h-1', 'h-2']);
    expect(calls.detach).toContain('h-1');
    unmount();
  });

  test('a cancellable task can be cancelled from its detail', async () => {
    approvals = [];
    const { el, unmount } = render('processes');
    await waitFor(() => Boolean(rowButton(el, 'Nightly build')));
    click(rowButton(el, 'Nightly build'));
    click(button(el.querySelector('.dv-detail')!, 'Cancel task'));
    await waitFor(() => calls.tasksCancel.length === 1);
    expect(calls.tasksCancel).toEqual(['t-1']);
    unmount();
  });
});


describe('session context usage honesty', () => {
  async function openSession() {
    approvals = [];
    const result = render('sessions');
    await waitFor(() => Boolean(rowButton(result.el, 'Refactor the spine')));
    click(rowButton(result.el, 'Refactor the spine'));
    return result;
  }

  test('renders the known window and estimated percentage', async () => {
    const { el, unmount } = await openSession();
    await waitFor(() => (el.querySelector('.dv-detail')?.textContent ?? '').includes('~10%'));
    expect(el.querySelector('.dv-detail')?.textContent).toContain('1,000 of 10,000 tokens, estimated');
    unmount();
  });

  for (const unknownWindow of [null, undefined, 0]) {
    test(`renders an unknown ${String(unknownWindow)} window without an invented percentage`, async () => {
      contextWindow = unknownWindow;
      contextUsagePct = null;
      const { el, unmount } = await openSession();
      await waitFor(() => (el.querySelector('.dv-detail')?.textContent ?? '').includes('context window unknown'));
      const text = el.querySelector('.dv-detail')?.textContent ?? '';
      expect(text).toContain('1,000 tokens estimated');
      expect(text).not.toContain('~null%');
      expect(text).not.toContain('NaN');
      unmount();
    });
  }

  test('shows unavailable for a session outside the local daemon', async () => {
    contextError = Object.assign(new Error('Session is not local'), { code: 'SESSION_NOT_LOCAL', status: 404 });
    const { el, unmount } = await openSession();
    await waitFor(() => (el.querySelector('.dv-detail')?.textContent ?? '').includes('Unavailable here'));
    expect(el.querySelector('.dv-detail')?.textContent).not.toContain('context window unknown');
    unmount();
  });
});
