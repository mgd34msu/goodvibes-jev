import { liveControlDescriptor } from './_helpers/browser-control-descriptor.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isDeepStrictEqual } from 'node:util';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { readingsOf, SqliteDecisionLog, toJson, withDecisionLog } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { browserControlIdentity } from '../sdk/src/platform/browser/browser-control-identity.js';
import { resolveRef, SnapshotStore, StaleElementError } from '../sdk/src/platform/browser/browser-snapshot.js';
import type { BrowserSnapshot } from '../sdk/src/platform/browser/browser-types.js';

/**
 * `playwright-core` is only hoisted under packages/sdk/node_modules, not the
 * repo root, so test/ (which sits at the root) cannot resolve it directly.
 * Derive the Page/Locator shapes from resolveRef's own signature instead of
 * importing the module a second time from a location that can't see it.
 */
type Page = Parameters<typeof resolveRef>[0];
type Locator = Awaited<ReturnType<typeof resolveRef>>['locator'];


const changedControlEvidence = toJson({
  recorded: { ref: 'e1', tag: 'button', role: 'button', name: 'Send it',
    selector: 'html > body button', frameChain: [], submits: true },
  current: liveControlDescriptor({ tag: 'button', name: 'Delete everything', submits: true }, 'https://example.com/'),
});
let previous: ReturnType<typeof installJudgmentPort>;
let decisionLog: SqliteDecisionLog;
let judgments: ReturnType<typeof fakePort>;
beforeEach(() => {
  decisionLog = new SqliteDecisionLog(':memory:');
  judgments = fakePort((name, question, state) => {
    if (name !== 'sameControl'
      || !isDeepStrictEqual(question, toJson(browserControlIdentity.items.sameControl.question))
      || !isDeepStrictEqual(state, changedControlEvidence)) {
      throw new Error('Unscripted browser snapshot fixture reading.');
    }
    return noulAnswer(0.01);
  });
  previous = installJudgmentPort(withDecisionLog(judgments.port, decisionLog));
});
afterEach(() => {
  installJudgmentPort(previous);
  decisionLog[Symbol.dispose]();
});

function snapshotWith(url: string): BrowserSnapshot {
  return {
    sessionId: 'b1',
    pageId: 'b1p1',
    url,
    title: 'Test',
    snapshotId: 's1',
    elements: [
      { ref: 'e1', role: 'button', name: 'Send it', tag: 'button', selector: 'html > body button', depth: 3, submits: true, frameChain: [] },
    ],
    truncated: false,
  };
}

function fakePage(options: {
  readonly url: string;
  readonly count: number;
  readonly actual?: { readonly tag: string; readonly name: string };
}): Page {
  const locator = {
    evaluate: async () => liveControlDescriptor({ ...(options.actual ?? { tag: 'button', name: 'Send it' }), submits: true }, options.url),
    first: () => locator,
  } as unknown as Locator;
  return {
    url: () => options.url,
    locator: () => ({ ...locator, count: async () => options.count, first: () => locator }),
  } as unknown as Page;
}

describe('element refs', () => {
  test('a ref resolves when the element is still the one the snapshot recorded', async () => {
    const page = fakePage({ url: 'https://example.com/', count: 1 });
    const resolved = await resolveRef(page, snapshotWith('https://example.com/'), 'e1');
    expect(resolved.element.name).toBe('Send it');
    expect(judgments.requests).toHaveLength(0);
    expect(decisionLog.query()).toEqual([]);
  });

  test('acting without a snapshot is refused rather than guessed', async () => {
    const page = fakePage({ url: 'https://example.com/', count: 1 });
    await expect(resolveRef(page, null, 'e1')).rejects.toThrow(StaleElementError);
    expect(judgments.requests).toHaveLength(0);
  });

  test('a ref that is not in the snapshot is refused', async () => {
    const page = fakePage({ url: 'https://example.com/', count: 1 });
    await expect(resolveRef(page, snapshotWith('https://example.com/'), 'e99')).rejects.toThrow(/not in the current snapshot/);
    expect(judgments.requests).toHaveLength(0);
  });

  test('a ref is refused once the page has navigated away from the snapshot', async () => {
    const page = fakePage({ url: 'https://example.com/other', count: 1 });
    await expect(resolveRef(page, snapshotWith('https://example.com/'), 'e1')).rejects.toThrow(/moved from/);
    expect(judgments.requests).toHaveLength(0);
  });

  test('a ref whose element has disappeared is refused', async () => {
    const page = fakePage({ url: 'https://example.com/', count: 0 });
    await expect(resolveRef(page, snapshotWith('https://example.com/'), 'e1')).rejects.toThrow(/no longer present/);
    expect(judgments.requests).toHaveLength(0);
  });

  test('a ref that now points at a different element is refused instead of clicked', async () => {
    const page = fakePage({
      url: 'https://example.com/',
      count: 1,
      actual: { tag: 'button', name: 'Delete everything' },
    });
    await expect(resolveRef(page, snapshotWith('https://example.com/'), 'e1'))
      .rejects.toThrow(/points at a different element/);
    expect(judgments.requests).toHaveLength(1);
    expect(judgments.requests[0]?.state).toEqual(changedControlEvidence);
    const [entry] = decisionLog.query({ status: 'answered' });
    expect(decisionLog.query()).toHaveLength(1);
    expect(entry).toMatchObject({ context: { battery: browserControlIdentity.name,
      batteryVersion: browserControlIdentity.version, pattern: 'battery' }, status: 'answered' });
    if (!entry) throw new Error('Expected the owned browser identity reading.');
    expect(readingsOf(entry)).toMatchObject({ sameControl: { outcome: 'act', verdict: 'no' } });
  });

  test('every refusal tells the caller how to recover', async () => {
    const page = fakePage({ url: 'https://example.com/', count: 0 });
    try {
      await resolveRef(page, snapshotWith('https://example.com/'), 'e1');
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as StaleElementError).fix).toContain('snapshot');
      expect(judgments.requests).toHaveLength(0);
    }
  });
});

describe('snapshot store', () => {
  test('snapshots are kept per page and cleared independently', () => {
    const store = new SnapshotStore();
    store.set(snapshotWith('https://example.com/'));
    expect(store.get('b1', 'b1p1')?.url).toBe('https://example.com/');
    expect(store.get('b1', 'b1p2')).toBeNull();
    store.clear('b1', 'b1p1');
    expect(store.get('b1', 'b1p1')).toBeNull();
  });
});
