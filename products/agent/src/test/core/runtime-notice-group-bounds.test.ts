import { expect, test } from 'bun:test';
import { bridgeNotificationFeedToToasts, ToastCenter } from '../../renderer/toast-center.ts';
import { NotificationFeed } from '../../core/notifications-feed.ts';

const grouped = { target: 'panel_only', reasonCode: 'burst_collapsed', batchKey: 'agents:info' } as const;
function append(feed: NotificationFeed, occurrence: number, batchKey: string = grouped.batchKey): void {
  feed.record({ id: `delivery-${occurrence}`, domain: 'agents', level: 'info', title: 'Agent finished', timestamp: 1000 },
    { ...grouped, batchKey }, `occurrence-${occurrence}`);
}
const total = (feed: NotificationFeed) => feed.list().reduce((sum, entry) => sum + entry.collapsedCount, 0);

test('collapsed groups rotate without losing duplicate identity for either retained group', () => {
  const feed = new NotificationFeed();
  for (let i = 0; i < 250; i++) append(feed, i);
  expect(feed.list().map((entry) => entry.collapsedCount)).toEqual([50, 100, 100]);
  for (const i of [0, 99, 100, 199, 200, 249]) {
    append(feed, i);
    feed.recordNotice({ domain: 'agents', level: 'info', title: 'Agent finished', timestamp: 1000, restored: true, eventKey: `occurrence-${i}` });
  }
  expect(total(feed)).toBe(250);
  expect(feed.list()).toHaveLength(3);
  expect(feed.unreadCount()).toBe(3); // Restoring six occurrences does not mark the other 244 seen.
});

test('fixed burst keys have bounded identity retention and only evicted groups lose replay identity', () => {
  const feed = new NotificationFeed();
  for (let i = 0; i < 200100; i++) append(feed, i);
  expect(feed.list()).toHaveLength(2000);
  expect(total(feed)).toBe(200000);
  // Inspect the storage bound as well as visible rows: a row cap alone did not bound identity memory.
  const index = (feed as unknown as { eventEntries: ReadonlyMap<string, string> }).eventEntries;
  expect(index.size).toBe(200000);
  append(feed, 100);
  append(feed, 200099);
  expect(total(feed)).toBe(200000);
  append(feed, 0); // The first group left the retained history; this is outside its replay horizon.
  expect(total(feed)).toBe(199901);
  expect(index.size).toBe(199901);
  expect(feed.list()).toHaveLength(2000);
});

test('active group index is cleaned on eviction, dismissal and clear', () => {
  const feed = new NotificationFeed();
  for (let i = 0; i < 2100; i++) append(feed, i, `batch-${i}`);
  const active = (feed as unknown as { activeGroups: ReadonlyMap<string, string> }).activeGroups;
  expect(active.size).toBe(2000);
  expect(feed.dismiss(feed.list()[0]!.key)).toBe(true);
  expect(active.size).toBe(1999);
  feed.clear();
  expect(active.size).toBe(0);
  append(feed, 2100);
  expect(feed.list()).toHaveLength(1);
});

test('distinct occurrence identities cannot overwrite each other through a reused delivery id', () => {
  const feed = new NotificationFeed();
  const notification = { id: 'reused-delivery', domain: 'agents', level: 'info', title: 'Agent finished', timestamp: 1000 } as const;
  for (const key of ['first', 'second', 'first']) feed.record(notification, { target: 'panel_only', reasonCode: 'allowed' }, key);
  expect(feed.list()).toHaveLength(2);
  expect(total(feed)).toBe(2);
});

for (const noticeFirst of [true, false]) {
  test(`restored occurrence stays silent after ${noticeFirst ? 'notice' : 'bus'} first delivery`, () => {
    const feed = new NotificationFeed();
    const toasts = new ToastCenter(() => 0, () => {});
    const stopToasts = bridgeNotificationFeedToToasts(feed, toasts);
    const notice = (restored: boolean) => feed.recordNotice({ domain: 'agents', level: 'info', title: 'Agent finished', body: 'Full detail', timestamp: 1000, eventKey: 'restored', restored });
    const bus = () => feed.record({ id: 'delivery', domain: 'agents', level: 'info', title: 'Agent finished', timestamp: 1000 }, { target: 'panel_only', reasonCode: 'allowed' }, 'restored');
    if (noticeFirst) { notice(true); bus(); } else { bus(); notice(true); }
    notice(false);
    bus();
    expect(feed.list()).toHaveLength(1);
    expect(feed.list()[0]?.toast).toBe('never');
    expect(toasts.visible()).toHaveLength(0);
    stopToasts();
    expect(feed.unreadCount()).toBe(0);
  });
}

test('grouped replay enriches every occurrence without changing the count or losing severity', () => {
  const feed = new NotificationFeed();
  const record = (id: string, level: 'info' | 'critical', body: string) => feed.record({ id, domain: 'agents', level, title: 'Agent update', body, timestamp: 1000 }, grouped, id);
  record('first', 'critical', 'First bus diagnostic');
  record('second', 'info', 'Second bus diagnostic');
  feed.recordNotice({ domain: 'agents', level: 'info', title: 'Agent update', body: 'First complete diagnostic tail', timestamp: 1000, eventKey: 'first' });
  feed.recordNotice({ domain: 'agents', level: 'critical', title: 'Agent update', body: 'Second complete diagnostic tail', timestamp: 1000, eventKey: 'second' });
  record('third', 'info', 'Third bus diagnostic');
  record('first', 'info', 'First bus diagnostic');
  const [entry] = feed.list();
  expect(entry?.collapsedCount).toBe(3);
  expect(entry?.level).toBe('critical');
  for (const detail of ['First complete diagnostic tail', 'Second complete diagnostic tail', 'Third bus diagnostic']) expect(entry?.body).toContain(detail);
  expect((entry?.body?.match(/First complete diagnostic tail/g) ?? [])).toHaveLength(1);
});

test('a shorter notice replay cannot erase previously enriched diagnostic text', () => {
  const feed = new NotificationFeed();
  for (const body of ['Agent failed: test', 'Agent failed: test\nReason: exact diagnostic', 'Agent failed: test']) {
    feed.recordNotice({ domain: 'agents', level: 'warning', title: 'Agent failed', body, timestamp: 1000, eventKey: 'failure' });
  }
  expect(feed.list()[0]?.body).toBe('Agent failed: test\nReason: exact diagnostic');
  expect(feed.list()[0]?.collapsedCount).toBe(1);
});


test('dismissal and clear retire occurrence diagnostics with their history row', () => {
  const feed = new NotificationFeed();
  append(feed, 1);
  feed.recordNotice({ domain: 'agents', level: 'warning', title: 'Agent failed', body: 'Private local diagnostic', timestamp: 1000, eventKey: 'occurrence-1' });
  const details = feed as unknown as { noticeDetails: ReadonlyMap<string, string>; groupDetails: ReadonlyMap<string, ReadonlyMap<string, string>> };
  expect(details.noticeDetails.size).toBe(1);
  expect(details.groupDetails.size).toBe(1);
  feed.dismiss(feed.list()[0]!.key);
  expect(details.noticeDetails.size).toBe(0);
  expect(details.groupDetails.size).toBe(0);
  append(feed, 2);
  feed.recordNotice({ domain: 'agents', level: 'warning', title: 'Agent failed', body: 'Other local diagnostic', timestamp: 1000, eventKey: 'occurrence-2' });
  feed.clear();
  expect(details.noticeDetails.size).toBe(0);
  expect(details.groupDetails.size).toBe(0);
});


test('a quiet bus arrival promoted by a live notice toasts once without changing its count', () => {
  const feed = new NotificationFeed();
  const toasts = new ToastCenter(() => 0, () => {});
  const stop = bridgeNotificationFeedToToasts(feed, toasts);
  try {
    feed.record({ id: 'delivery', domain: 'agents', level: 'info', title: 'Agent finished', timestamp: 1000 }, { target: 'panel_only', reasonCode: 'allowed' }, 'live');
    expect(toasts.visible()).toHaveLength(0);
    for (let i = 0; i < 2; i++) feed.recordNotice({ domain: 'agents', level: 'info', title: 'Agent finished', body: 'Completed live', timestamp: 1000, eventKey: 'live' });
    expect(toasts.visible()).toHaveLength(1);
    expect(feed.list()[0]?.collapsedCount).toBe(1);
  } finally { stop(); }
});


for (const restoreBeforeNewMember of [true, false]) {
  test(`restoring one grouped occurrence preserves another live member (${restoreBeforeNewMember ? 'before' : 'after'} new member)`, () => {
    const feed = new NotificationFeed();
    const toasts = new ToastCenter(() => 0, () => {});
    const stop = bridgeNotificationFeedToToasts(feed, toasts);
    const record = (id: string, timestamp: number) => feed.record({ id, domain: 'agents', level: 'info', title: 'Agent finished', timestamp }, grouped, id);
    const notice = (id: string, restored: boolean) => feed.recordNotice({ domain: 'agents', level: 'info', title: 'Agent finished', body: id, timestamp: id === 'old' ? 1000 : 2000, eventKey: id, restored });
    try {
      record('old', 1000);
      if (restoreBeforeNewMember) notice('old', true);
      record('new', 2000);
      if (!restoreBeforeNewMember) notice('old', true);
      notice('old', false); // A live catch-up of restored A may not promote B's row.
      expect(toasts.visible()).toHaveLength(0);
      expect(feed.unreadCount()).toBe(1);
      notice('new', false);
      expect(toasts.visible()).toHaveLength(1);
      expect(feed.list()[0]?.collapsedCount).toBe(2);
      notice('old', true);
      expect(feed.unreadCount()).toBe(1);
      expect(toasts.visible()).toHaveLength(1);
      notice('new', true);
      expect(feed.unreadCount()).toBe(0);
      expect(feed.list()[0]?.toast).toBe('never');
    } finally { stop(); }
  });
}

test('restoring an unrelated newer row does not mark a live row seen', () => {
  const feed = new NotificationFeed();
  feed.recordNotice({ domain: 'agents', level: 'info', title: 'Live', timestamp: 1000, eventKey: 'live' });
  feed.recordNotice({ domain: 'agents', level: 'info', title: 'Restored', timestamp: 2000, eventKey: 'restored', restored: true });
  expect(feed.unreadCount()).toBe(1);
  expect(feed.isUnread(feed.list()[0]!)).toBe(false);
  expect(feed.isUnread(feed.list()[1]!)).toBe(true);
});


test('restored severity enrichment stays silent without hiding an unrelated live occurrence', () => {
  const feed = new NotificationFeed();
  const toasts = new ToastCenter(() => 0, () => {});
  const stop = bridgeNotificationFeedToToasts(feed, toasts);
  try {
    for (const [id, title, timestamp] of [['old', 'Workstream cancelled', 1000], ['new', 'Workstream passed', 2000]] as const) {
      feed.record({ id, domain: 'contracts', level: 'info', title, timestamp }, { ...grouped, batchKey: 'contracts:info' }, id);
    }
    feed.recordNotice({ domain: 'contracts', level: 'warning', title: 'Workstream cancelled', body: 'Old cancellation', timestamp: 1000, eventKey: 'old', restored: true });
    expect(feed.list()[0]?.level).toBe('warning');
    expect(feed.unreadCount()).toBe(1);
    expect(toasts.visible()).toHaveLength(0);
    feed.recordNotice({ domain: 'contracts', level: 'info', title: 'Workstream passed', body: 'Live pass', timestamp: 2000, eventKey: 'new' });
    expect(toasts.visible()).toHaveLength(1);
    expect(feed.unreadCount()).toBe(1);
  } finally { stop(); }
});
