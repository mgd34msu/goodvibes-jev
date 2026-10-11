import { liveControlDescriptor } from './_helpers/browser-control-descriptor.js';
/** No browser is launched: real engine + adapter over a synthetic Page/session. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Page } from 'playwright-core';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { BrowserEngine } from '../sdk/src/platform/browser/browser-engine.ts';
import type { BrowserSessionManager } from '../sdk/src/platform/browser/browser-sessions.ts';
import type { UntrustedContentPort } from '../sdk/src/platform/browser/browser-types.ts';
import { createGoogleBrowserPort } from '../sdk/src/platform/google/browser-port.ts';
import { consumeGoogleElement, findElement } from '../sdk/src/platform/google/browser-elements.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
function readings() { return fakePort((name, question) => name === 'pick' ? choiceAnswer(question, 'control_0', 0.99) : noulAnswer(0.99)); }
function gate() {
  let release!: () => void, began!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { began = resolve; });
  return { started, release, hold: async () => { began(); await waiting; } };
}
function fixture() {
  const effects: string[] = [];
  const row = { tag: 'button', role: 'button', name: 'Create', selector: '#create', value: null, disabled: false, checked: null, depth: 1, submits: true };
  let rows: unknown = [row];
  let targetWait: (() => Promise<void>) | undefined, resolveWait: (() => Promise<void>) | undefined, approvalWait: (() => Promise<void>) | undefined;
  const locator = {
    count: async () => { await resolveWait?.(); return 1; }, first: () => locator,
    evaluate: async () => liveControlDescriptor(row),
    click: async () => { effects.push('click'); }, fill: async () => { effects.push('fill'); },
    press: async () => { effects.push('press'); }, pressSequentially: async () => { effects.push('type'); },
  };
  const frame = { parentFrame: () => null, evaluate: async (_fn: unknown, argument: unknown) => typeof argument === 'number' ? rows : '' };
  const page = { url: () => 'https://console.cloud.google.com/auth/clients', title: async () => 'Synthetic',
    frames: () => [frame], mainFrame: () => frame, locator: () => locator,
    goto: async () => null, waitForLoadState: async () => {}, evaluate: async () => '',
  } as unknown as Page;
  const sessions = { provisionReport: () => null, defaultSessionId: () => 's', page: async () => { await targetWait?.(); return { pageId: 'p', page }; } } as unknown as BrowserSessionManager;
  const untrusted: UntrustedContentPort = { rule: 'Untrusted', originOf: url => new URL(url).origin, recordIngest() {},
    label: input => ({ trust: 'untrusted', surface: 'web-page', origin: input.origin, retrievedAt: 'synthetic', text: input.text, truncated: input.truncated === true, rule: 'Untrusted' }),
    evaluateOutwardEffect: async () => { await approvalWait?.(); return { allowed: true, reason: null, fix: null, untrustedOrigins: [] }; },
  };
  const engine = new BrowserEngine(sessions, { screenshotDirectory: '/synthetic-unused', untrusted });
  const browser = createGoogleBrowserPort(engine);
  return { engine, browser, effects, row, rows: (value: unknown) => { rows = value; },
    hold: (stage: string, wait: () => Promise<void>) => { if (stage === 'target') targetWait = wait; if (stage === 'resolve') resolveWait = wait; if (stage === 'approval') approvalWait = wait; },
  };
}
for (const stage of ['target', 'resolve', 'approval']) for (const action of ['click', 'type'] as const) test(`retirement during real ${action} ${stage} await prevents locator effect`, async () => {
  const fake = readings(); installJudgmentPort(fake.port); const rig = fixture();
  await rig.browser.navigate('https://console.cloud.google.com/auth/clients'); await rig.browser.snapshot();
  const held = gate(); rig.hold(stage, held.hold); let active = true;
  const ownership = { assertCurrent: () => { if (!active) throw new Error('retired'); } };
  const pending = action === 'click' ? rig.browser.click('e1', ownership) : rig.browser.type('e1', 'synthetic', { ...ownership, submit: true });
  const refused = pending.then(() => null, error => error);
  await held.started; active = false; held.release(); expect(await refused).toBeInstanceOf(Error);
  expect(rig.effects).toEqual([]);
});
test('a same-label snapshot replacement while approval waits cannot reuse an old ref', async () => {
  installJudgmentPort(readings().port); const rig = fixture(); await rig.browser.navigate('https://console.cloud.google.com/auth/clients'); await rig.browser.snapshot();
  const held = gate(); rig.hold('approval', held.hold);
  const pending = rig.browser.click('e1', { assertCurrent() {} }); const refused = pending.then(() => null, error => error);
  await held.started; await rig.engine.snapshot({ sessionId: 's', pageId: 'p' }); held.release(); expect(await refused).toBeInstanceOf(Error);
  expect(rig.effects).toEqual([]);
});
test('retirement of the selected judgment during actual engine approval prevents the click', async () => {
  installJudgmentPort(readings().port); const rig = fixture(); await rig.browser.navigate('https://console.cloud.google.com/auth/clients');
  const elements = await rig.browser.snapshot(); const chosen = await findElement(elements, { purpose: 'Create client' }, { browser: rig.browser });
  const held = gate(); rig.hold('approval', held.hold);
  const pending = consumeGoogleElement(rig.browser, chosen!); const refused = pending.then(() => null, error => error);
  await held.started; installJudgmentPort(readings().port); held.release(); expect(await refused).toBeInstanceOf(Error);
  expect(rig.effects).toEqual([]);
});
test('complete raw labels are privacy-admitted before truncation and before any model call', async () => {
  const fake = readings(); installJudgmentPort(fake.port); const rig = fixture();
  rig.rows([{ ...rig.row, name: 'A'.repeat(200) + ' client_secret=GOCSPX-private' }]);
  await expect(rig.browser.snapshot()).rejects.toThrow(); expect(fake.requests).toHaveLength(0);
});
for (const mode of ['getter', 'proxy']) test(`raw ${mode} snapshots are rejected without executing accessors or traps`, async () => {
  const fake = readings(); installJudgmentPort(fake.port); const rig = fixture(); let touched = 0;
  const value = mode === 'getter' ? Object.defineProperty({}, 'name', { get() { touched += 1; return 'Create'; } })
    : new Proxy({}, { getPrototypeOf() { touched += 1; return Object.prototype; } });
  rig.rows([value]); await expect(rig.browser.snapshot()).rejects.toThrow();
  expect(touched).toBe(0); expect(fake.requests).toHaveLength(0);
});

test('same-label snapshot ABA during a held judgment retires the original page observation', async () => {
  const base = readings().port, held = gate();
  installJudgmentPort({ model: base.model, ask: async request => { await held.hold(); return base.ask(request); } });
  const rig = fixture(); await rig.browser.navigate('https://console.cloud.google.com/auth/clients');
  const elements = await rig.browser.snapshot();
  const pending = findElement(elements, { purpose: 'Create client' }, { browser: rig.browser });
  const refused = pending.then(() => null, error => error);
  await held.started;
  rig.rows([{ ...rig.row, name: 'Unrelated action' }]); await rig.engine.snapshot({ sessionId: 's', pageId: 'p' });
  rig.rows([rig.row]); await rig.engine.snapshot({ sessionId: 's', pageId: 'p' });
  held.release(); expect(await refused).toBeInstanceOf(Error); expect(rig.effects).toEqual([]);
});

test('a safe accessible name cannot hide secret-bearing metadata from an upstream card-field reading', async () => {
  const fake = readings(); installJudgmentPort(fake.port); const rig = fixture();
  rig.rows([{ ...rig.row, tag: 'input', role: 'textbox', name: 'Name', value: 'never-send-value', control: {
    type: 'text', autocomplete: '', name: 'app', id: 'app', ariaLabel: 'Name', label: 'Name',
    placeholder: 'A'.repeat(200) + ' client_secret=GOCSPX-private',
  } }]);
  await expect(rig.browser.snapshot()).rejects.toThrow();
  expect(fake.requests).toHaveLength(0);
});
