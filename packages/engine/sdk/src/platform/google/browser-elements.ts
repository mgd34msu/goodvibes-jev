/** Purpose-grounded Google setup controls. Readings are observations, not action authorization. */

import type { GoogleBrowserElement, GoogleBrowserPort } from './types.js';
import { googleSetupControl, googleSignInPage, googleTwoStepPage, googleAppPasswordPage, googleControlSnapshot, admitGoogleControlMetadata, googleReadingOwner, GoogleReadingError, type GoogleReadingOptions } from './browser-readings.js';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';

export interface GoogleElementQuery {
  /** The action or observation this control must serve, not a substring filter. */
  readonly purpose?: string;
  readonly role?: string;
  readonly nameIncludes?: string;
  readonly namePattern?: RegExp;
  readonly tag?: string;
}

interface SelectionLease {
  readonly browser: GoogleBrowserPort | undefined;
  readonly snapshot: string;
  readonly url: string | undefined;
  readonly assertCurrent: () => void;
  readonly assertOwner: () => void;
  readonly signal: AbortSignal | undefined;
}
const selected = new WeakMap<GoogleBrowserElement, SelectionLease>();

/** Fence attempts and reading/action attachments to the same offered page. */
function fencedPort(base: JudgmentPort, current: () => void, currentPage: () => Promise<void>): JudgmentPort {
  return { ...base,
    ...(base.recorder ? { recorder: {
      recordReadings(id, readings) { current(); base.recorder!.recordReadings(id, readings); current(); },
      recordAction(id, action) { current(); base.recorder!.recordAction(id, action); current(); },
    } satisfies NonNullable<JudgmentPort['recorder']> } : {}),
    async ask(request) {
      await currentPage(); current();
      const result = await base.ask({ ...request,
        beforeAttempt: () => { current(); request.beforeAttempt?.(); current(); },
        beforeAsyncAttempt: async () => { await currentPage(); await request.beforeAsyncAttempt?.(); current(); },
        assertLogCurrent: () => { current(); request.assertLogCurrent?.(); current(); },
      });
      await currentPage(); current(); return result;
    },
  };
}

/** All structurally eligible candidates participate; no first-match fallback. */
export async function findElement(
  elements: readonly GoogleBrowserElement[],
  query: GoogleElementQuery,
  options: GoogleReadingOptions = {},
): Promise<GoogleBrowserElement | null> {
  try {
    const browser = options.browser;
    const snapshot = googleControlSnapshot(elements);
    const describe = () => {
      const descriptors = Object.getOwnPropertyDescriptors(query);
      if (Object.values(descriptors).some(d => !('value' in d))) throw new GoogleReadingError();
      return snapshotJudgmentInput({ purpose: query.purpose, nameIncludes: query.nameIncludes,
        role: query.role, tag: query.tag, pattern: query.namePattern?.source, flags: query.namePattern?.flags });
    };
    const request = describe();
    const requestKey = JSON.stringify(request);
    const context = snapshotJudgmentInput({ ...request as object,
      purpose: query.purpose ?? query.nameIncludes ?? 'Select the control matching the supplied structural constraints' });
    const candidates = snapshot.filter(element => element.disabled !== true && (!query.role || element.role.toLowerCase() === query.role.toLowerCase())
      && (!query.tag || element.tag.toLowerCase() === query.tag.toLowerCase())
      && (!query.namePattern || new RegExp(query.namePattern.source, query.namePattern.flags.replace(/[gy]/g, '')).test(element.name)));
    const owner = googleReadingOwner('google.setup.control', options);
    const pageOwner = browser?.captureAuthority?.();
    const url = browser ? await browser.currentUrl() : undefined;
    owner.assertCurrent();
    pageOwner?.assertCurrent();
    snapshotJudgmentInput({ url });
    const before = JSON.stringify(snapshot);
    const current = () => { owner.assertCurrent(); pageOwner?.assertCurrent(); if (JSON.stringify(describe()) !== requestKey || JSON.stringify(googleControlSnapshot(elements)) !== before) throw new GoogleReadingError(); };
    current();
    const currentPage = async () => {
      current();
      if (browser) {
        const freshUrl = await browser.currentUrl(); current();
        const fresh = await (browser.verifySnapshot?.() ?? browser.snapshot()); current();
        if (url !== freshUrl || JSON.stringify(googleControlSnapshot(fresh)) !== before) throw new GoogleReadingError();
      }
      current();
    };
    if (!candidates.length) { await currentPage(); return null; }
    const port = fencedPort(owner.port, current, currentPage);
    const reading = await googleSetupControl.select(port, context as never,
      candidates.map((element, index) => ({ id: `control_${index}`, content: { role: element.role, name: element.name, tag: element.tag } })),
      { site: 'google.setup.control', signal: owner.signal });
    current();
    await currentPage();
    if (reading.outcome !== 'act') throw new GoogleReadingError();
    if (reading.chosen === undefined) { reading.recordAction('no suitable Google setup control'); return null; }
    const index = candidates.findIndex((_, index) => `control_${index}` === reading.chosen);
    if (index < 0) throw new GoogleReadingError();
    const element = Object.freeze({ ...candidates[index]! });
    reading.recordAction('selected an offered Google setup control');
    current();
    selected.set(element, { browser, snapshot: before, url, assertCurrent: current, assertOwner: owner.assertCurrent, signal: owner.signal });
    return element;
  } catch { throw new GoogleReadingError(); }
}

/** Revalidate the full snapshot and original owner at the actual effect boundary. */
export async function consumeGoogleElement(browser: GoogleBrowserPort, element: GoogleBrowserElement, text?: string): Promise<void> {
  const lease = selected.get(element);
  if (!lease || lease.browser !== browser) throw new GoogleReadingError();
  lease.assertCurrent();
  const url = await browser.currentUrl();
  lease.assertCurrent();
  if (url !== lease.url) throw new GoogleReadingError();
  const snapshot = await (browser.verifySnapshot?.() ?? browser.snapshot());
  lease.assertCurrent();
  if (JSON.stringify(googleControlSnapshot(snapshot)) !== lease.snapshot) throw new GoogleReadingError();
  lease.assertCurrent();
  selected.delete(element);
  if (text === undefined) await browser.click(element.ref, { signal: lease.signal, assertCurrent: lease.assertCurrent });
  else await browser.type(element.ref, text, { signal: lease.signal, assertCurrent: lease.assertCurrent });
  lease.assertOwner();
}

/** Describes what a query was looking for, in plain language. */
function describeQuery(query: GoogleElementQuery): string {
  const parts: string[] = [];
  if (query.role) parts.push(`role "${query.role}"`);
  if (query.tag) parts.push(`tag "${query.tag}"`);
  if (query.purpose) parts.push(`purpose "${query.purpose}"`);
  if (query.nameIncludes) parts.push(`a name containing "${query.nameIncludes}"`);
  if (query.namePattern) parts.push(`a name matching ${query.namePattern.toString()}`);
  return parts.length > 0 ? `an element with ${parts.join(' and ')}` : 'an element matching an empty query';
}

const DEFAULT_CANDIDATE_LIMIT = 10;

/** A short, human-readable listing of elements actually present, for diagnostics. */
export function describeElements(
  elements: readonly GoogleBrowserElement[],
  limit: number = DEFAULT_CANDIDATE_LIMIT,
): string {
  if (elements.length === 0) return 'no interactive elements were found in the snapshot';
  let safe: readonly GoogleBrowserElement[];
  try { safe = googleControlSnapshot(elements); } catch { return 'controls whose labels cannot safely be displayed'; }
  const sample = safe.slice(0, limit);
  const described = sample.map((element) => `${element.role} "${element.name}"`).join(', ');
  const remaining = elements.length - sample.length;
  return remaining > 0 ? `${described}, and ${String(remaining)} more` : described;
}

export interface GoogleElementFound {
  readonly found: true;
  readonly element: GoogleBrowserElement;
}

export interface GoogleElementNotFound {
  readonly found: false;
  readonly query: GoogleElementQuery;
  readonly candidateCount: number;
  /** Plain-language failure statement: what was looked for, what was there instead. */
  readonly message: string;
}

export type GoogleElementLookup = GoogleElementFound | GoogleElementNotFound;

/**
 * Like `findElement`, but the miss carries a typed, descriptive result instead
 * of `null`, the failure mode this module exists to make impossible to get
 * wrong silently.
 */
export async function requireElement(
  elements: readonly GoogleBrowserElement[],
  query: GoogleElementQuery,
  options: GoogleReadingOptions = {},
): Promise<GoogleElementLookup> {
  const element = await findElement(elements, query, options);
  if (element) return { found: true, element };
  const message = `Looked for ${describeQuery(query)}, but the page showed ${String(elements.length)} control${
    elements.length === 1 ? '' : 's'
  } instead: ${describeElements(elements)}.`;
  return { found: false, query, candidateCount: elements.length, message };
}

/** A settled typed page reading. Unknown/unavailable is never "signed in". */
export async function looksLikeGoogleSignIn(url: string, elements: readonly GoogleBrowserElement[], options: GoogleReadingOptions = {}): Promise<boolean> {
  try {
    const browser = options.browser;
    const snapshot = googleControlSnapshot(elements);
    const state = snapshotJudgmentInput({ url, elements: snapshot });
    const owner = googleReadingOwner('google.setup.sign-in-page', options);
    const pageOwner = browser?.captureAuthority?.();
    const before = JSON.stringify(snapshot);
    const current = () => {
      owner.assertCurrent(); pageOwner?.assertCurrent();
      if (JSON.stringify(googleControlSnapshot(elements)) !== before) throw new GoogleReadingError();
    };
    const currentPage = async () => {
      current();
      if (browser) {
        const currentUrl = await browser.currentUrl(); current();
        const currentElements = await (browser.verifySnapshot?.() ?? browser.snapshot()); current();
        if (currentUrl !== url || JSON.stringify(googleControlSnapshot(currentElements)) !== before) throw new GoogleReadingError();
      }
      current();
    };
    const run = await googleSignInPage.run(fencedPort(owner.port, current, currentPage), state as never, { site: 'google.setup.sign-in-page', signal: owner.signal });
    await currentPage();
    const reading = run.readings.signIn;
    if (reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new GoogleReadingError();
    run.recordAction('returned settled Google sign-in page state');
    current();
    return reading.verdict === 'yes';
  } catch { throw new GoogleReadingError(); }
}

/** Capture and fence the complete setup page before interpreting its state. */
async function observeGooglePage(browser: GoogleBrowserPort, site: string, options: GoogleReadingOptions) {
  const owner = googleReadingOwner(site, options);
  const pageOwner = browser.captureAuthority?.();
  const current = () => { owner.assertCurrent(); pageOwner?.assertCurrent(); };
  current();
  const url = await browser.currentUrl(); current();
  const elements = googleControlSnapshot(await browser.snapshot()); current();
  const text = await browser.readText(); current();
  admitGoogleControlMetadata({ url, text });
  const state = snapshotJudgmentInput({ url, elements, text });
  if (text.length > 160_000) throw new GoogleReadingError();
  const before = JSON.stringify(elements);
  const currentPage = async () => {
    current();
    const freshUrl = await browser.currentUrl(); current();
    const fresh = googleControlSnapshot(await (browser.verifySnapshot?.() ?? browser.snapshot())); current();
    const freshText = await browser.readText(); current();
    if (freshUrl !== url || JSON.stringify(fresh) !== before || freshText !== text) throw new GoogleReadingError();
  };
  return { state, current, currentPage, port: fencedPort(owner.port, current, currentPage), signal: owner.signal };
}

/** Read the observed setting without changing it. */
export async function readGoogleTwoStepState(browser: GoogleBrowserPort, options: GoogleReadingOptions = {}): Promise<'on' | 'off' | 'unknown'> {
  try {
    const page = await observeGooglePage(browser, googleTwoStepPage.name, options);
    const run = await googleTwoStepPage.run(page.port, page.state as never, { site: googleTwoStepPage.name, signal: page.signal });
    await page.currentPage();
    const { enabled, disabled } = run.readings;
    const on = enabled.verdict === 'yes' && enabled.outcome === 'act';
    const off = disabled.verdict === 'yes' && disabled.outcome === 'act';
    const setting = on === off ? 'unknown' : on ? 'on' : 'off';
    run.recordAction('Report the observed 2-Step Verification setting; no account setting was changed.');
    page.current();
    return setting;
  } catch { return 'unknown'; }
}

export async function readGoogleAppPasswordState(browser: GoogleBrowserPort, label: string, options: GoogleReadingOptions = {}) {
  const labelState = snapshotJudgmentInput({ label });
  const page = await observeGooglePage(browser, googleAppPasswordPage.name, options);
  const run = await googleAppPasswordPage.run(page.port, { ...(page.state as object), ...(labelState as object) },
    { site: googleAppPasswordPage.name, signal: page.signal });
  await page.currentPage();
  const { twoStepRequired, labelExists } = run.readings;
  if ([twoStepRequired, labelExists].some(reading => reading.outcome !== 'act' || reading.verdict === 'uncertain')) throw new GoogleReadingError();
  run.recordAction('Observe app-password prerequisites and label presence; browser writes require separate control selection.');
  page.current();
  return { twoStepRequired: twoStepRequired.verdict === 'yes', labelExists: labelExists.verdict === 'yes' };
}

/** Best-effort DOM tag guessed from an accessible role. */
const ROLE_TAG_HINTS: Readonly<Record<string, string>> = {
  button: 'button',
  link: 'a',
  textbox: 'input',
  searchbox: 'input',
  combobox: 'select',
  checkbox: 'input',
  radio: 'input',
  switch: 'input',
  option: 'option',
  heading: 'h2',
  label: 'label',
  tab: 'div',
  menuitem: 'div',
};

/**
 * The shared role-to-tag guess.
 *
 * Exported because every `GoogleBrowserPort` implementation faces the same
 * problem, an accessibility snapshot reports a role, not a tag, and the
 * guess should be one shared answer rather than re-invented per surface.
 * Returns `'div'` for any role with no better guess.
 */
export function deriveTagFromRole(role: string): string {
  return ROLE_TAG_HINTS[role.toLowerCase()] ?? 'div';
}
