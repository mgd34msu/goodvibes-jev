import { liveControlDescriptor } from './_helpers/browser-control-descriptor.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { bindJudgmentPortAuthority, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { BrowserEngine } from '../sdk/src/platform/browser/browser-engine.js';
import { BrowserControlIdentityWork } from '../sdk/src/platform/browser/browser-control-identity.js';
import { resolveRef } from '../sdk/src/platform/browser/browser-snapshot.js';
import type { BrowserSnapshot, CardFieldGuard } from '../sdk/src/platform/browser/browser-types.js';
import type { BrowserSessionManager } from '../sdk/src/platform/browser/browser-sessions.js';

type Page = Parameters<typeof resolveRef>[0];
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
function reading(probability = 0.99) {
  const fixture = fakePort(() => noulAnswer(probability)); installJudgmentPort(fixture.port); return fixture;
}
function deferred() {
  let release!: () => void, began!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  const fixture = fakePort(() => noulAnswer(0.99));
  const port: JudgmentPort = { ...fixture.port, async ask(request) { began(); await gate; return fixture.port.ask(request); } };
  installJudgmentPort(port); return { ...fixture, port, release, started };
}
function fixture(recordedName = 'Send message') {
  let url = 'https://example.test/';
  let actual = liveControlDescriptor({ tag: 'button', name: recordedName, submits: false });
  let beforeRead = () => {}, beforeCount = () => {};
  const effects: string[] = [];
  const locator = {
    first: () => locator,
    count: async () => { beforeCount(); return 1; },
    evaluate: async (fn: { readonly name: string }) => { beforeRead(); return fn.name === 'describeElement' ? { ...actual } : { text: 'content' }; },
    click: async () => { effects.push('click'); }, fill: async () => { effects.push('fill'); },
    pressSequentially: async () => { effects.push('type'); }, press: async () => { effects.push('press'); },
    selectOption: async () => { effects.push('select'); return []; }, scrollIntoViewIfNeeded: async () => { effects.push('scroll'); },
  };
  const raw = () => [{ tag: 'button', role: 'button', name: recordedName, selector: '#send', value: null, disabled: false, checked: null, depth: 1, submits: false }];
  const frame = { parentFrame: () => null, evaluate: async () => raw() };
  const page = { url: () => url, locator: () => locator, title: async () => 'Test', frames: () => [frame], mainFrame: () => frame,
    waitForLoadState: async () => {}, frameLocator: () => page } as unknown as Page;
  const snapshot: BrowserSnapshot = { sessionId: 'b1', pageId: 'p1', url, title: 'Test', snapshotId: 's1', truncated: false,
    elements: [{ ...raw()[0]!, value: undefined, checked: undefined, ref: 'e1', frameChain: [] }] };
  const sessions = { defaultSessionId: () => 'b1', page: async () => ({ pageId: 'p1', page }) } as unknown as BrowserSessionManager;
  let approve = async () => {};
  let liveMaterial = false;
  const guard: CardFieldGuard = { disarm: () => { liveMaterial = false; }, hasLiveMaterial: () => liveMaterial, redact: (_s: string, _p: string, text: string) => text };
  const engine = new BrowserEngine(sessions, { screenshotDirectory: '/tmp', cardFieldGuard: guard, untrusted: {
    rule: 'test', originOf: () => 'example.test', recordIngest: () => {}, label: input => ({ trust: 'untrusted', surface: 'web-page', origin: input.origin, retrievedAt: 'synthetic', text: input.text, truncated: input.truncated === true, rule: 'test' }),
    evaluateOutwardEffect: async () => { await approve(); return { allowed: true, reason: null, fix: null, untrustedOrigins: [] }; },
  } });
  return { page, snapshot, engine, effects, locator,
    setName: (name: string) => { actual = { ...actual, name }; },
    malform: () => { actual = { tag: actual.tag, name: actual.name } as typeof actual; },
    setTag: (tag: string) => { actual = { ...actual, tag }; },
    navigate: () => { url += 'other'; }, setSubmit: () => { actual = { ...actual, submits: true }; },
    onRead: (work: () => void) => { beforeRead = work; }, onCount: (work: () => void) => { beforeCount = work; },
    arm: () => { liveMaterial = true; },
    onApproval: (work: () => Promise<void>) => { approve = work; },
  };
}

describe('browser control identity', () => {
  test('nonempty normalized equality is mechanical', async () => {
    const f = fixture(); f.setName('  SEND MESSAGE  ');
    const resolved = await resolveRef(f.page, f.snapshot, 'e1'); await resolved.revalidate();
    expect(resolved.element.ref).toBe('e1');
  });
  test.each(['', 'Delete account', 'Send'])('changed or missing labels have no lexical fallback: %s', async name => {
    const f = fixture('Delete'); f.setName(name); const model = reading(0.01);
    await expect(resolveRef(f.page, f.snapshot, 'e1')).rejects.toThrow(); expect(model.requests).toHaveLength(1);
  });
  test('empty/empty is not mechanically approved', async () => {
    const f = fixture(''); const model = reading(0.01);
    await expect(resolveRef(f.page, f.snapshot, 'e1')).rejects.toThrow(); expect(model.requests).toHaveLength(1);
  });
  test('a settled same-control paraphrase is grounded in both descriptors', async () => {
    const f = fixture(); f.setName('Submit message'); const model = reading();
    const resolved = await resolveRef(f.page, f.snapshot, 'e1'); await resolved.revalidate();
    expect(model.requests[0]?.state).toMatchObject({ recorded: { ref: 'e1', name: 'Send message', tag: 'button', frameChain: [] }, current: { name: 'Submit message' } });
  });
  test.each([0.01, 0.5])('no and uncertainty refuse: %s', async probability => {
    const f = fixture(); f.setName('Submit message'); reading(probability);
    await expect(resolveRef(f.page, f.snapshot, 'e1')).rejects.toThrow();
  });
  test('incomplete live descriptors never use the exact-name shortcut or judgment', async () => {
    const f = fixture(); f.malform(); const model = reading();
    await expect(resolveRef(f.page, f.snapshot, 'e1')).rejects.toThrow(); expect(model.requests).toHaveLength(0);
  });
  test('unavailable and malformed answers cannot approve', async () => {
    for (const answer of [null, { type: 'noul', probability: NaN }, { type: 'choice', choice: 'yes' }]) {
      const f = fixture(); f.setName('Submit message'); const model = fakePort(() => answer); installJudgmentPort(model.port);
      await expect(resolveRef(f.page, f.snapshot, 'e1')).rejects.toThrow();
    }
    installJudgmentPort(undefined); const f = fixture(); f.setName('Submit message');
    await expect(resolveRef(f.page, f.snapshot, 'e1')).rejects.toThrow();
  });
  test('complete identity metadata is admitted before any model call, without entered values', async () => {
    const f = fixture(); f.setName('Submit message Authorization: Bearer private-test-token'); const model = reading();
    await expect(resolveRef(f.page, f.snapshot, 'e1')).rejects.toThrow(); expect(model.requests).toHaveLength(0);
    const clean = fixture(); clean.setName('Submit message');
    const snapshot = { ...clean.snapshot, elements: clean.snapshot.elements.map(e => ({ ...e, value: 'private entered value' })) };
    await resolveRef(clean.page, snapshot, 'e1'); expect(JSON.stringify(model.requests)).not.toContain('private entered value');
  });
  test('navigation during the initial count is refused', async () => {
    const f = fixture(); f.onCount(f.navigate);
    await expect(resolveRef(f.page, f.snapshot, 'e1')).rejects.toThrow();
  });
  test('navigation or changed descriptors while a reading waits cannot be adopted', async () => {
    for (const mutate of ['navigate', 'name'] as const) {
      const f = fixture(); f.setName('Submit message'); const model = deferred();
      const result = resolveRef(f.page, f.snapshot, 'e1'); await model.started;
      if (mutate === 'navigate') f.navigate(); else f.setName('Delete account');
      model.release(); await expect(result).rejects.toThrow();
    }
  });
  test('revalidation refuses submit-semantics changes even with an unchanged name', async () => {
    const f = fixture(); const ref = await resolveRef(f.page, f.snapshot, 'e1'); f.setSubmit();
    await expect(ref.revalidate()).rejects.toThrow();
  });
  test('structural tag changes and mutated recorded selectors cannot be approved', async () => {
    const f = fixture(); f.setTag('a'); const model = reading();
    await expect(resolveRef(f.page, f.snapshot, 'e1')).rejects.toThrow(); expect(model.requests).toHaveLength(0);
    const other = fixture(); other.setName('Submit message'); const pending = deferred();
    const result = resolveRef(other.page, other.snapshot, 'e1'); await pending.started;
    Object.assign(other.snapshot.elements[0]!, { selector: '#delete-account' }); pending.release();
    await expect(result).rejects.toThrow();
  });
  test('a late port installation is not adopted', async () => {
    const f = fixture(); f.setName('Submit message'); const work = new BrowserControlIdentityWork(); const model = reading();
    await expect(resolveRef(f.page, f.snapshot, 'e1', work)).rejects.toThrow(); expect(model.requests).toHaveLength(0);
  });
});

const actions = {
  click: (engine: BrowserEngine) => engine.click({}, { ref: 'e1' }),
  type: (engine: BrowserEngine) => engine.type({}, { ref: 'e1', text: 'hello' }),
  select: (engine: BrowserEngine) => engine.select({}, { ref: 'e1', values: ['one'] }),
  press: (engine: BrowserEngine) => engine.press({}, { ref: 'e1', key: 'Tab' }),
  scroll: (engine: BrowserEngine) => engine.scroll({}, { ref: 'e1' }),
  extract: (engine: BrowserEngine) => engine.extract({}, { ref: 'e1' }),
  secret: (engine: BrowserEngine) => engine.fillSecretBatch({}, { fills: [{ ref: 'e1', value: 'private-secret-fixture' }] }),
};
describe('BrowserEngine identity effect boundaries', () => {
  test.each(Object.keys(actions).filter(action => action !== 'secret') as (keyof typeof actions)[])('snapshot replacement blocks %s before its effect', async action => {
    const f = fixture(); await f.engine.snapshot({}); f.setName('Submit message'); const model = deferred();
    const result = actions[action](f.engine); await model.started; await f.engine.snapshot({}); model.release();
    await expect(result).rejects.toThrow();
    expect(f.effects).toEqual([]); expect(JSON.stringify(model.requests)).not.toContain('private-secret-fixture');
  });
  test.each(Object.keys(actions) as (keyof typeof actions)[])('exact identity reaches the %s consumer without a reader', async action => {
    const f = fixture(); await f.engine.snapshot({});
    if (action === 'secret') f.arm();
    const result = await actions[action](f.engine); expect(result).toBeDefined();
    expect(f.effects.length).toBe(action === 'extract' ? 0 : 1);
  });
  test('source retirement during outward approval prevents the final effect', async () => {
    const f = fixture(); await f.engine.snapshot({}); const model = reading(); let active = true;
    bindJudgmentPortAuthority(model.port, () => ({ identity: {}, assertCurrent: () => { if (!active) throw new Error('retired'); } }));
    f.onApproval(async () => { active = false; });
    await expect(f.engine.press({}, { ref: 'e1', key: 'Enter' })).rejects.toThrow(); expect(f.effects).toEqual([]);
  });
  test('secret batches require an armed guard and never semantically retarget', async () => {
    const f = fixture(); await f.engine.snapshot({}); const model = reading();
    await expect(actions.secret(f.engine)).rejects.toThrow(); expect(f.effects).toEqual([]);
    f.arm(); f.setName('Submit private-secret-fixture');
    expect(await actions.secret(f.engine)).toMatchObject({ filled: [], failedRef: 'e1' });
    expect(model.requests).toHaveLength(0); expect(f.effects).toEqual([]);
  });
  test('changed labels cannot send copied live payment material to judgment', async () => {
    const f = fixture(); await f.engine.snapshot({}); f.arm(); f.setName('Submit private-cvv-fixture'); const model = reading();
    await expect(f.engine.click({}, { ref: 'e1' })).rejects.toThrow(); expect(model.requests).toHaveLength(0); expect(f.effects).toEqual([]);
    const exact = fixture(); await exact.engine.snapshot({}); exact.arm();
    await exact.engine.type({}, { ref: 'e1', text: 'authorized local value' }); expect(exact.effects).toEqual(['fill']);
  });
  test('settled paraphrase reaches an actual engine effect', async () => {
    const f = fixture(); await f.engine.snapshot({}); f.setName('Submit message'); reading();
    await f.engine.click({}, { ref: 'e1' }); expect(f.effects).toEqual(['click']);
  });
  test('changed DOM after outward approval never submits', async () => {
    const f = fixture(); await f.engine.snapshot({}); f.onApproval(async () => { f.setName('Delete account'); });
    await expect(f.engine.press({}, { ref: 'e1', key: 'Enter' })).rejects.toThrow(); expect(f.effects).toEqual([]);
  });
  test.each(['caller', 'source', 'installation', 'configuration'] as const)('%s cancellation has no late effects', async kind => {
    const f = fixture(); await f.engine.snapshot({}); f.setName('Submit message'); const model = deferred();
    const controller = new AbortController(); let sourceCurrent = true;
    bindJudgmentPortAuthority(model.port, () => ({ identity: {}, assertCurrent: () => { if (!sourceCurrent) throw new Error('stale source'); } }));
    const result = f.engine.click({}, { ref: 'e1' }, { signal: controller.signal, assertCurrent: () => {} });
    const handled = result.catch(error => error); await model.started;
    if (kind === 'caller') controller.abort();
    if (kind === 'source') sourceCurrent = false;
    if (kind === 'installation') installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
    if (kind === 'configuration') Object.assign(model.port, { model: 'replacement-model' });
    model.release(); expect(await handled).toBeInstanceOf(Error); expect(f.effects).toEqual([]);
  });
  test('request arguments are captured before a reading', async () => {
    const f = fixture(); await f.engine.snapshot({}); f.setName('Submit message'); const model = deferred();
    const args = { ref: 'e1', text: 'original' }; const values: string[] = [];
    f.locator.fill = async (...input: unknown[]) => { values.push(String(input[0])); };
    const result = f.engine.type({}, args); await model.started; args.text = 'successor'; model.release();
    await result; expect(values).toEqual(['original']);
  });
});
