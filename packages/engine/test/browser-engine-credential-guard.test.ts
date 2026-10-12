import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { BrowserHostClient, remotePage, browserHostScriptPath } from '../sdk/src/platform/browser/browser-host-client.js';
import { liveControlDescriptor } from './_helpers/browser-control-descriptor.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
type BrowserContext = unknown;
import { BrowserEngine, BrowserSessionError } from '../sdk/src/platform/browser/browser-engine.js';
import { looksLikeCredentialPage } from '../sdk/src/platform/browser/browser-engine-contract.js';
import { BrowserSessionManager } from '../sdk/src/platform/browser/browser-sessions.js';
import type {
  BrowserProvisionIo,
  OutwardEffectDecision,
  OwnerApproval,
  UntrustedContentEnvelope,
  UntrustedContentPort,
} from '../sdk/src/platform/browser/browser-types.js';
import { securityPort } from './helpers/security-readings.ts';
import { bindJudgmentPortAuthority, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { createGoogleBrowserPort } from '../sdk/src/platform/google/browser-port.js';
import { findElement, consumeGoogleElement } from '../sdk/src/platform/google/browser-elements.js';
import { googleSetupControl, ownGoogleBrowser } from '../sdk/src/platform/google/browser-readings.js';
import { DRIVER_VERSION } from '../sdk/src/platform/browser/browser-provision-io.js';
import { browserCredentialPage } from '../sdk/src/platform/browser/browser-control-identity.js';
import { CardMaterialRedactor } from '../sdk/src/platform/payments/card-redaction.js';
import type { CardFieldGuard } from '../sdk/src/platform/browser/browser-types.js';

let previous: ReturnType<typeof installJudgmentPort>;
let pages: ReturnType<typeof fakePort>;
let security: ReturnType<typeof securityPort>;
let installed: JudgmentPort;
const expectedPages = new Map<string, number>();
const engines = new Set<BrowserEngine>();
beforeEach(() => {
  expectedPages.clear();
  security = securityPort();
  pages = fakePort((name, question, state) => {
    expect(name).toBe('credentialPage');
    expect<unknown>(question).toEqual(browserCredentialPage.items.credentialPage.question);
    const probability = expectedPages.get(JSON.stringify(state));
    if (probability === undefined) throw new Error('Unprovided exact browser page fixture');
    return noulAnswer(probability);
  });
  installed = { ...security.port, ask: request => request.context?.battery === browserCredentialPage.name
    ? pages.port.ask(request) : security.port.ask(request) };
  previous = installJudgmentPort(installed);
});
afterEach(async () => {
  try {
    const outcomes = await Promise.allSettled([...engines].map(engine => engine.shutdown()));
    const failures = outcomes.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Browser fixture teardown failed.');
  }
  finally { engines.clear(); installJudgmentPort(previous); }
});

/**
 * The browser layer's own backstop against driving a sign-in page, one
 * click/type/press/select call at a time, see `refuseCredentialInteraction`
 * in browser-engine.ts. This is separate from (and a fallback for) the
 * Google-specific `looksLikeGoogleSignIn` check the structured flows in
 * `platform/google/` already run before this code is ever reached: those
 * flows navigate, look, and bail; this file tests what happens when nothing
 * is watching and the browser tool is driven directly.
 */

const SCREENSHOT_DIRECTORY = join(tmpdir(), 'goodvibes-credential-guard-test');

const NOOP_RULE = 'This content came from a source outside the owner\'s control.';

class NoopUntrustedContentPort implements UntrustedContentPort {
  readonly rule = NOOP_RULE;

  originOf(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  }

  label(input: { readonly origin: string; readonly text: string; readonly truncated?: boolean }): UntrustedContentEnvelope {
    return {
      trust: 'untrusted',
      surface: 'web-page',
      origin: input.origin,
      retrievedAt: new Date().toISOString(),
      text: input.text,
      truncated: input.truncated === true,
      rule: this.rule,
    };
  }

  recordIngest(): void {
    // Not exercised here, the outward-effect ledger has its own test file.
  }

  async evaluateOutwardEffect(_input: {
    readonly action: string;
    readonly description: string;
    readonly approval: OwnerApproval | null;
  }): Promise<OutwardEffectDecision> {
    return { allowed: true, reason: null, fix: null, untrustedOrigins: [] };
  }
}

interface RawElement {
  readonly tag: string;
  readonly role: string;
  readonly name: string;
  readonly selector: string;
  readonly value: string | null;
  readonly disabled: boolean;
  readonly checked: boolean | null;
  readonly depth: number;
  readonly submits: boolean;
  readonly control?: { readonly type: string; readonly autocomplete: string; readonly name: string; readonly id: string; readonly placeholder: string; readonly ariaLabel: string; readonly label: string };
}
const attributes = (type = '') => ({ type, autocomplete: '', name: '', id: '', placeholder: '', ariaLabel: '', label: '' });
interface PageFixtureOptions {
  title?: string;
  readonly purpose?: 'yes' | 'no' | 'uncertain';
  readonly guard?: CardFieldGuard;
  readonly effects?: string[];
  readonly onCollect?: () => void;
  readonly preparePage?: (page: object) => void;
  readonly arm?: (sessionId: string, pageId: string) => void;
  readonly onAction?: (method: string, signal: AbortSignal | undefined) => Promise<void>;
}
function pageState(url: string, title: string, elements: readonly RawElement[]) {
  return { url, documents: [{ frameChain: [], url, title, controls: elements.map(element => ({ documentUrl: url,
    tag: element.tag, role: element.role, name: element.name, selector: element.selector, disabled: element.disabled,
    checked: element.checked, depth: element.depth, submits: element.submits, control: element.control ?? attributes() })) }] };
}

function fakePage(url: string, elements: readonly RawElement[], options: PageFixtureOptions = {}) {
  const entered = new Map<string, string>();
  const title = () => options.title ?? (url === EMAIL_STEP_URL ? 'Sign in' : 'Dashboard');
  const raw = (identityOnly = false) => elements.map(element => ({ ...element, value: identityOnly ? null : entered.get(element.selector) ?? element.value, documentUrl: url, control: element.control ?? attributes() }));
  const action = async (method: string, actionOptions: { readonly signal?: AbortSignal | undefined }, effect: () => void): Promise<void> => {
    await options.onAction?.(method, actionOptions.signal);
    actionOptions.signal?.throwIfAborted(); effect();
  };
  const locatorFor = (selector: string) => {
    const element = elements.find((entry) => entry.selector === selector);
    const matches = element !== undefined;
    const locator = {
      count: async () => (matches ? 1 : 0),
      nth: () => locator,
      first: () => locator,
      evaluate: async () => ({ ...liveControlDescriptor({ tag: element?.tag ?? '', name: element?.name ?? '', submits: element?.submits ?? false }, url), type: element?.control?.type ?? '' }),
      click: async (actionOptions: { readonly signal?: AbortSignal | undefined } = {}) => action('click', actionOptions, () => { options.effects?.push('click'); }),
      fill: async (text: string, actionOptions: { readonly signal?: AbortSignal | undefined } = {}) => action('fill', actionOptions, () => { entered.set(selector, text); options.effects?.push('fill'); }),
      press: async (_key: string, actionOptions: { readonly signal?: AbortSignal | undefined } = {}) => action('press', actionOptions, () => { options.effects?.push('press'); }),
      pressSequentially: async (_text: string, actionOptions: { readonly signal?: AbortSignal | undefined } = {}) => action('pressSequentially', actionOptions, () => { options.effects?.push('pressSequentially'); }),
      selectOption: async (_values: readonly string[], actionOptions: { readonly signal?: AbortSignal | undefined } = {}) => { await action('select', actionOptions, () => { options.effects?.push('select'); }); return []; },
      scrollIntoViewIfNeeded: async () => undefined,
    };
    return locator;
  };
  const mainFrame = {
    url: () => url,
    parentFrame: () => null,
    evaluate: async (_fn: unknown, arg?: unknown) => {
      options.onCollect?.();
      return arg && typeof arg === 'object' && 'identityOnly' in arg && arg.identityOnly === true
        ? { url, title: title(), elements: raw(true) } : raw();
    },
  };
  return {
    url: () => url,
    title: async () => title(),
    frames: () => [mainFrame],
    mainFrame: () => mainFrame,
    on: () => undefined,
    close: async () => undefined,
    goto: async () => null,
    waitForLoadState: async () => undefined,
    locator: (selector: string) => locatorFor(selector),
    evaluate: async () => elements,
  };
}

function readyIo(): BrowserProvisionIo {
  return {
    resolveDriver: () => ({ available: true, packageDirectory: '/pkg', cliPath: '/pkg/cli.js', version: '1.62.0', error: null }),
    expectedExecutablePath: () => '/cache/chromium/chrome',
    browsersPath: () => '/cache',
    pathExists: () => true,
    isExecutableFile: () => true,
    directoryWritable: () => true,
    removePath: () => undefined,
    runCommand: async () => ({ code: 0, stdout: 'Chromium', stderr: '', timedOut: false, spawnError: null }),
    systemBrowserCandidates: () => [],
    now: () => 0,
  };
}

async function buildEngine(url: string, elements: readonly RawElement[], options: PageFixtureOptions = {}): Promise<BrowserEngine> {
  const page = fakePage(url, elements, options);
  expectedPages.set(JSON.stringify(pageState(url, options.title ?? (url === EMAIL_STEP_URL ? 'Sign in' : 'Dashboard'), elements)), options.purpose === 'yes' ? 0.99 : options.purpose === 'uncertain' ? 0.5 : 0.01);
  options.preparePage?.(page);
  const context = {
    pages: () => [page],
    on: () => undefined,
    newPage: async () => page,
    close: async () => undefined,
  } as unknown as BrowserContext;
  const sessions = new BrowserSessionManager({
    profileRoot: join(tmpdir(), 'goodvibes-credential-guard-profiles'),
    surfaceRoot: 'test-surface',
    io: readyIo(),
    loadDriver: (() => ({
      chromium: {
        launchPersistentContext: async () => context,
        connectOverCDP: async () => ({ contexts: () => [context] }),
      },
    })) as unknown as NonNullable<ConstructorParameters<typeof BrowserSessionManager>[0]['loadDriver']>,
  });
  const engine = new BrowserEngine(sessions, { screenshotDirectory: SCREENSHOT_DIRECTORY, untrusted: new NoopUntrustedContentPort(), ...(options.guard ? { cardFieldGuard: options.guard } : {}) });
  engines.add(engine);
  await engine.launch({ headless: true });
  if (options.arm) {
    const sessionId = sessions.defaultSessionId();
    if (!sessionId) throw new Error('Native fixture has no session');
    const { pageId } = await sessions.page(sessionId);
    options.arm(sessionId, pageId);
  }
  return engine;
}

const EMAIL_STEP_URL = 'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmyaccount.google.com';
const PASSWORD_STEP_ELEMENTS: readonly RawElement[] = [
  { tag: 'input', role: 'textbox', name: 'Enter your password', selector: '#password', control: attributes('password'), value: '', disabled: false, checked: null, depth: 3, submits: false },
  { tag: 'button', role: 'button', name: 'Next', selector: '#next', value: null, disabled: false, checked: null, depth: 3, submits: true },
];
const EMAIL_STEP_ELEMENTS: readonly RawElement[] = [
  { tag: 'input', role: 'textbox', name: 'Email or phone', selector: '#identifier', value: '', disabled: false, checked: null, depth: 3, submits: false },
  { tag: 'button', role: 'button', name: 'Next', selector: '#next', value: null, disabled: false, checked: null, depth: 3, submits: true },
];
const ORDINARY_URL = 'https://example.com/dashboard';
const ORDINARY_ELEMENTS: readonly RawElement[] = [
  { tag: 'button', role: 'button', name: 'Refresh', selector: '#refresh', value: null, disabled: false, checked: null, depth: 2, submits: false },
];

describe('looksLikeCredentialPage', () => {
  test('a password field on any host is a credential page', () => {
    expect(looksLikeCredentialPage('https://random-startup.example/login-step-2', true)).toBe(true);
  });

  test('a known identity provider sign-in route is a credential page even with no password field yet', () => {
    expect(looksLikeCredentialPage(EMAIL_STEP_URL, false)).toBe(true);
  });

  test('an ordinary page on an ordinary host is not a credential page', () => {
    expect(looksLikeCredentialPage(ORDINARY_URL, false)).toBe(false);
  });

  test('a known identity host with no sign-in path and no password field is not flagged', () => {
    expect(looksLikeCredentialPage('https://accounts.google.com/some/other/page', false)).toBe(false);
  });
});

describe('the browser layer refuses to drive a sign-in page', () => {
  test('click on the Google email step is refused with the URL to hand back', async () => {
    const engine = await buildEngine(EMAIL_STEP_URL, EMAIL_STEP_ELEMENTS, { purpose: 'yes' });
    const snapshot = await engine.snapshot({});
    const next = (snapshot.elements as { ref: string; name: string }[]).find((entry) => entry.name === 'Next')!;
    try {
      await engine.click({}, { ref: next.ref });
      throw new Error('the click should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserSessionError);
      expect((error as Error).message).toContain('sign-in page');
      expect((error as BrowserSessionError).fix).toContain(EMAIL_STEP_URL);
    }
  });

  test('typing into the password step is refused', async () => {
    const engine = await buildEngine(EMAIL_STEP_URL, PASSWORD_STEP_ELEMENTS);
    const snapshot = await engine.snapshot({});
    const password = (snapshot.elements as { ref: string; role: string }[]).find((entry) => entry.role === 'textbox')!;
    await expect(engine.type({}, { ref: password.ref, text: 'hunter2' })).rejects.toThrow(BrowserSessionError);
  });

  test('pressing Enter on a sign-in page is refused', async () => {
    const engine = await buildEngine(EMAIL_STEP_URL, PASSWORD_STEP_ELEMENTS);
    const snapshot = await engine.snapshot({});
    const password = (snapshot.elements as { ref: string; role: string }[]).find((entry) => entry.role === 'textbox')!;
    await expect(engine.press({}, { ref: password.ref, key: 'Enter' })).rejects.toThrow(BrowserSessionError);
  });

  test('reading the page is still allowed, since that is how the URL gets reported back', async () => {
    const engine = await buildEngine(EMAIL_STEP_URL, EMAIL_STEP_ELEMENTS, { purpose: 'yes' });
    await expect(engine.snapshot({})).resolves.toBeDefined();
    await expect(engine.readText({})).resolves.toBeDefined();
  });

  test('an ordinary page is not affected: click still works', async () => {
    const engine = await buildEngine(ORDINARY_URL, ORDINARY_ELEMENTS);
    const snapshot = await engine.snapshot({});
    const refresh = (snapshot.elements as { ref: string; name: string }[]).find((entry) => entry.name === 'Refresh')!;
    const result = await engine.click({}, { ref: refresh.ref });
    expect((result.clicked as { name: string }).name).toBe('Refresh');
  });
});


function fixtureRow(rows: readonly RawElement[], index: number): RawElement {
  const row = rows[index]; if (!row) throw new Error('Missing authored native row'); return row;
}
const nativeActions = {
  click: (engine: BrowserEngine) => engine.click({}, { ref: 'e1' }),
  type: (engine: BrowserEngine) => engine.type({}, { ref: 'e1', text: 'ordinary query' }),
  select: (engine: BrowserEngine) => engine.select({}, { ref: 'e1', values: ['one'] }),
  press: (engine: BrowserEngine) => engine.press({}, { ref: 'e1', key: 'Tab' }),
};
function gate() {
  let release: () => void = () => {}, began: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  const base = installed;
  let raw: Promise<Awaited<ReturnType<JudgmentPort['ask']>>> | undefined;
  installed = { ...base, ask(request) {
    if (request.context?.battery !== browserCredentialPage.name) return base.ask(request);
    began(); raw = pending.then(() => base.ask(request)); return raw;
  } };
  installJudgmentPort(installed);
  return { started, release, drain: async () => { release(); await raw?.catch(() => {}); } };
}
describe('current native credential-page purpose', () => {
  test('an unlisted host identifier step is refused before an effect', async () => {
    const effects: string[] = [];
    const engine = await buildEngine('https://unlisted.example/session', EMAIL_STEP_ELEMENTS, { title: 'Access your account', purpose: 'yes', effects });
    await engine.snapshot({});
    await expect(engine.click({}, { ref: 'e2' })).rejects.toThrow(BrowserSessionError);
    expect(pages.requests).toHaveLength(1); expect(effects).toEqual([]);
    expect(pages.requests[0]?.state).toEqual(pageState('https://unlisted.example/session', 'Access your account', EMAIL_STEP_ELEMENTS));
  });
  test.each(Object.keys(nativeActions))('native password type without a password label blocks %s without a reading', async action => {
    const effects: string[] = [];
    const rows = [{ ...fixtureRow(PASSWORD_STEP_ELEMENTS, 0), name: 'Continue', control: attributes('password') }];
    const engine = await buildEngine('https://unlisted.example/account', rows, { effects }); await engine.snapshot({});
    if (!(action in nativeActions)) throw new Error('Unknown native action');
    const run = Object.entries(nativeActions).find(([name]) => name === action)?.[1];
    if (!run) throw new Error('Unknown native action');
    await expect(run(engine)).rejects.toThrow(BrowserSessionError);
    expect(pages.requests).toHaveLength(0); expect(effects).toEqual([]);
  });
  test('harmless password accessible prose remains usable after an exact no reading', async () => {
    const effects: string[] = [];
    const rows = [{ ...fixtureRow(EMAIL_STEP_ELEMENTS, 0), name: 'Search password documentation', control: attributes('search') }];
    const engine = await buildEngine('https://docs.example/password-help', rows, { title: 'Documentation', effects });
    await engine.snapshot({}); await engine.type({}, { ref: 'e1', text: 'password recovery documentation' });
    expect(pages.requests).toHaveLength(1); expect(effects).toEqual(['fill']);
  });
  test('unknown or absent purpose never reaches an interactive effect', async () => {
    const effects: string[] = [];
    const engine = await buildEngine(ORDINARY_URL, ORDINARY_ELEMENTS, { purpose: 'uncertain', effects }); await engine.snapshot({});
    await expect(engine.click({}, { ref: 'e1' })).rejects.toThrow(BrowserSessionError); expect(effects).toEqual([]);
    installJudgmentPort(undefined);
    await expect(engine.click({}, { ref: 'e1' })).rejects.toThrow(BrowserSessionError); expect(effects).toEqual([]);
  });
  test.each(['caller', 'source', 'title', 'snapshot', 'installation'])('%s retirement during a noncooperating page reading has no late effect', async kind => {
    const effects: string[] = [], options: PageFixtureOptions = { title: 'Dashboard', effects };
    const engine = await buildEngine(ORDINARY_URL, ORDINARY_ELEMENTS, options); await engine.snapshot({});
    const pending = gate(), controller = new AbortController(); let active = true;
    bindJudgmentPortAuthority(installed, () => ({ identity: {}, assertCurrent() { if (!active) throw new Error('retired native source'); } }));
    const result = engine.click({}, { ref: 'e1' }, { signal: controller.signal, assertCurrent: () => {} }); const handled = result.catch(error => error);
    try {
      await pending.started;
      if (kind === 'caller') controller.abort(new Error('private caller reason'));
      if (kind === 'source') active = false;
      if (kind === 'title') options.title = 'Authenticate now';
      if (kind === 'snapshot') await engine.snapshot({});
      if (kind === 'installation') installJudgmentPort(securityPort().port);
      pending.release(); expect(await handled).toBeInstanceOf(Error); expect(effects).toEqual([]);
    } finally { await pending.drain(); await handled; }
  });
  test.each(['label', 'title'])('live copied cardholder material in %s holds before any page wire', async field => {
    const guard = new CardMaterialRedactor(), effects: string[] = [];
    const options: PageFixtureOptions = { guard, effects, arm: (sessionId, pageId) => guard.arm(sessionId, pageId, [{ kind: 'cardholder', value: 'Native cardholder fixture' }]) };
    const rows = ORDINARY_ELEMENTS.map(element => ({ ...element }));
    const engine = await buildEngine(ORDINARY_URL, rows, options); await engine.snapshot({});
    if (field === 'label') rows[0] = { ...fixtureRow(rows, 0), name: 'Native cardholder fixture' };
    else options.title = 'Native cardholder fixture';
    await expect(engine.click({}, { ref: 'e1' })).rejects.toThrow(BrowserSessionError);
    expect(pages.requests).toHaveLength(0); expect(effects).toEqual([]);
  });
  test('armed checkout preserves unchanged local secret refs and ordinary submit without card values on the reader wire', async () => {
    const guard = new CardMaterialRedactor(), effects: string[] = [];
    const rows = [{ ...fixtureRow(EMAIL_STEP_ELEMENTS, 0), name: 'Payment field', control: attributes('text') }, { ...fixtureRow(ORDINARY_ELEMENTS, 0), name: 'Place order', submits: true }];
    const engine = await buildEngine('https://merchant.example/checkout', rows, { title: 'Review order', guard, effects,
      arm: (sessionId, pageId) => guard.arm(sessionId, pageId, [{ kind: 'number', value: '4242424242424242' }]) });
    await engine.snapshot({});
    expect(await engine.fillSecretBatch({}, { fills: [{ ref: 'e1', value: '4242424242424242' }] })).toMatchObject({ filled: ['e1'] });
    await engine.click({}, { ref: 'e2' });
    expect(effects).toEqual(['fill', 'click']); expect(pages.requests).toHaveLength(1);
    expect(JSON.stringify(pages.requests)).not.toContain('4242424242424242');
  });
  test('private metadata after the display limit is refused before any reader', async () => {
    const effects: string[] = [];
    const rows = Array.from({ length: 450 }, (_, index) => ({ ...fixtureRow(ORDINARY_ELEMENTS, 0), selector: `#control-${index}` }));
    const engine = await buildEngine(ORDINARY_URL, rows, { effects }); await engine.snapshot({});
    rows[449] = { ...fixtureRow(rows, 449), name: 'Authorization: Bearer private-native-fixture' };
    await expect(engine.click({}, { ref: 'e1' })).rejects.toThrow(BrowserSessionError);
    expect(pages.requests).toHaveLength(0); expect(effects).toEqual([]);
  });
});


describe('complete page evidence refusals', () => {
  test('a known sign-in route is usable when the exact complete page is ordinary documentation', async () => {
    const effects: string[] = [];
    const engine = await buildEngine('https://github.com/login/documentation', ORDINARY_ELEMENTS, { title: 'Documentation about authentication routes', effects });
    await engine.snapshot({}); await engine.click({}, { ref: 'e1' });
    expect(pages.requests).toHaveLength(1); expect(effects).toEqual(['click']);
  });
  test.each(['failure', 'malformed'])('%s page answer holds before the effect', async kind => {
    const effects: string[] = [], engine = await buildEngine(ORDINARY_URL, ORDINARY_ELEMENTS, { effects }); await engine.snapshot({});
    const original = installed;
    installJudgmentPort({ ...original, ask: request => {
      if (request.context?.battery !== browserCredentialPage.name) return original.ask(request);
      if (kind === 'failure') return Promise.reject(new Error('Private reader failure'));
      return fakePort(() => ({ type: 'noul', probability: NaN })).port.ask(request);
    } });
    await expect(engine.click({}, { ref: 'e1' })).rejects.toThrow(BrowserSessionError); expect(effects).toEqual([]);
  });
  test.each(['frames', 'evaluate'])('replacement %s accessor is never invoked by late page checks', async slot => {
    let selected: object | undefined, gets = 0;
    const effects: string[] = [], options: PageFixtureOptions = { effects, preparePage(page) {
      if (slot === 'frames') selected = page;
      else {
        const frames = Object.getOwnPropertyDescriptor(page, 'frames')?.value;
        if (typeof frames !== 'function') throw new Error('Missing native frame fixture');
        const vector: unknown = Reflect.apply(frames, page, []);
        if (!Array.isArray(vector) || !vector[0] || typeof vector[0] !== 'object') throw new Error('Missing native frame fixture');
        selected = vector[0];
      }
    } };
    const engine = await buildEngine(ORDINARY_URL, ORDINARY_ELEMENTS, options); await engine.snapshot({});
    const pending = gate(), result = engine.click({}, { ref: 'e1' }).catch(error => error);
    try {
      await pending.started;
      if (!selected) throw new Error('Missing retained owner');
      Object.defineProperty(selected, slot, { configurable: true, get() { gets++; throw new Error('Replacement accessor'); } });
      pending.release(); expect(await result).toBeInstanceOf(Error); expect(gets).toBe(0); expect(effects).toEqual([]);
    } finally { await pending.drain(); await result; }
  });
  test('a new unaddressable frame while the reader waits holds before the effect', async () => {
    let selected: object | undefined; const effects: string[] = [];
    const engine = await buildEngine(ORDINARY_URL, ORDINARY_ELEMENTS, { effects, preparePage: page => { selected = page; } });
    await engine.snapshot({});
    if (!selected) throw new Error('Missing native page fixture');
    const frames = Object.getOwnPropertyDescriptor(selected, 'frames')?.value;
    if (typeof frames !== 'function') throw new Error('Missing native frame fixture');
    const original: unknown = Reflect.apply(frames, selected, []);
    if (!Array.isArray(original)) throw new Error('Missing native frame vector');
    const vector = [...original];
    Object.defineProperty(selected, 'frames', { value: () => vector, configurable: true });
    const pending = gate(), result = engine.click({}, { ref: 'e1' }).catch(error => error);
    try {
      await pending.started;
      vector.push({ parentFrame: () => original[0], frameElement: async () => { throw new Error('Unaddressable frame'); }, evaluate: async () => { throw new Error('Unreadable frame'); } });
      pending.release(); expect(await result).toBeInstanceOf(Error); expect(effects).toEqual([]);
    } finally { await pending.drain(); await result; }
  });
  test.each(['hidden', 'accessor', 'proxy', 'entered-value', 'encoded-issuer'])('%s native metadata never reaches the page reader', async kind => {
    let selected: object | undefined, gets = 0; const effects: string[] = [];
    const engine = await buildEngine(ORDINARY_URL, ORDINARY_ELEMENTS, { effects, preparePage(page) {
      const frames = Object.getOwnPropertyDescriptor(page, 'frames')?.value;
      if (typeof frames !== 'function') throw new Error('Missing native frame fixture');
      const vector: unknown = Reflect.apply(frames, page, []);
      if (!Array.isArray(vector) || !vector[0] || typeof vector[0] !== 'object') throw new Error('Missing native frame fixture');
      selected = vector[0];
    } }); await engine.snapshot({});
    if (!selected) throw new Error('Missing native frame');
    const original = Object.getOwnPropertyDescriptor(selected, 'evaluate')?.value;
    if (typeof original !== 'function') throw new Error('Missing native collector');
    Object.defineProperty(selected, 'evaluate', { configurable: true, value: async (fn: unknown, arg: unknown) => {
      const value: unknown = await Reflect.apply(original, selected, [fn, arg]);
      if (!arg || typeof arg !== 'object' || !('identityOnly' in arg) || arg.identityOnly !== true) return value;
      if (!value || typeof value !== 'object') throw new Error('Missing native document');
      if (kind === 'hidden') Object.defineProperty(value, 'privateTail', { value: 'private fixture', enumerable: false });
      if (kind === 'accessor') Object.defineProperty(value, 'title', { enumerable: true, get() { gets++; return 'Private getter'; } });
      if (kind === 'proxy') return new Proxy(value, { ownKeys() { gets++; return []; } });
      if (kind === 'entered-value') {
        if (!('elements' in value) || !Array.isArray(value.elements) || !value.elements[0]) throw new Error('Missing native control');
        Object.assign(value.elements[0], { value: 'private entered fixture' });
      }
      if (kind === 'encoded-issuer') {
        const issuer = 'ghp_' + 'x'.repeat(36);
        const encoded = JSON.stringify(issuer).replace('ghp_', '\\u0067hp_');
        expect(encoded).not.toContain(issuer); Object.assign(value, { title: encoded });
      }
      return value;
    } });
    await expect(engine.click({}, { ref: 'e1' })).rejects.toThrow(BrowserSessionError);
    expect(pages.requests).toHaveLength(0); expect(effects).toEqual([]); expect(gets).toBe(0);
  });
});


function actualHostFrames(page: object) {
  const source = readFileSync(browserHostScriptPath(), 'utf8');
  const begin = source.indexOf('const state = '), end = source.indexOf('createInterface({ input: process.stdin })');
  if (begin < 0 || end <= begin) throw new Error('Missing native host handler source');
  const api: unknown = runInNewContext(source.slice(begin, end) + '\n({ state, handlers });');
  if (!api || typeof api !== 'object' || !('state' in api) || !api.state || typeof api.state !== 'object'
    || !('pages' in api.state) || !api.state.pages || typeof api.state.pages !== 'object'
    || !('set' in api.state.pages) || typeof api.state.pages.set !== 'function'
    || !('handlers' in api) || !api.handlers || typeof api.handlers !== 'object'
    || !('frames' in api.handlers) || typeof api.handlers.frames !== 'function') throw new Error('Missing actual native frame handler');
  Reflect.apply(api.state.pages.set, api.state.pages, ['native-page', page]);
  const frames = api.handlers.frames, handlers = api.handlers;
  return (complete: boolean) => Promise.resolve<unknown>(Reflect.apply(frames, handlers, [{ pageId: 'native-page', complete }]));
}
function hostFrameFixture(mode: 'ordinary' | 'unaddressable' | 'drift') {
  let vector: object[] = [];
  const main = { url: () => ORDINARY_URL, parentFrame: () => null };
  const child = { url: () => 'https://frame.example/embedded', parentFrame: () => main,
    frameElement: async () => {
      if (mode === 'unaddressable') throw new Error('Cannot address current frame');
      if (mode === 'drift') vector.push({ url: () => 'https://new-frame.example/', parentFrame: () => main });
      return { evaluate: async () => '#embedded-frame' };
    },
  };
  vector = [main, child];
  const page = { frames: () => [...vector], mainFrame: () => main, url: () => ORDINARY_URL };
  return { invoke: actualHostFrames(page) };
}

describe('native host complete frame boundary', () => {
  test('strict mode acquires every native frame and ordinary mode keeps its existing response', async () => {
    const native = hostFrameFixture('ordinary');
    const rows = [{ chain: [], url: ORDINARY_URL, main: true }, { chain: ['#embedded-frame'], url: 'https://frame.example/embedded', main: false }];
    expect<unknown>(await native.invoke(false)).toEqual({ frames: rows });
    expect<unknown>(await native.invoke(true)).toEqual({ frames: rows, url: ORDINARY_URL, complete: true });
  });
  test('strict mode refuses a frame that the ordinary host omitted', async () => {
    const native = hostFrameFixture('unaddressable');
    expect<unknown>(await native.invoke(false)).toEqual({ frames: [{ chain: [], url: ORDINARY_URL, main: true }] });
    await expect(native.invoke(true)).rejects.toThrow('Complete current browser frames');
  });
  test('frame attachment during strict host acquisition refuses publication', async () => {
    await expect(hostFrameFixture('drift').invoke(true)).rejects.toThrow('Browser frames changed');
  });
  test.each(['incomplete', 'duplicate', 'wrong-main', 'private-title'])('remote %s coverage cannot enter the page reader', async kind => {
    const client = new BrowserHostClient(); const effects: string[] = [];
    const main = { chain: [], url: ORDINARY_URL, main: true };
    const rows = ORDINARY_ELEMENTS.map(row => ({ ...row, value: null, documentUrl: ORDINARY_URL, control: attributes() }));
    const document = { url: ORDINARY_URL, title: 'Dashboard', elements: rows };
    const requests: { method: string; args: unknown }[] = [];
    Object.defineProperty(client, 'call', { value: async (method: string, args: unknown) => {
      requests.push({ method, args });
      if (method === 'frames') {
        if (kind === 'incomplete') return { frames: [main] };
        if (kind === 'duplicate') return { complete: true, url: ORDINARY_URL, frames: [main, main] };
        if (kind === 'wrong-main') return { complete: true, url: ORDINARY_URL, frames: [{ ...main, main: false }] };
        return { complete: true, url: ORDINARY_URL, frames: [main] };
      }
      if (method === 'evaluate') return { value: { ...document, title: 'Authorization: Bearer private-native-title' } };
      throw new Error('Unexpected native host fixture request');
    } });
    const remote = remotePage(client, 'native-page', ORDINARY_URL);
    let selectedPage: object | undefined;
    const engine = await buildEngine(ORDINARY_URL, ORDINARY_ELEMENTS, { effects, preparePage: page => { selectedPage = page; } });
    // Keep the original real engine ref source without using the host collector as a snapshot bypass.
    // The ref source is required before every action; malformed coverage must still win before purpose reading.
    await engine.snapshot({});
    if (!selectedPage) throw new Error('Missing retained fixture page');
    for (const key of ['url', 'frames', 'mainFrame', 'refreshFrames']) {
      const descriptor = Object.getOwnPropertyDescriptor(remote, key);
      if (!descriptor) throw new Error('Missing native remote page slot'); Object.defineProperty(selectedPage, key, descriptor);
    }
    await expect(engine.click({}, { ref: 'e1' })).rejects.toThrow(BrowserSessionError);
    expect(pages.requests).toHaveLength(0); expect(effects).toEqual([]);
    expect(requests.some(request => request.method === 'frames' && request.args && typeof request.args === 'object'
      && 'complete' in request.args && request.args.complete === true)).toBe(true);
  });
});


function pendingNativeAction() {
  let begin!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const signals: AbortSignal[] = [], owned: Promise<void>[] = [];
  const wait = (signal: AbortSignal | undefined): Promise<void> => {
    begin();
    if (!signal) return gate;
    signals.push(signal);
    const result = new Promise<void>((resolve, reject) => {
      const cancel = (): void => { reject(signal.reason); };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      void gate.then(() => {
        signal.removeEventListener('abort', cancel);
        try { signal.throwIfAborted(); resolve(); } catch (error) { reject(error); }
      });
    });
    owned.push(result); return result;
  };
  return { started, release, signals, wait, drain: async () => { release(); await Promise.allSettled(owned); } };
}

describe('native browser action cancellation', () => {
  test.each(['click', 'fill', 'press', 'select', 'pressSequentially'])('caller cancellation retires the pending %s without a later effect or sibling cancellation', async method => {
    const pending = pendingNativeAction(), controller = new AbortController(), effects: string[] = [], siblingEffects: string[] = [];
    const rows = [{ ...fixtureRow(ORDINARY_ELEMENTS, 0), tag: method === 'select' ? 'select' : method === 'fill' || method === 'pressSequentially' ? 'input' : 'button',
      role: method === 'select' ? 'combobox' : method === 'fill' || method === 'pressSequentially' ? 'textbox' : 'button', control: attributes() }];
    const engine = await buildEngine(ORDINARY_URL, rows, { effects, onAction: (operation, signal) => operation === method ? pending.wait(signal) : Promise.resolve() });
    const sibling = await buildEngine(ORDINARY_URL, ORDINARY_ELEMENTS, { effects: siblingEffects });
    await engine.snapshot({}); await sibling.snapshot({});
    const ownership = { signal: controller.signal, assertCurrent: () => {} };
    const result = method === 'fill' ? engine.type({}, { ref: 'e1', text: 'ordinary text' }, ownership)
      : method === 'pressSequentially' ? engine.type({}, { ref: 'e1', text: 'ordinary text', replace: false }, ownership)
      : method === 'press' ? engine.press({}, { ref: 'e1', key: 'Space' }, ownership)
      : method === 'select' ? engine.select({}, { ref: 'e1', values: ['ordinary'] }, ownership)
      : engine.click({}, { ref: 'e1' }, ownership);
    const handled = result.catch(error => error);
    try {
      await pending.started;
      controller.abort(new Error('private native caller cancellation'));
      expect(await handled).toBeInstanceOf(Error);
      expect(pending.signals).toHaveLength(1); expect(pending.signals[0]?.aborted).toBe(true);
      expect(String(pending.signals[0]?.reason)).not.toContain('private native caller cancellation');
      const allowedBeforeCancellation = method === 'pressSequentially' ? ['click'] : [];
      expect(effects).toEqual(allowedBeforeCancellation);
      pending.release(); await pending.drain();
      expect(effects).toEqual(allowedBeforeCancellation);
      await sibling.click({}, { ref: 'e1' }); expect(siblingEffects).toEqual(['click']);
    } finally { await pending.drain(); await handled; }
  });
});

function nativeHostProtocol(page: object, onResponse: (line: string) => void, loadModule?: (name: string) => unknown) {
  const source = readFileSync(browserHostScriptPath(), 'utf8');
  const begin = source.indexOf('const state = '), end = source.indexOf('createInterface({ input: process.stdin })');
  if (begin < 0 || end <= begin) throw new Error('Missing native host protocol');
  const api: unknown = runInNewContext(source.slice(begin, end) + '\n({ state, activeCalls, receiveMessage });', {
    AbortController, process: { stdout: { write: onResponse } }, require: loadModule,
  });
  if (!api || typeof api !== 'object' || !('state' in api) || !api.state || typeof api.state !== 'object'
    || !('pages' in api.state) || !api.state.pages || typeof api.state.pages !== 'object'
    || !('set' in api.state.pages) || typeof api.state.pages.set !== 'function'
    || !('activeCalls' in api) || !api.activeCalls || typeof api.activeCalls !== 'object'
    || !('size' in api.activeCalls) || typeof api.activeCalls.size !== 'number'
    || !('receiveMessage' in api) || typeof api.receiveMessage !== 'function') throw new Error('Missing native host operation ownership');
  Reflect.apply(api.state.pages.set, api.state.pages, ['native-page', page]);
  const receive = api.receiveMessage, active = api.activeCalls;
  return { receive: (message: unknown) => Reflect.apply(receive, undefined, [message]),
    active: () => { const size: unknown = Reflect.get(active, 'size'); if (typeof size !== 'number') throw new Error('Invalid native host owner count'); return size; } };
}

describe('host request cancellation ownership', () => {
  test.each(['click', 'fill', 'press', 'selectOption', 'pressSequentially'])('remote %s drains only the caller-owned pending native request', async method => {
    const first = pendingNativeAction(), second = pendingNativeAction(), effects: string[] = [], messages: unknown[] = [];
    const locatorFor = (selector: string) => {
      const pending = selector === '#first' ? first : second;
      const finish = async (operation: string, options: { readonly signal?: AbortSignal | undefined } = {}) => {
        if (method === 'pressSequentially' && operation === 'click') { effects.push(`${selector}:click`); return; }
        await pending.wait(options.signal); options.signal?.throwIfAborted(); effects.push(`${selector}:${operation}`);
      };
      const locator = { first: () => locator, nth: () => locator,
        click: (options: { readonly signal?: AbortSignal | undefined }) => finish('click', options),
        fill: (_text: string, options: { readonly signal?: AbortSignal | undefined }) => finish('fill', options),
        press: (_key: string, options: { readonly signal?: AbortSignal | undefined }) => finish('press', options),
        selectOption: async (_values: readonly string[], options: { readonly signal?: AbortSignal | undefined }) => { await finish('selectOption', options); return ['ordinary']; },
        pressSequentially: (_text: string, options: { readonly signal?: AbortSignal | undefined }) => finish('pressSequentially', options),
      }; return locator;
    };
    const client = new BrowserHostClient();
    const accept: unknown = Reflect.get(client, 'handleLine');
    if (typeof accept !== 'function') throw new Error('Missing actual native client response parser');
    const protocol = nativeHostProtocol({ locator: locatorFor }, line => { Reflect.apply(accept, client, [line.trim()]); });
    Object.defineProperty(client, 'child', { value: { stdin: { write: (line: string) => { const message: unknown = JSON.parse(line); messages.push(message); protocol.receive(message); return true; } } } });
    const page = remotePage(client, 'native-page', ORDINARY_URL), controller = new AbortController();
    const invoke = (selector: string, signal?: AbortSignal) => {
      const locator = page.locator(selector);
      return method === 'fill' ? locator.fill('ordinary', { signal })
        : method === 'press' ? locator.press('Space', { signal })
        : method === 'selectOption' ? locator.selectOption(['ordinary'], { signal })
        : method === 'pressSequentially' ? locator.pressSequentially('ordinary', { signal })
        : locator.click({ signal });
    };
    const result = invoke('#first', controller.signal), handled = result.catch(error => error);
    const sibling = invoke('#second'), siblingHandled = sibling.catch(error => error);
    try {
      await first.started; await second.started;
      expect(protocol.active()).toBe(2);
      controller.abort(new Error('private remote caller cancellation'));
      expect(await handled).toBeInstanceOf(Error); expect(protocol.active()).toBe(1);
      expect(first.signals[0]?.aborted).toBe(true); expect(second.signals[0]?.aborted).toBe(false);
      first.release(); await first.drain();
      expect(effects.filter(effect => effect.startsWith('#first:'))).toEqual(method === 'pressSequentially' ? ['#first:click'] : []);
      second.release(); await siblingHandled; expect(protocol.active()).toBe(0);
      expect(effects).toContain(`#second:${method}`);
      expect(JSON.stringify(messages)).not.toContain('private remote caller cancellation');
      expect(messages.filter(message => message && typeof message === 'object' && 'command' in message && message.command === 'cancel')).toHaveLength(1);
    } finally { await first.drain(); await second.drain(); await handled; await siblingHandled; }
  });
  test('cancellation before host dispatch prevents native locator construction', async () => {
    let constructions = 0, complete!: (line: string) => void;
    const response = new Promise<string>(resolve => { complete = resolve; });
    const protocol = nativeHostProtocol({ locator: () => { constructions++; throw new Error('Cancelled work reached the locator'); } }, complete);
    protocol.receive({ id: 1, command: 'locator', params: { pageId: 'native-page', selector: '#first', method: 'click', args: {} } });
    protocol.receive({ command: 'cancel', params: { id: 1 } });
    const result: unknown = JSON.parse(await response);
    expect(result).toMatchObject({ id: 1, ok: false }); expect(constructions).toBe(0); expect(protocol.active()).toBe(0);
  });
});


function clientHostFixture(client: BrowserHostClient, exitOnKill = true) {
  const messages: string[] = [], effects: string[] = [], child = new EventEmitter();
  const stdin = Object.assign(new EventEmitter(), { write: (line: string) => { messages.push(line); return true; }, end: () => { effects.push('stdin ended'); } });
  const stdout = new EventEmitter();
  Object.defineProperties(child, {
    exitCode: { value: null, writable: true }, signalCode: { value: null, writable: true },
    stdin: { value: stdin }, stdout: { value: stdout },
    kill: { value: () => { effects.push('host terminated'); if (exitOnKill) child.emit('exit', null, 'SIGTERM'); return true; } },
  });
  Object.defineProperty(client, 'child', { value: child, writable: true, configurable: true });
  const observe: unknown = Reflect.get(client, 'observeHostLifetime');
  if (typeof observe !== 'function') throw new Error('Missing actual native client host lifetime');
  Reflect.apply(observe, client, [child]);
  return { child, stdin, stdout, messages, effects };
}
function clientPendingCount(client: BrowserHostClient): number {
  const pending: unknown = Reflect.get(client, 'pending');
  if (!pending || typeof pending !== 'object') throw new Error('Missing actual client request owners');
  const count: unknown = Reflect.get(pending, 'size');
  if (typeof count !== 'number') throw new Error('Invalid actual client request owners'); return count;
}

describe('native host response retirement', () => {
  test.each(['exit', 'error', 'stdin-error', 'stdout-error', 'stop'])('host %s settles its pending action response and removes the caller listener', async mode => {
    const client = new BrowserHostClient(), host = clientHostFixture(client), controller = new AbortController();
    const result = client.call('locator', { pageId: 'native-page', method: 'click', selector: '#first', args: {} }, { signal: controller.signal });
    const handled = result.catch(error => error);
    expect(clientPendingCount(client)).toBe(1);
    if (mode === 'stop') client.stop();
    else if (mode === 'error') host.child.emit('error', new Error('private host transport error'));
    else if (mode === 'stdin-error') host.stdin.emit('error', new Error('private host transport error'));
    else if (mode === 'stdout-error') host.stdout.emit('error', new Error('private host transport error'));
    else host.child.emit('exit', 1, null);
    const refusal: unknown = await handled;
    expect(refusal).toBeInstanceOf(Error);
    if (!(refusal instanceof Error)) throw new Error('Expected native host refusal');
    expect(refusal.message).not.toContain('private host transport error'); expect(clientPendingCount(client)).toBe(0);
    const sent = host.messages.length;
    controller.abort(new Error('private caller after retired host'));
    expect(host.messages).toHaveLength(sent);
    if (mode === 'stop') expect(host.effects).toEqual(['stdin ended', 'host terminated']);
  });
  test('late old-host retirement preserves a replacement host and its own pending response', async () => {
    const client = new BrowserHostClient(), first = clientHostFixture(client);
    const old = client.call('pages'), oldHandled = old.catch(error => error);
    const second = clientHostFixture(client), current = client.call('pages'), currentHandled = current.catch(error => error);
    expect(clientPendingCount(client)).toBe(2); first.child.emit('exit', 1, null);
    expect(await oldHandled).toBeInstanceOf(Error); expect(clientPendingCount(client)).toBe(1);
    const request: unknown = JSON.parse(second.messages[0] ?? 'null');
    if (!request || typeof request !== 'object' || !('id' in request) || typeof request.id !== 'number') throw new Error('Missing actual current request');
    const receive: unknown = Reflect.get(client, 'handleLine');
    if (typeof receive !== 'function') throw new Error('Missing actual native client response parser');
    Reflect.apply(receive, client, [JSON.stringify({ id: request.id, ok: true, result: { pages: ['old-host'] } }), first.child]);
    expect(clientPendingCount(client)).toBe(1);
    Reflect.apply(receive, client, [JSON.stringify({ id: request.id, ok: true, result: { pages: [] } }), second.child]);
    expect<unknown>(await currentHandled).toEqual({ pages: [] }); expect(clientPendingCount(client)).toBe(0);
    client.stop(); expect(second.effects).toEqual(['stdin ended', 'host terminated']); expect(first.effects).toEqual([]);
  });
});


describe('supported native action driver', () => {
  test.each(['1.50.0', '2.0.0', null])('unsupported or unknown driver %s refuses before native connection construction', async version => {
    let nativeConnections = 0, probes = 0;
    const manager = new BrowserSessionManager({
      profileRoot: join(tmpdir(), 'goodvibes-driver-guard-profiles'), surfaceRoot: 'test-surface',
      io: { ...readyIo(), resolveDriver: () => ({ ...readyIo().resolveDriver(), version }) },
      loadDriver: () => ({ chromium: {
        launchPersistentContext: async () => { nativeConnections++; throw new Error('Unsupported driver constructed a browser'); },
        connectOverCDP: async () => { nativeConnections++; throw new Error('Unsupported driver constructed a connection'); },
      } }),
      probeEndpoint: async () => { probes++; return null; },
    });
    await expect(manager.attach({ cdpEndpoint: 'http://127.0.0.1:9222' })).rejects.toThrow('does not support the action cancellation');
    expect(nativeConnections).toBe(0); expect(probes).toBe(0); expect(manager.list()).toEqual([]);
    await manager.shutdown();
  });
  test.each(['1.50.0', '2.0.0', null, DRIVER_VERSION])('actual host validates its independently loaded driver %s before connecting', async version => {
    let complete!: (line: string) => void, nativeConnections = 0, moduleLoads = 0;
    const response = new Promise<string>(resolve => { complete = resolve; });
    const protocol = nativeHostProtocol({ url: () => ORDINARY_URL, title: async () => 'Ordinary native host page' }, complete, name => {
      if (name === 'playwright-core/package.json') return { version };
      if (name !== 'playwright-core') throw new Error('Unexpected native driver module');
      moduleLoads++;
      return { chromium: { connectOverCDP: async () => {
        nativeConnections++; return { contexts: () => [{ pages: () => [], on: () => {} }] };
      } } };
    });
    protocol.receive({ id: 1, command: 'attach', params: { endpoint: 'http://127.0.0.1:9222' } });
    const result: unknown = JSON.parse(await response);
    expect<unknown>(result).toMatchObject({ id: 1, ok: version === DRIVER_VERSION });
    expect(nativeConnections).toBe(version === DRIVER_VERSION ? 1 : 0);
    expect(moduleLoads).toBe(version === DRIVER_VERSION ? 1 : 0); expect(protocol.active()).toBe(0);
  });
});

describe('Google selected controls retain native action lifetime', () => {
  for (const method of ['click', 'type'] as const) for (const retirement of ['caller', 'reader'] as const)
    test(`${method} keeps the actual caller and reader signal through selection and native dispatch on ${retirement} retirement`, async () => {
      const pending = pendingNativeAction(), controller = new AbortController(), effects: string[] = [];
      const rows = [{ ...fixtureRow(ORDINARY_ELEMENTS, 0), tag: method === 'type' ? 'input' : 'button',
        role: method === 'type' ? 'textbox' : 'button', name: method === 'type' ? 'Display name' : 'Refresh', control: attributes() }];
      const engine = await buildEngine(ORDINARY_URL, rows, { effects,
        preparePage: page => { Object.defineProperty(page, 'evaluate', { value: async () => 'Ordinary form' }); },
        onAction: (operation, signal) => operation === (method === 'type' ? 'fill' : 'click') ? pending.wait(signal) : Promise.resolve() });
      const selection = fakePort((name, question) => name === 'pick' ? choiceAnswer(question, 'control_0', 0.99)
        : name === 'fits_0' ? noulAnswer(0.99) : (() => { throw new Error('Unprovided exact Google control reading'); })());
      const base = installed;
      installJudgmentPort({ ...base, ask: request => request.context?.battery === googleSetupControl.name ? selection.port.ask(request) : base.ask(request) });
      const browser = ownGoogleBrowser(createGoogleBrowserPort(engine), { signal: controller.signal }).browser;
      const elements = await browser.snapshot();
      const chosen = await findElement(elements, { purpose: method === 'type' ? 'Enter the ordinary form name' : 'Refresh the current ordinary view' }, { browser, signal: controller.signal });
      if (!chosen) throw new Error('Exact authored Google control was not selected');
      const result = consumeGoogleElement(browser, chosen, method === 'type' ? 'ordinary text' : undefined);
      const handled = result.catch(error => error);
      try {
        await pending.started; expect(pending.signals).toHaveLength(1); expect(pending.signals[0]?.aborted).toBe(false);
        if (retirement === 'caller') controller.abort(new Error('private Google caller reason'));
        else installJudgmentPort(base);
        expect(await handled).toBeInstanceOf(Error); expect(pending.signals[0]?.aborted).toBe(true);
        pending.release(); await pending.drain(); expect(effects).toEqual([]);
        expect(JSON.stringify(selection.requests)).not.toContain('private Google caller reason');
      } finally { await pending.drain(); await handled; }
    });
});


for (const retirement of ['stop', 'error', 'stdin-error'] as const)
  test(`host ${retirement} retires its slot but drains the pending action only after actual delayed exit`, async () => {
    const client = new BrowserHostClient(), first = clientHostFixture(client, false), controller = new AbortController();
    let finished = false;
    const result = client.call('locator', { pageId: 'native-page', method: 'click', selector: '#first', args: {} }, { signal: controller.signal });
    const handled = result.then(value => { finished = true; return value; }, error => { finished = true; return error; });
    try {
      if (retirement === 'stop') client.stop();
      else if (retirement === 'error') first.child.emit('error', new Error('private delayed host failure'));
      else first.stdin.emit('error', new Error('private delayed stream failure'));
      expect(first.effects).toContain('host terminated'); expect(clientPendingCount(client)).toBe(1);
      await Promise.resolve(); expect(finished).toBe(false);
      const second = clientHostFixture(client), sibling = client.call('pages'), siblingHandled = sibling.catch(error => error);
      try {
        first.child.emit('exit', 1, null); expect(await handled).toBeInstanceOf(Error);
        expect(clientPendingCount(client)).toBe(1);
        const request: unknown = JSON.parse(second.messages[0] ?? 'null');
        if (!request || typeof request !== 'object' || !('id' in request) || typeof request.id !== 'number') throw new Error('Missing replacement native request');
        const receive: unknown = Reflect.get(client, 'handleLine');
        if (typeof receive !== 'function') throw new Error('Missing actual response parser');
        Reflect.apply(receive, client, [JSON.stringify({ id: request.id, ok: true, result: { pages: [] } }), second.child]);
        expect<unknown>(await siblingHandled).toEqual({ pages: [] }); expect(clientPendingCount(client)).toBe(0);
      } finally { client.stop(); await siblingHandled; }
    } finally { first.child.emit('exit', 1, null); controller.abort(); await handled; }
  });

for (const retirement of ['caller', 'reader'] as const)
  test(`armed secret batch drains its pending native fill on ${retirement} retirement without typing a later field`, async () => {
    const pending = pendingNativeAction(), controller = new AbortController(), guard = new CardMaterialRedactor(), effects: string[] = [];
    const rows = [
      { ...fixtureRow(EMAIL_STEP_ELEMENTS, 0), name: 'Payment field', control: attributes('text') },
      { ...fixtureRow(EMAIL_STEP_ELEMENTS, 0), selector: '#later-card-field', name: 'Second payment field', control: attributes('text') },
    ];
    const engine = await buildEngine('https://merchant.example/checkout', rows, { guard, effects,
      onAction: (operation, signal) => operation === 'fill' ? pending.wait(signal) : Promise.resolve(),
      arm: (sessionId, pageId) => guard.arm(sessionId, pageId, [{ kind: 'number', value: '4242424242424242' }]),
    });
    await engine.snapshot({});
    const result = engine.fillSecretBatch({}, { fills: [{ ref: 'e1', value: '4242424242424242' }, { ref: 'e2', value: '4242424242424242' }] }, { signal: controller.signal });
    const handled = result.catch(error => error);
    try {
      await pending.started; expect(pending.signals).toHaveLength(1);
      if (retirement === 'caller') controller.abort(new Error('private secret-batch cancellation'));
      else installJudgmentPort({ ...installed });
      const outcome: unknown = await handled;
      expect<unknown>(outcome).toMatchObject({ filled: [], failedRef: 'e1' }); expect(pending.signals[0]?.aborted).toBe(true);
      pending.release(); await pending.drain(); expect(effects).toEqual([]); expect(pending.signals).toHaveLength(1);
      expect(JSON.stringify(outcome)).not.toContain('4242424242424242'); expect(JSON.stringify(pages.requests)).not.toContain('4242424242424242');
    } finally { controller.abort(); await pending.drain(); await handled; }
  });
