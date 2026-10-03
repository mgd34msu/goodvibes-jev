/**
 * Calendar subscribe wizard editor tests.
 *
 * The wizard is a DIRECT host action (like the email connect wizard) because the
 * feed URL is secrets-adjacent. These tests inject a registry built over a FAKE
 * fetcher + in-memory secrets (no real network), and assert: the URL is stored as
 * a secret and never appears in the action-result surface, honest staged failure
 * keeps the fields, and success closes the editor with a read-only note.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { AgentWorkspace } from '../../input/agent-workspace.ts';
import type { FeedFetcher, FeedFetchResult } from '@goodvibes-jev/engine/sdk/platform/calendar';
import { CalendarSubscriptionRegistry, type SubscriptionSecretStore } from '../../agent/calendar-subscription-registry.ts';
import {
  createCalendarSubscribeWizardEditor,
  submitAgentWorkspaceCalendarSubscribeWizardEditor,
  type AgentWorkspaceCalendarSubscribeEditorHost,
} from '../../input/agent-workspace-calendar-subscribe-editor.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const ICS = 'BEGIN:VCALENDAR\r\nX-WR-CALNAME:My Feed\r\nBEGIN:VEVENT\r\nUID:e1\r\nSUMMARY:Ev\r\nDTSTART:20260706T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
const SECRET_URL = 'https://calendar.google.com/calendar/ical/topsecret123/basic.ics';

const dirs: string[] = [];
function tmpStore(): string {
  const dir = makeProjectTempDir(`gv-cal-wiz-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dirs.push(dir);
  return join(dir, 'subscriptions.json');
}
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

function memorySecrets(): { store: Map<string, string>; secrets: SubscriptionSecretStore } {
  const store = new Map<string, string>();
  return { store, secrets: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } } };
}

function makeHost(): AgentWorkspaceCalendarSubscribeEditorHost {
  return { localEditor: null, runtimeSnapshot: null, status: '', lastActionResult: null };
}

function fieldReaderFrom(fields: Record<string, string>): (id: string) => string {
  return (id) => fields[id] ?? '';
}

const CONTEXT = { platform: {}, workspace: {} } as unknown as CommandContext;

function builderWith(store: Map<string, string>, secrets: SubscriptionSecretStore, fetcher: FeedFetcher) {
  const reg = new CalendarSubscriptionRegistry({ storePath: tmpStore(), secrets, fetcher, clock: () => 1000 });
  return { reg, build: () => reg };
}

function fetcherOf(...responses: FeedFetchResult[]): FeedFetcher {
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)]!;
}

describe('createCalendarSubscribeWizardEditor', () => {
  test('is a secrets-aware wizard with a masked URL field and Google/Outlook guidance', () => {
    const editor = createCalendarSubscribeWizardEditor();
    expect(editor.kind).toBe('calendar-subscribe-wizard');
    expect(editor.fields.map((f) => f.id)).toEqual(['url', 'name', 'confirm']);
    expect(editor.fields.find((f) => f.id === 'url')?.redact).toBe(true);
    expect(editor.message).toContain('Secret address in iCal format');
    expect(editor.message).toContain('Outlook');
  });
});

describe('submitAgentWorkspaceCalendarSubscribeWizardEditor', () => {
  test.each(['', '  ', '\t\n'])('trimmed private feed echoes stay outside judgment with padding %j', async (padding) => {
    const fake = fakePort(() => noulAnswer(0.01));
    const previous = installJudgmentPort(fake.port);
    const ws = new AgentWorkspace();
    const url = 'https://calendar.example.test/private/synthetic-feed-93a/basic.ics';
    const entered = `${padding}${url}${padding}`;
    const template = createCalendarSubscribeWizardEditor();
    const editor = { ...template, fields: template.fields.map((field) => ({ ...field, value: field.id === 'url' ? entered : field.id === 'confirm' ? 'yes' : field.value })) };
    const { store, secrets } = memorySecrets();
    let fetched: string | undefined;
    const { build } = builderWith(store, secrets, async (request) => {
      fetched = request.url;
      return { kind: 'error', status: 400, message: `Unable to fetch ${request.url}` };
    });
    try {
      ws.open({ ...CONTEXT, executeCommand: async () => true, print() {}, renderRequest() {} } as unknown as CommandContext, () => {});
      ws.localEditor = editor;
      for (let i = 0; i < 12; i++) await Promise.resolve();
      const initialRequests = fake.requests.length;
      await submitAgentWorkspaceCalendarSubscribeWizardEditor(ws, editor, CONTEXT, (id) => editor.fields.find((field) => field.id === id)?.value ?? '', build);
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(fetched).toBe(url);
      expect(ws.localEditor?.message).toContain(url);
      expect(ws.editorMessageState.status).toBe('protected');
      expect(fake.requests).toHaveLength(initialRequests);
      expect(JSON.stringify(fake.requests)).not.toContain(url);
      expect(store.size).toBe(0);
      // Trimming provenance remains bound to the produced error, even after
      // the field changes and the same failed editor is reopened/reworded.
      ws.appendEditorText('X');
      for (let i = 0; i < entered.length + 1; i++) ws.editorBackspace();
      const failed = ws.localEditor!;
      ws.close(); ws.reopen();
      ws.localEditor = { ...failed, message: `Previous feed failure: ${url}` };
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(ws.editorMessageState.status).toBe('protected');
      expect(fake.requests).toHaveLength(initialRequests);
    } finally { ws.close(); installJudgmentPort(previous); }
  });

  test.each(['', ' ', '\t\n'])('empty submitted feed %j does not protect unrelated validation wording', async (value) => {
    const fake = fakePort(() => noulAnswer(0.99));
    const previous = installJudgmentPort(fake.port);
    const ws = new AgentWorkspace();
    const template = createCalendarSubscribeWizardEditor();
    const editor = { ...template, fields: template.fields.map((field) => ({ ...field, value: field.id === 'url' ? value : field.id === 'confirm' ? 'yes' : field.value })) };
    const { store, secrets } = memorySecrets();
    let fetches = 0;
    const { build } = builderWith(store, secrets, async () => { fetches++; return { kind: 'error', message: 'Unexpected fetch' }; });
    try {
      ws.open({ ...CONTEXT, executeCommand: async () => true, print() {}, renderRequest() {} } as unknown as CommandContext, () => {});
      ws.localEditor = editor;
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(ws.editorMessageState.status).toBe('read');
      await submitAgentWorkspaceCalendarSubscribeWizardEditor(ws, editor, CONTEXT, (id) => editor.fields.find((field) => field.id === id)?.value ?? '', build);
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(ws.localEditor?.message).toBe('A feed URL is required.');
      expect(ws.editorMessageState.status).toBe('read');
      expect(fake.requests).toHaveLength(2);
      expect(fetches).toBe(0); expect(store.size).toBe(0);
    } finally { ws.close(); installJudgmentPort(previous); }
  });

  test('not confirmed: stays open, no subscribe', async () => {
    const host = makeHost();
    const editor = createCalendarSubscribeWizardEditor();
    const { store, secrets } = memorySecrets();
    const { build } = builderWith(store, secrets, fetcherOf({ kind: 'ok', body: ICS }));
    await submitAgentWorkspaceCalendarSubscribeWizardEditor(host, editor, CONTEXT, fieldReaderFrom({ url: SECRET_URL, confirm: 'no' }), build);
    expect(host.localEditor?.kind).toBe('calendar-subscribe-wizard');
    expect(store.size).toBe(0);
  });

  test('success: stores the URL as a secret, closes the editor, and never leaks the URL', async () => {
    const host = makeHost();
    const editor = createCalendarSubscribeWizardEditor();
    const { store, secrets } = memorySecrets();
    const { build } = builderWith(store, secrets, fetcherOf({ kind: 'ok', body: ICS }));
    await submitAgentWorkspaceCalendarSubscribeWizardEditor(host, editor, CONTEXT, fieldReaderFrom({ url: SECRET_URL, confirm: 'yes' }), build);

    expect(host.localEditor).toBeNull();
    expect(host.lastActionResult?.kind).toBe('refreshed');
    expect(host.status).toContain('Subscribed');
    // The secret is stored; the raw URL/token never surfaces in the visible result.
    expect([...store.values()]).toContain(SECRET_URL);
    const surfaced = JSON.stringify(host.lastActionResult) + host.status;
    expect(surfaced).not.toContain('topsecret123');
    expect(surfaced).not.toContain(SECRET_URL);
  });

  test('fetch failure: honest staged error, keeps fields, saves nothing', async () => {
    const host = makeHost();
    const editor = createCalendarSubscribeWizardEditor();
    const { store, secrets } = memorySecrets();
    const { build } = builderWith(store, secrets, fetcherOf({ kind: 'error', status: 404, message: 'not found' }));
    await submitAgentWorkspaceCalendarSubscribeWizardEditor(host, editor, CONTEXT, fieldReaderFrom({ url: SECRET_URL, confirm: 'yes' }), build);

    expect(host.localEditor?.kind).toBe('calendar-subscribe-wizard'); // kept open
    expect(host.lastActionResult?.kind).toBe('error');
    expect(host.lastActionResult?.detail).toContain('fetch');
    expect(store.size).toBe(0); // nothing saved
  });

  test('parse failure: names the parse stage', async () => {
    const host = makeHost();
    const editor = createCalendarSubscribeWizardEditor();
    const { store, secrets } = memorySecrets();
    const { build } = builderWith(store, secrets, fetcherOf({ kind: 'ok', body: '<html>nope</html>' }));
    await submitAgentWorkspaceCalendarSubscribeWizardEditor(host, editor, CONTEXT, fieldReaderFrom({ url: SECRET_URL, confirm: 'yes' }), build);
    expect(host.lastActionResult?.kind).toBe('error');
    expect(host.lastActionResult?.detail).toContain('parse');
  });

  test('no registry (no secret manager): honest unavailable error', async () => {
    const host = makeHost();
    const editor = createCalendarSubscribeWizardEditor();
    await submitAgentWorkspaceCalendarSubscribeWizardEditor(host, editor, CONTEXT, fieldReaderFrom({ url: SECRET_URL, confirm: 'yes' }), () => null);
    expect(host.lastActionResult?.kind).toBe('error');
    expect(host.lastActionResult?.detail).toContain('secret manager');
  });
});
