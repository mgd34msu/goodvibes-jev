import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { findElement, requireElement, looksLikeGoogleSignIn, consumeGoogleElement } from '../sdk/src/platform/google/browser-elements.ts';
import { createAppPassword } from '../sdk/src/platform/google/app-password-flow.ts';
import { ownGoogleBrowser } from '../sdk/src/platform/google/browser-readings.ts';
import type { GoogleBrowserElement, GoogleBrowserPort } from '../sdk/src/platform/google/types.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const element = (ref: string, name: string, role = 'button', value?: string): GoogleBrowserElement => ({ ref, name, role, tag: 'input', value });
function selection(chosen = 'control_1', probability = 0.99) {
  return fakePort((name, question) => name === 'pick' ? choiceAnswer(question, chosen, probability)
    : noulAnswer(name === `fits_${chosen.split('_')[1]}` ? 0.99 : 0.01));
}
function browserRig(initial = [element('unrelated', 'Create project'), element('submit', 'Créer')]) {
  let elements = initial, url = 'https://console.cloud.google.com/alternate-route', revision = 0;
  const clicked: string[] = [], typed: string[] = [];
  const browser: GoogleBrowserPort = {
    navigate: async () => ({ url, title: 'Synthetic' }), currentUrl: async () => url,
    snapshot: async () => elements, readText: async () => '',
    click: async ref => { clicked.push(ref); revision += 1; },
    type: async ref => { typed.push(ref); revision += 1; },
    captureAuthority: () => { const at = revision; return { assertCurrent: () => { if (at !== revision) throw new Error('changed'); } }; },
  };
  return { browser, clicked, typed, elements: () => elements, change: (next: GoogleBrowserElement[]) => { elements = next; }, navigate: () => { url += '/new'; revision += 1; }, replacePage: () => { revision += 1; } };
}
function held(base: JudgmentPort) {
  let release!: () => void, began!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  const port: JudgmentPort = { model: base.model, ask: async request => { began(); await gate; return base.ask(request); } };
  return { port, started, release };
}

describe('Google setup semantic control contract', () => {
  test('purpose selection chooses a localized control after an overlapping Create label', async () => {
    const fake = selection(); installJudgmentPort(fake.port);
    const rig = browserRig();
    const chosen = await findElement(rig.elements(), { role: 'button', purpose: 'Submit the completed client form' }, { browser: rig.browser });
    expect(chosen?.ref).toBe('submit');
    expect(JSON.stringify(fake.requests[0]?.state)).toContain('Create project');
    await consumeGoogleElement(rig.browser, chosen!);
    expect(rig.clicked).toEqual(['submit']);
    await expect(consumeGoogleElement(rig.browser, chosen!)).rejects.toThrow();
  });
  test('none is a normal no-match, never a first-control fallback', async () => {
    installJudgmentPort(selection('none').port); const rig = browserRig();
    expect((await requireElement(rig.elements(), { purpose: 'Confirm publication' }, { browser: rig.browser })).found).toBe(false);
    expect(rig.clicked).toEqual([]);
  });
  for (const mode of ['missing', 'malformed', 'unavailable', 'weak'] as const) test(`${mode} never supplies a control`, async () => {
    if (mode === 'malformed') installJudgmentPort(fakePort(() => ({ type: 'choice', choice: 'foreign' })).port);
    if (mode === 'unavailable') installJudgmentPort({ model: 'jev-1.13.0', ask: async () => { throw new Error('password=synthetic'); } });
    if (mode === 'weak') installJudgmentPort(selection('control_1', 0.6).port);
    const rig = browserRig();
    await expect(findElement(rig.elements(), { purpose: 'Create client' }, { browser: rig.browser })).rejects.toThrow('Google setup page reading');
    expect(rig.clicked).toEqual([]);
  });
  for (const mode of ['snapshot', 'page', 'port', 'cancel', 'request'] as const) test(`held ${mode} invalidation prevents a late action`, async () => {
    const delayed = held(selection().port); installJudgmentPort(delayed.port);
    const rig = browserRig(), abort = new AbortController(); let active = true;
    const pending = findElement(rig.elements(), { purpose: 'Create client' }, { browser: rig.browser, signal: abort.signal, assertCurrent: () => { if (!active) throw new Error('retired'); } });
    const rejected = pending.then(() => null, error => error);
    await delayed.started;
    if (mode === 'snapshot') rig.change([element('new', 'Create')]);
    if (mode === 'page') rig.replacePage();
    if (mode === 'port') { installJudgmentPort(selection().port); installJudgmentPort(delayed.port); }
    if (mode === 'cancel') abort.abort();
    if (mode === 'request') active = false;
    delayed.release(); expect(await rejected).toBeInstanceOf(Error);
    expect(rig.clicked).toEqual([]); expect(rig.typed).toEqual([]);
  });
  for (const mode of ['snapshot', 'page', 'port', 'foreign', 'cancel'] as const) test(`settled ${mode} invalidation rejects consumption`, async () => {
    const fake = selection(); installJudgmentPort(fake.port); const rig = browserRig(), abort = new AbortController();
    const chosen = await findElement(rig.elements(), { purpose: 'Create client' }, { browser: rig.browser, signal: abort.signal });
    if (mode === 'snapshot') rig.change([...rig.elements(), element('extra', 'Créer aussi')]);
    if (mode === 'page') rig.replacePage();
    if (mode === 'port') { installJudgmentPort(selection().port); installJudgmentPort(fake.port); }
    if (mode === 'cancel') abort.abort();
    await expect(consumeGoogleElement(mode === 'foreign' ? browserRig().browser : rig.browser, chosen!)).rejects.toThrow();
    expect(rig.clicked).toEqual([]);
  });
  test('secret-bearing values never enter the control or sign-in model input', async () => {
    const fake = selection('control_0'); installJudgmentPort(fake.port);
    const entries = [element('create', 'Create', 'button', 'GOCSPX-never-transmit'), element('field', 'Name', 'textbox', 'abcd efgh ijkl mnop')];
    await findElement(entries, { purpose: 'Create', role: 'button' });
    expect(JSON.stringify(fake.requests)).not.toContain('GOCSPX-never-transmit');
    expect(JSON.stringify(fake.requests)).not.toContain('abcd efgh');
    const state = fakePort(() => noulAnswer(0.01)); installJudgmentPort(state.port);
    await looksLikeGoogleSignIn('https://myaccount.google.com/settings', entries);
    expect(JSON.stringify(state.requests)).not.toContain('GOCSPX-never-transmit');
  });
  test('privacy admission screens every label before structural filtering or candidate caps', async () => {
    const fake = selection(); installJudgmentPort(fake.port);
    const entries = Array.from({ length: 100 }, (_, i) => element(`e${i}`, 'Create'));
    entries.push(element('secret', 'client_secret=GOCSPX-private', 'textbox'));
    await expect(findElement(entries, { role: 'button', purpose: 'Create' })).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });
  test('misleading password labels and alternate localized sign-in pages follow typed readings', async () => {
    installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
    expect(await looksLikeGoogleSignIn('https://accounts.google.com/settings/signin-history', [element('app', 'App password name', 'textbox')])).toBe(false);
    installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
    expect(await looksLikeGoogleSignIn('https://accounts.google.com/v3/challenge', [element('pass', 'Passwort eingeben', 'textbox')])).toBe(true);
  });
  test('cancelled app-password flow cannot type or click after a held page reading', async () => {
    const delayed = held(fakePort(() => noulAnswer(0.01)).port); installJudgmentPort(delayed.port);
    const rig = browserRig([element('name', 'App name', 'textbox'), element('create', 'Create')]), abort = new AbortController();
    const result = createAppPassword(rig.browser, { signal: abort.signal });
    const rejected = result.then(() => null, error => error); await delayed.started; abort.abort();
    delayed.release(); expect(await rejected).toBeInstanceOf(Error); await Promise.resolve();
    expect(rig.clicked).toEqual([]); expect(rig.typed).toEqual([]);
  });
});

test('consumed browser restriction still rejects replacement of original browser methods', () => {
  installJudgmentPort(selection().port); const rig = browserRig();
  const effect = ownGoogleBrowser(rig.browser).consumeObservation();
  expect(() => effect.assertCurrent()).not.toThrow();
  rig.browser.click = async () => {};
  expect(() => effect.assertCurrent()).toThrow();
});

test('ordinary four-letter-word sign-in prose reaches the typed page reader', async () => {
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  expect(await looksLikeGoogleSignIn('https://accounts.google.com/alternate', [element('sign-in', 'Sign into your work account')])).toBe(true);
  expect(fake.requests.length).toBeGreaterThan(0);
});
test('an entire app-password-shaped metadata field is refused before any model request', async () => {
  const fake = selection(); installJudgmentPort(fake.port);
  await expect(findElement([element('credential', 'abcd efgh ijkl mnop')], { purpose: 'Create' })).rejects.toThrow();
  expect(fake.requests).toHaveLength(0);
});
