/**
 * System notices are toasts plus the notification history, never main
 * transcript rows (ui-live-run-5 item 9), and they keep their full text
 * (ui-live-run-7 item 2: "(setFixWorkstreamRunner w" was a notice cut
 * mid-word). Ported from the TUI; the Agent adds the shell wiring checks at
 * the end (toast layer bounds, /notifications).
 */
import { describe, expect, test } from 'bun:test';
import { ConversationManager } from '../../core/conversation.ts';
import { noticeParts, publishNotice } from '../../core/notices.ts';
import { NotificationFeed, getSharedNotificationFeed } from '../../core/notifications-feed.ts';
import { bridgeNotificationFeedToToasts, getSharedToastCenter, ToastCenter } from '../../renderer/toast-center.ts';
import { renderToasts } from '../../renderer/surface-kit-parts.ts';
import { renderNotificationsModal } from '../../renderer/notifications-modal.ts';
import { appendConversationMessages, type ConversationRenderContext } from '../../core/conversation-rendering.ts';
import { buildConversationLayers } from '../../renderer/conversation-overlays.ts';
import { SurfaceModalHost } from '../../input/surface-modal-host.ts';
import { NotificationsModal } from '../../input/notifications-modal.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerLocalRuntimeCommands } from '../../input/commands/local-runtime.ts';
import { wireNotificationSurfaces } from '../../shell/notification-surfaces.ts';
import type { InputHandler } from '../../input/handler.ts';
import { createEmptyLine, type Line } from '@goodvibes-jev/engine/sdk/platform/types';
import { frameFromLayer } from '../helpers/surface-frame.ts';

const FAILED = '[Agents] ✗ engineer b6834750: "Spawn one reviewer agent to review and verify the backoff…" — failed in 51s: planned-fix execution is not wired in this composition (setFixWorkstreamRunner was never called)';

const text = (lines: readonly Line[]): string => lines.map((line) => line.map((cell) => cell.char).join('').trimEnd()).join('\n');
const flat = (s: string): string => s.replace(/\s+/g, ' ');

function wired() {
  const conversation = new ConversationManager(() => 100);
  const feed = new NotificationFeed();
  const toasts = new ToastCenter(() => 0, () => {});
  bridgeNotificationFeedToToasts(feed, toasts);
  conversation.setNoticeSink((content, { restored }) => publishNotice(feed, content, { restored, now: () => 1_000 }));
  return { conversation, feed, toasts };
}

describe('system notices become toasts and history entries', () => {
  test('a notice added mid-turn is a toast and a history entry with its full text, and no transcript row', () => {
    const { conversation, feed, toasts } = wired();
    conversation.addUserMessage('review the retry logic');
    conversation.addAssistantMessage('Starting a reviewer.');
    conversation.addSystemMessage(FAILED);
    conversation.addSystemMessage('[WRFC] ✗ Chain wrfc-e9823b8 FAILED: planned-fix execution is not wired in this composition (setFixWorkstreamRunner was never called)');

    const entries = feed.list();
    expect(entries).toHaveLength(2);
    // An agent or chain event line is kept under the event's plain title, its full text in the body.
    expect(entries[1]!.title).toBe('Agent failed');
    expect(entries[1]!.body).toBe(FAILED.replace('[Agents] ✗ ', ''));
    expect(entries[1]!.level).toBe('warning');
    expect(entries[1]!.subject).toBe('agents');
    expect(entries[0]!.title).toBe('Review chain failed');
    expect(entries[0]!.body).toContain('(setFixWorkstreamRunner was never called)');
    expect(toasts.visible().map((t) => t.title)).toEqual(['Review chain failed', 'Agent failed']);
    expect(toasts.visible()[1]!.tone).toBe('warning');

    const frame = text(conversation.getDisplayBlocks());
    expect(frame).toContain('Starting a reviewer.');
    expect(frame).not.toContain('[Agents]');
    expect(frame).not.toContain('[WRFC]');
  });

  test('a notice between turns draws no row either', () => {
    const { conversation, feed } = wired();
    conversation.addUserMessage('hello');
    conversation.addAssistantMessage('hi there');
    conversation.addSystemMessage('[Health] providers: 3 reachable');
    conversation.addUserMessage('next');
    const frame = text(conversation.getDisplayBlocks());
    expect(frame).toContain('hi there');
    expect(frame).not.toContain('[Health] providers: 3 reachable');
    expect(feed.list().map((e) => e.title)).toEqual(['[Health] providers: 3 reachable']);
  });

  test('a notice alone does not dismiss the splash; it still reaches the sink in full', () => {
    const { conversation, feed } = wired();
    const receipt = 'Recovery point removed (session sess-abc123); it will not be offered again, even if the file reappears.';
    conversation.addSystemMessage(receipt);
    expect(feed.list().map((e) => e.title)).toEqual([receipt]);
    const frame = text(conversation.getDisplayBlocks());
    expect(frame).not.toContain('Recovery point removed');
  });

  test('a restored session puts its notices back in the history, seen and not toasted', () => {
    const { conversation, feed, toasts } = wired();
    conversation.fromJSON({ messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: '[Compaction] Context compacted: 40 messages summarized' }] });
    expect(feed.list().map((e) => e.title)).toEqual(['[Compaction] Context compacted: 40 messages summarized']);
    expect(feed.unreadCount()).toBe(0);
    expect(toasts.visible()).toEqual([]);
  });

  test('a multi-line notice keeps every line: the first is the title, the rest the body', () => {
    const parts = noticeParts("[Agents] Cohort 'a' complete: 1 completed, 1 failed, 0 cancelled (2 total)\n  ✓ aaaa: completed in 3s (2 tool calls)\n  ✗ bbbb: failed in 5s (1 tool calls) — boom");
    expect(parts.domain).toBe('agents');
    expect(parts.level).toBe('warning');
    expect(parts.title).toBe("[Agents] Cohort 'a' complete: 1 completed, 1 failed, 0 cancelled (2 total)");
    expect(parts.body).toBe('  ✓ aaaa: completed in 3s (2 tool calls)\n  ✗ bbbb: failed in 5s (1 tool calls) — boom');
  });
});

describe('notices show their full text, wrapped', () => {
  test('a toast wraps the whole notice at its text column', () => {
    const layer = renderToasts(120, 40, [{ title: FAILED, tone: 'error' }], { top: 1, bottom: 36 })!;
    const shown = flat(text(layer.lines).replace(/┃/g, ' '));
    expect(shown).toContain('(setFixWorkstreamRunner was never called)');
    // Text never touches the bars: two blank columns inside each ┃.
    for (const line of layer.lines) {
      const row = line.map((cell) => cell.char).join('');
      if (row.trim().length === 0) continue;
      const bar = row.indexOf('┃');
      expect(bar).toBeGreaterThan(0);
      expect(row[bar + 1]).toBe(' ');
      expect(row[bar + 2]).toBe(' ');
      expect(row[row.length - 1]).toBe('┃');
      expect(row[row.length - 2]).toBe(' ');
      expect(row[row.length - 3]).toBe(' ');
    }
  });

  test('the history modal shows the whole notice', () => {
    const feed = new NotificationFeed();
    publishNotice(feed, FAILED, { now: () => Date.now() });
    const layer = renderNotificationsModal({ entries: feed.list(), selectedIndex: 0, unread: 1, isUnread: () => true, status: null, now: Date.now() }, 120, 40);
    expect(flat(text(layer.lines))).toContain('(setFixWorkstreamRunner was never called)');
  });
});

describe('toasts never cover the header, the composer or the status line', () => {
  test('toasts stay above the footer rows', () => {
    const many = Array.from({ length: 3 }, (_, i) => ({ title: `${FAILED} #${i}`, tone: 'info' as const }));
    const layer = renderToasts(100, 20, many, { top: 1, bottom: 20 - 6 })!;
    expect(layer.y).toBe(1);
    expect(layer.y + layer.lines.length).toBeLessThanOrEqual(14);
  });

  test('a toast taller than the room shows what fits and points to the history', () => {
    const tall = { title: FAILED, body: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'), tone: 'warning' as const };
    const layer = renderToasts(100, 20, [tall], { top: 1, bottom: 12 })!;
    expect(layer.lines.length).toBe(11);
    expect(text(layer.lines)).toContain('full text in /notifications');
  });

  test('the screen layers draw the live toasts between the header rows and the footer rows', () => {
    const idle = { active: false };
    const input = {
      agentWorkspace: idle, modelPicker: idle, settingsModal: idle, mcpWorkspace: idle, sessionPickerModal: idle,
      profilePickerModal: idle, bookmarkModal: idle, contextInspectorModal: idle, processModal: idle, liveTailModal: idle,
      blockActionsMenu: idle, selectionModal: idle, helpOverlayActive: false, shortcutsOverlayActive: false,
      modalStack: [], surfaceModals: new SurfaceModalHost(),
    } as unknown as InputHandler;
    const center = getSharedToastCenter();
    center.clear();
    center.show({ title: FAILED, body: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'), tone: 'error' });
    try {
      const layers = buildConversationLayers({
        input, conversation: new ConversationManager(() => 100), commandRegistry: new CommandRegistry(),
        keybindingsManager: {} as never, screenWidth: 100, screenHeight: 30, headerRows: 2, footerRows: 5,
      });
      const toast = layers[layers.length - 1]!;
      expect(toast.dim).toBe(false);
      expect(toast.y).toBe(2);
      expect(toast.y + toast.lines.length).toBeLessThanOrEqual(30 - 5);
      expect(text(toast.lines)).toContain('full text in /notifications');
    } finally {
      center.clear();
    }
  });
});

describe('the notification history is reachable', () => {
  test('/notifications opens the history modal with every notice, and opening it marks them seen', async () => {
    const host = new SurfaceModalHost();
    const input = { surfaceModals: host } as unknown as InputHandler;
    const ctx = { print: () => {} } as unknown as CommandContext;
    wireNotificationSurfaces({ commandContext: ctx, input, render: () => {} });
    const feed = getSharedNotificationFeed();
    feed.clear();
    publishNotice(feed, FAILED);

    const registry = new CommandRegistry();
    registerLocalRuntimeCommands(registry);
    expect(registry.list().some((command) => command.name === 'notifications')).toBe(true);
    expect(await registry.execute('notifications', [], ctx)).toBe(true);

    const modal = host.top();
    expect(modal).toBeInstanceOf(NotificationsModal);
    expect((modal as NotificationsModal).entries.map((e) => e.title)).toEqual(['Agent failed']);
    expect((modal as NotificationsModal).entries[0]!.body).toContain('(setFixWorkstreamRunner was never called)');
    expect(feed.unreadCount()).toBe(0);
    host.close(modal!, 'done');
    feed.clear();
  });
});

describe('a multi-line body in the history', () => {
  test('its lines stay apart in the row, never run together', () => {
    const feed = new NotificationFeed();
    publishNotice(feed, "[Delegated task] 2 running\n  aaaa1111 reading src/retry.ts\n  bbbb2222 running tests", { now: () => Date.now() });
    const layer = renderNotificationsModal({ entries: feed.list(), selectedIndex: 0, unread: 1, isUnread: () => true, status: null, now: Date.now() }, 160, 40);
    const shown = flat(text(layer.lines));
    expect(shown).toContain('aaaa1111 reading src/retry.ts \u00b7 bbbb2222 running tests');
  });
});

describe('toasts keep a gap from the transcript under them', () => {
  // A transcript whose every row is a filled block with text across the full
  // fill (columns 3 to width-3), the worst case for a floating toast.
  const W = 100;
  const H = 30;
  const BLOCK_BG = '#223344';
  function transcript(): Line[] {
    return Array.from({ length: H }, () => {
      const line = createEmptyLine(W);
      for (let x = 3; x <= W - 3; x++) line[x] = { ...line[x]!, char: 'x', bg: BLOCK_BG };
      return line;
    });
  }
  const plain = (line: Line, x: number): boolean => line[x]!.char === ' ' && line[x]!.bg === '';

  test('the lowest toast has a cleared row under it and cleared columns on its left; stacked toasts a cleared row between', () => {
    const toasts = [{ title: 'First notice', tone: 'info' as const }, { title: 'Second notice', body: 'with a body', tone: 'warning' as const }];
    const layer = renderToasts(W, H, toasts, { top: 1, bottom: H - 6 })!;
    const frame = frameFromLayer(layer, W, H, transcript());
    const toastRows = frame.map((line, y) => ({ y, bars: line.map((c) => c.char).join('').split('┃').length - 1 })).filter((r) => r.bars === 2).map((r) => r.y);
    expect(toastRows.length).toBeGreaterThan(0);
    const lowest = Math.max(...toastRows);
    const left = frame[toastRows[0]!]!.findIndex((c) => c.char === '┃');
    const right = frame[toastRows[0]!]!.map((c) => c.char).lastIndexOf('┃');
    // Under the lowest toast: one full row of plain screen across its width and its left gap.
    for (let x = left - 2; x <= right; x++) expect(plain(frame[lowest + 1]!, x)).toBe(true);
    // Beside every toast row: two plain columns before the bar.
    for (const y of toastRows) {
      expect(plain(frame[y]!, left - 1)).toBe(true);
      expect(plain(frame[y]!, left - 2)).toBe(true);
    }
    // Between the two toasts: a plain row, never the block showing through.
    const gaps = [];
    for (let y = toastRows[0]!; y < lowest; y++) if (!toastRows.includes(y)) gaps.push(y);
    expect(gaps.length).toBe(1);
    for (let x = left; x <= right; x++) expect(plain(frame[gaps[0]!]!, x)).toBe(true);
    // And the gap stays inside the area, above the footer.
    expect(layer.y + layer.lines.length).toBeLessThanOrEqual(H - 6);
  });
});

describe('an agent view still draws its own agent\'s system messages', () => {
  test('without systemNotices the notice is a row', () => {
    const lines: Line[] = [];
    const context: ConversationRenderContext = {
      history: { addLine: (l) => { lines.push(l); }, addLines: (ls) => { lines.push(...ls); }, getLineCount: () => lines.length },
      blockRegistry: [],
      collapseState: new Map(),
      errorLineRegistry: [],
      configManager: null,
      splashOptions: {},
    };
    appendConversationMessages(context, [{ role: 'system', content: '[Resume] prior summary' }], 80, []);
    expect(text(lines)).toContain('[Resume] prior summary');
  });
});
