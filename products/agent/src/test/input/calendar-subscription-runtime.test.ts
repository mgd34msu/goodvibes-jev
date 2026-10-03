/**
 * /calendar subscription verb + merged-view tests.
 *
 * Drives the real command surface with a fake CommandContext (tmp shellPaths +
 * in-memory secrets) and an injected FAKE fetcher, no real network. Covers the
 * subscribe preview/save consent flow, subscriptions listing (masked URL),
 * refresh, unsubscribe, the merged read-only source-labeled list view, the
 * delete guard on subscribed ids, and the honest import report.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeedFetcher, FeedFetchResult } from '@goodvibes-jev/engine/sdk/platform/calendar';
import type { CommandContext } from '../../input/command-registry.ts';
import { runCalendarSubscriptionCommand } from '../../input/commands/calendar-subscription-runtime.ts';
import { runCalendarRuntimeCommand } from '../../input/commands/calendar-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const ICS = 'BEGIN:VCALENDAR\r\nX-WR-CALNAME:Feed A\r\nBEGIN:VEVENT\r\nUID:e1\r\nSUMMARY:Standup\r\nDTSTART:20260706T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
const SECRET_URL = 'https://cal.example/ical/supersecrettoken/basic.ics';

const dirs: string[] = [];
function tmpRoot(): string {
  const dir = makeProjectTempDir(`gv-cal-verb-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

function makeContext(root: string): { ctx: CommandContext; output: () => string; secretStore: Map<string, string> } {
  const lines: string[] = [];
  const secretStore = new Map<string, string>();
  const secretsManager = {
    get: async (k: string) => secretStore.get(k) ?? null,
    set: async (k: string, v: string) => { secretStore.set(k, v); },
    delete: async (k: string) => { secretStore.delete(k); },
  };
  const shellPaths = { resolveUserPath: (_root: string, ...parts: string[]) => join(root, ...parts) };
  const ctx = {
    session: {}, provider: {}, ops: {}, extensions: {}, clients: {},
    workspace: { shellPaths },
    platform: { secretsManager },
    print: (t: string) => { lines.push(t); },
    renderRequest: () => {}, exit: () => {},
  } as unknown as CommandContext;
  return { ctx, output: () => lines.join('\n'), secretStore };
}

function fetcherOf(...responses: FeedFetchResult[]): FeedFetcher {
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)]!;
}

describe('/calendar subscribe', () => {
  test('preview (no --yes) validates by fetching and states what will be fetched, saving nothing', async () => {
    const { ctx, output, secretStore } = makeContext(tmpRoot());
    await runCalendarSubscriptionCommand('subscribe', [SECRET_URL], ctx, fetcherOf({ kind: 'ok', body: ICS }));
    const out = output();
    expect(out).toContain('preview');
    expect(out).toContain('Feed A');
    expect(out).toContain('rerun with --yes');
    expect(secretStore.size).toBe(0); // nothing saved on preview
  });

  test('subscribe --yes stores the URL as a secret and confirms read-only', async () => {
    const { ctx, output, secretStore } = makeContext(tmpRoot());
    await runCalendarSubscriptionCommand('subscribe', [SECRET_URL, '--yes'], ctx, fetcherOf({ kind: 'ok', body: ICS }));
    const out = output();
    expect(out).toContain("Subscribed to 'Feed A'");
    expect(out).toContain('read-only');
    expect([...secretStore.values()]).toContain(SECRET_URL);
    expect(out).not.toContain('supersecrettoken'); // URL never echoed
  });
});

describe('/calendar subscriptions + refresh + unsubscribe', () => {
  test('subscriptions lists status with a masked URL', async () => {
    const { ctx, output } = makeContext(tmpRoot());
    await runCalendarSubscriptionCommand('subscribe', [SECRET_URL, '--yes'], ctx, fetcherOf({ kind: 'ok', body: ICS }));
    await runCalendarSubscriptionCommand('subscriptions', [], ctx, fetcherOf({ kind: 'ok', body: ICS }));
    const out = output();
    expect(out).toContain('Feed A');
    expect(out).toContain('status  ok');
    expect(out).not.toContain('supersecrettoken');
  });

  test('refresh reports an honest outcome', async () => {
    const { ctx, output } = makeContext(tmpRoot());
    await runCalendarSubscriptionCommand('subscribe', [SECRET_URL, '--yes'], ctx, fetcherOf({ kind: 'ok', body: ICS, etag: 'W/"1"' }));
    await runCalendarSubscriptionCommand('refresh', [], ctx, fetcherOf({ kind: 'not-modified', etag: 'W/"1"' }));
    expect(output()).toContain('not-modified');
  });

  test('unsubscribe --yes removes it', async () => {
    const { ctx, output } = makeContext(tmpRoot());
    await runCalendarSubscriptionCommand('subscribe', [SECRET_URL, '--yes'], ctx, fetcherOf({ kind: 'ok', body: ICS }));
    await runCalendarSubscriptionCommand('unsubscribe', ['Feed A', '--yes'], ctx, fetcherOf({ kind: 'ok', body: ICS }));
    expect(output()).toContain("Unsubscribed from 'Feed A'");
  });
});

describe('merged /calendar list', () => {
  test('shows subscribed events source-labeled and read-only alongside local', async () => {
    const { ctx, output } = makeContext(tmpRoot());
    await runCalendarSubscriptionCommand('subscribe', [SECRET_URL, '--yes'], ctx, fetcherOf({ kind: 'ok', body: ICS }));
    runCalendarRuntimeCommand(['list'], ctx);
    const out = output();
    expect(out).toContain('Subscribed calendar events');
    expect(out).toContain('[Feed A]');
    expect(out).toContain('read-only');
  });

  test('delete refuses a subscribed id with a plain reason', () => {
    const { ctx, output } = makeContext(tmpRoot());
    runCalendarRuntimeCommand(['delete', 'sub:Feed A:e1', '--yes'], ctx);
    const out = output();
    expect(out).toContain('read-only');
    expect(out).toContain('unsubscribe');
  });
});

describe('/calendar import honest report', () => {
  test('reports unsupported recurrence and unparseable entries', () => {
    const root = tmpRoot();
    const { ctx, output } = makeContext(root);
    const icsPath = join(root, 'in.ics');
    writeFileSync(icsPath, [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:r1',
      'SUMMARY:Monthly bill',
      'DTSTART;VALUE=DATE:20260701',
      'RRULE:FREQ=MONTHLY;BYMONTHDAY=1',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n'), 'utf-8');
    runCalendarRuntimeCommand(['import', icsPath, '--yes'], ctx);
    const out = output();
    expect(out).toContain('recurrence not fully expanded');
    expect(out).toContain('Monthly bill');
  });
});
