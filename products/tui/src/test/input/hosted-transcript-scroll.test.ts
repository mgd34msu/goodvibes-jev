import { afterEach, expect, test } from 'bun:test';
import type { HostedSessionRecord } from '@goodvibes-jev/engine/sdk/platform/hosted-sessions';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import { AgentsModal } from '../../input/agents-modal.ts';
import { SurfaceModalHost } from '../../input/surface-modal-host.ts';
import { HostedSessionFeed, MAX_HOSTED_ROWS } from '../../views/hosted-session-feed.ts';
import { buildFleetSnapshot, createStaticFleetReadModel } from '../../views/fleet-read-model.ts';
import { frameFromLayer } from '../helpers/surface-frame.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const record = (id = 'hosted-a'): HostedSessionRecord => ({
  id, workspaceRoot: '/owned/project', title: `Session ${id}`, status: 'running', detachPolicy: 'survive', effectiveDetachPolicy: 'survive',
  attachedClients: ['owned-tui'], createdAt: 1, updatedAt: 2, turnCount: 1, messageCount: 2, restoredFromDisk: false, contractIds: [],
});
const history = (count: number, prefix = 'entry') => Array.from({ length: count }, (_, index) => ({ role: 'assistant' as const, content: `${prefix}-${String(index).padStart(3, '0')}` }));
const entries = (text: string) => text.match(/entry-\d{3}/g) ?? [];
function fixture(count = 80) {
  const feed = new HostedSessionFeed(); feed.attach(record(), history(count));
  const host = new SurfaceModalHost();
  let renders = 0; let closes = 0; const stops: string[] = []; const sent: string[] = [];
  feed.bindStream(() => { closes++; });
  const modal = new AgentsModal({
    readModel: createStaticFleetReadModel(buildFleetSnapshot([])), hosted: feed, tickMs: 0,
    actions: { interrupt: () => false, resume: () => false, kill: id => { stops.push(id); return []; },
      getConversationSnapshot: () => [], resolveSessionLogPath: () => '', steer: () => ({ queued: false, reason: 'not used' }) },
    steerHosted: text => sent.push(text), requestRender: () => { renders++; },
  });
  host.push(modal); modal.showHosted(); cleanup.push(() => host.clear());
  const key = (logicalName: string, ctrl = false) => {
    if (logicalName === 'escape') host.escape();
    else host.handleToken({ type: 'key', name: logicalName, logicalName, ctrl, shift: false, meta: false } as InputToken);
  };
  const type = (value: string) => host.handleToken({ type: 'text', value });
  const frame = (width = 100, height = 36) => frameFromLayer(modal.render(width, height), width, height);
  const text = (width = 100, height = 36) => frame(width, height).map(row => row.map(cell => cell.char).join('')).join('\n');
  return { feed, host, modal, key, type, frame, text, stops, sent, renders: () => renders, closes: () => closes };
}

test('actual hosted modal scrolls to retained history and explicitly resumes tail-follow', () => {
  const f = fixture();
  expect(f.text()).toContain('entry-079');
  f.key('home');
  expect(f.text()).toContain('entry-000');
  expect(f.text()).not.toContain('entry-079');
  f.key('pagedown');
  const reading = entries(f.text());
  expect(reading[0]).not.toBe('entry-000');
  f.feed.note('newest-after-scroll');
  expect(entries(f.text())).toEqual(reading);
  expect(f.text()).not.toContain('newest-after-scroll');
  f.feed.setRecord({ ...record(), messageCount: 99 });
  expect(entries(f.text())).toEqual(reading);
  expect(f.text()).toContain('99 messages');
  f.type('f');
  expect(f.text()).toContain('newest-after-scroll');
  f.feed.note('following-next-append');
  expect(f.text()).toContain('following-next-append');
  f.key('up');
  f.feed.note('manual-down-still-paused');
  expect(f.text()).not.toContain('manual-down-still-paused');
  f.key('end');
  expect(f.text()).toContain('manual-down-still-paused');
  expect(f.stops).toEqual([]); expect(f.closes()).toBe(0);
});

test('narrow hosted scrolling reaches every retained row and reports unread lines without changing ownership', () => {
  const f = fixture();
  f.text(48, 24); f.key('home');
  const seen = new Set<string>();
  for (let page = 0; page < 80; page++) {
    const text = f.text(48, 24);
    for (const entry of entries(text)) seen.add(entry);
    if (text.includes('entry-079')) break;
    expect(text).toContain('more ↓');
    f.key('pagedown');
  }
  expect([...seen]).toEqual(history(80).map(row => row.content));
  const reading = entries(f.text(48, 24));
  f.feed.note('not-following-even-at-bottom');
  expect(entries(f.text(48, 24))).toEqual(reading);
  expect(f.text(48, 24)).not.toContain('not-following-even-at-bottom');
  f.key('end'); expect(f.text(48, 24)).toContain('not-following-even-at-bottom');
  expect(f.stops).toEqual([]); expect(f.closes()).toBe(0);
});

test('actual hosted viewport preserves a text anchor across streaming growth and resize', () => {
  const f = fixture(0);
  const words = (count: number) => Array.from({ length: count }, (_, i) => `word_${String(i).padStart(3, '0')}`).join(' ');
  const stream = (count: number) => f.feed.apply({ domain: 'turn', type: 'STREAM_DELTA', sessionId: 'hosted-a', at: 100, payload: { accumulated: words(count) } });
  stream(240); f.text(120, 40); f.key('pageup');
  const anchor = f.text(120, 40).match(/word_\d{3}/)?.[0];
  expect(anchor).toBeDefined();
  stream(320);
  expect(f.text(120, 40)).toContain(anchor!);
  expect(f.text(120, 40)).not.toContain('word_319');
  for (const [width, height] of [[60, 32], [100, 36], [48, 24], [120, 40]] as const) {
    const frame = f.frame(width, height);
    expect(frame).toHaveLength(height); expect(frame.every(row => row.length === width)).toBe(true);
    expect(f.text(width, height)).toContain(anchor!);
  }
  f.key('end'); expect(f.text(120, 40)).toContain('word_319');
});

test('manual hosted cursor clamps to retained rows after bounded-history eviction without following new rows', () => {
  const f = fixture(MAX_HOSTED_ROWS);
  f.text(); f.key('home'); expect(f.text()).toContain('entry-000');
  for (let i = 0; i < 5; i++) f.feed.note(`new-${i}`);
  expect(f.feed.getState().droppedRows).toBe(5);
  expect(f.text()).toContain('entry-005'); expect(f.text()).not.toContain('entry-000');
  expect(f.text()).not.toContain('new-4');
  f.key('end'); expect(f.text()).toContain('new-4');
});

test('an evicted multiline anchor clamps to the beginning of the first retained row', () => {
  const f = fixture(0);
  const long = (prefix: string) => Array.from({ length: 180 }, (_, i) => `${prefix}_${String(i).padStart(3, '0')}`).join(' ');
  f.feed.attach(record(), [{ role: 'assistant', content: long('evicted') }, { role: 'assistant', content: long('retained') }, ...history(MAX_HOSTED_ROWS - 2)]);
  f.text(); f.key('home'); f.text(); f.key('pagedown');
  expect(f.text()).not.toContain('evicted_000');
  expect(f.text()).toContain('evicted_');
  f.feed.note('newest eviction trigger');
  expect(f.feed.getState().droppedRows).toBe(1);
  expect(f.text()).toContain('retained_000');
  expect(f.text()).not.toContain('newest eviction trigger');
});

test('same-ID reattach, changed session and view reopen reset hosted cursor ownership', () => {
  const f = fixture();
  f.text(); f.key('home'); expect(f.text()).toContain('entry-000');
  f.feed.attach(record(), history(70, 'reattached'));
  expect(f.text()).toContain('reattached-069');
  f.key('home'); expect(f.text()).toContain('reattached-000');
  f.key('escape'); f.modal.showHosted();
  expect(f.text()).toContain('reattached-069');
  f.key('home'); f.feed.clear();
  expect(f.text()).not.toContain('reattached-000'); expect(f.text()).not.toContain('reattached-069');
  f.feed.attach(record('hosted-b'), history(70, 'replacement')); f.modal.showHosted();
  expect(f.text()).toContain('replacement-069'); expect(f.text()).not.toContain('reattached');
});

test('hosted transcript navigation preserves say, stop explanation and one-level Escape without detaching', () => {
  const f = fixture();
  f.text(); f.key('home'); const reading = entries(f.text());
  f.type('s'); f.type('hello hosted');
  const composing = entries(f.text());
  expect(composing[0]).toBe(reading[0]);
  f.key('up'); expect(entries(f.text())).toEqual(composing);
  f.key('enter'); expect(f.sent).toEqual(['hello hosted']);
  f.key('x', true);
  expect(f.text()).toContain('/hosted kill'); expect(f.stops).toEqual([]);
  f.key('escape'); expect(f.host.active).toBe(true);
  f.key('escape'); expect(f.host.active).toBe(false);
  expect(f.feed.getState().record?.id).toBe('hosted-a'); expect(f.closes()).toBe(0);
});

test('closing before a queued hosted-feed callback cannot repaint the disposed modal', () => {
  const feed = new HostedSessionFeed(); feed.attach(record(), history(20));
  const host = new SurfaceModalHost(); let modal: AgentsModal; let closeFirst = false; let renders = 0;
  const unsubscribe = feed.subscribe(() => { if (closeFirst) host.close(modal); });
  modal = new AgentsModal({ readModel: createStaticFleetReadModel(buildFleetSnapshot([])), hosted: feed, tickMs: 0,
    actions: { interrupt: () => false, resume: () => false, kill: () => [], getConversationSnapshot: () => [], resolveSessionLogPath: () => '', steer: () => ({ queued: false, reason: 'not used' }) },
    requestRender: () => { renders++; },
  });
  host.push(modal); modal.showHosted(); modal.render(100, 36);
  cleanup.push(() => { unsubscribe(); host.clear(); });
  closeFirst = true; const before = renders;
  feed.note('queued after view closure');
  expect(host.active).toBe(false); expect(renders).toBe(before);
  expect(feed.getState().record?.id).toBe('hosted-a');
});
