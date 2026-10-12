import { describe, expect, test } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { scoreInboxTriage } from '../sdk/src/platform/intake/triage/scorer.js';
import { captureTriageInputs, checkTriageReceipt } from '../sdk/src/platform/intake/triage/evidence.js';
import { inboxTriage, TRIAGE_MODEL } from '../sdk/src/platform/intake/triage/battery.js';
import { enrichItemsWithTriage, readTriageMetadataBatch, runInboxTriage } from '../sdk/src/platform/intake/triage/pipeline.js';
import type { TriageInput, TriageReceipt, TriageStore, TriageStoredRecord } from '../sdk/src/platform/intake/triage/types.js';
const item = (id = 'fixture-a', subject = 'Synthetic message'): TriageInput => ({ id, surface: 'synthetic', subject, snippet: 'A synthetic offline fixture.', unread: true });
const answer = (spam = .01, urgency = .01) => fakePort(name => noulAnswer(name.endsWith('spam') ? spam : urgency));
const memory = (): TriageStore & { rows: Map<string, TriageStoredRecord>; calls: string[] } => {
  const rows = new Map<string, TriageStoredRecord>(), calls: string[] = [];
  return { rows, calls,
    async readBatch() { calls.push('read'); return rows; },
    async commit(receipts) { calls.push('commit'); for (const receipt of receipts) rows.set(receipt.id, { latest: receipt, settled: receipt.status === 'settled' ? receipt : rows.get(receipt.id)?.settled ?? null }); },
    async close() { calls.push('close'); },
  };
};

describe('typed inbox triage', () => {
  test('one pinned registered-shaped request handles an entire batch', async () => {
    const fake = fakePort(name => noulAnswer(name === 'item1__spam' ? .99 : name === 'item2__urgency' ? .99 : .01));
    const rows = await scoreInboxTriage([item('a'), item('b'), item('c')], fake.port);
    expect(rows.map(row => row.status === 'settled' ? row.label : row.status)).toEqual(['normal','spam','priority']);
    expect(fake.requests).toHaveLength(1);
    expect(Object.keys(fake.requests[0]!.questions)).toHaveLength(6);
    expect(fake.requests[0]!.model).toBe(TRIAGE_MODEL);
    expect(fake.requests[0]!.context?.battery).toBe(inboxTriage.name);
    expect(Object.isFrozen(rows[0])).toBe(true);
    expect(checkTriageReceipt(rows[0])).toEqual(rows[0]!);
  });
  test('empty batches never call judgment or storage', async () => {
    const fake = answer(), store = memory();
    expect(await runInboxTriage([], { port: fake.port, store })).toEqual([]);
    expect(fake.requests).toHaveLength(0); expect(store.calls).toEqual([]);
  });
  test('confirm and escalate are held, absent or failing judgments unavailable', async () => {
    for (const p of [.71, .5]) expect((await scoreInboxTriage([item()], answer(p).port))[0]?.status).toBe('held');
    expect((await scoreInboxTriage([item()]))[0]?.status).toBe('unavailable');
    const failed: JudgmentPort = { model: TRIAGE_MODEL, async ask() { throw new Error('synthetic failure'); } };
    expect((await scoreInboxTriage([item()], failed))[0]?.status).toBe('unavailable');
    for (const p of [NaN, Infinity, -.1, 1.1]) expect((await scoreInboxTriage([item()], answer(p).port))[0]?.status).toBe('unavailable');
  });
  test('no label arises from absent answers, wrong models or executable response objects', async () => {
    for (const field of ['model','answers']) {
      let calls = 0;
      const port: JudgmentPort = { model: TRIAGE_MODEL, async ask() {
        const result: Record<string, unknown> = { model: TRIAGE_MODEL, requestedModel: TRIAGE_MODEL, answers: {} };
        Object.defineProperty(result, field, { get() { calls++; throw new Error('must not execute'); } });
        return result as never;
      } };
      expect((await scoreInboxTriage([item()], port))[0]?.status).toBe('unavailable'); expect(calls).toBe(0);
    }
    let traps = 0;
    const port: JudgmentPort = { model: TRIAGE_MODEL, async ask() { return new Proxy({}, { ownKeys() { traps++; return []; } }) as never; } };
    expect((await scoreInboxTriage([item()], port))[0]?.status).toBe('unavailable'); expect(traps).toBe(0);
  });
  test('borrowed model/recorder getters are untouched and the one outgoing request is immutable', async () => {
    let touched = 0;
    const fake = answer(), controller = new AbortController();
    const port: JudgmentPort = {
      get model(): string { touched++; throw new Error('must not inspect borrowed model'); },
      get recorder(): never { touched++; throw new Error('must not inspect borrowed recorder'); },
      async ask(request) {
        expect(Object.isFrozen(request)).toBe(true);
        expect(Object.isFrozen(request.state)).toBe(true);
        expect(Object.isFrozen(request.questions)).toBe(true);
        expect(Object.isFrozen(request.questions['item0__spam'])).toBe(true);
        expect(Object.isFrozen(request.context)).toBe(true);
        expect(request.signal).toBe(controller.signal);
        expect(request.context?.batteryVersion).toBe(inboxTriage.version);
        return fake.port.ask(request);
      },
    };
    expect((await scoreInboxTriage([item()],port,controller.signal))[0]?.status).toBe('settled');
    expect(fake.requests).toHaveLength(1); expect(touched).toBe(0);
  });
  test('missing or mismatched model provenance cannot settle', async () => {
    for (const change of [{model:'other-model'}, {requestedModel:'other-model'}, {model:undefined}, {requestedModel:undefined}]) {
      const fake = answer();
      const port: JudgmentPort = {model:TRIAGE_MODEL, async ask(request) { return {...await fake.port.ask(request), ...change} as never; }};
      expect((await scoreInboxTriage([item()],port))[0]?.status).toBe('unavailable');
    }
    for (const p of [.65,.5]) expect((await scoreInboxTriage([item()],answer(.01,p).port))[0]?.status).toBe('held');
  });
  test('binding covers the whole semantic projection and ignores opaque targeting metadata', async () => {
    const base = (await scoreInboxTriage([item()],answer().port))[0]!;
    for (const change of [{surface:'other'},{subject:'different'},{snippet:'different'},{conversationKind:'direct' as const},{unread:false}]) {
      expect((await scoreInboxTriage([{...item(),...change}],answer().port))[0]?.inputHash).not.toBe(base.inputHash);
    }
    expect((await scoreInboxTriage([{...item(),metadata:{providerTarget:'synthetic'}}],answer().port))[0]?.inputHash).toBe(base.inputHash);
    const rounded = (await scoreInboxTriage([item()],answer(.015,.985).port))[0]!;
    expect(rounded.status === 'settled' && rounded.score).toBe(.99);
  });
  test('complete input is inspected before projection, fingerprint or port access', async () => {
    let accessed = 0;
    const port = { get ask() { accessed++; throw new Error(); }, model: TRIAGE_MODEL } as unknown as JudgmentPort;
    const unsafe = { ...item(), metadata: { password: 'synthetic-do-not-send' } };
    await expect(scoreInboxTriage([unsafe], port)).rejects.toThrow('Refused before judgment');
    const hidden = {...item()}; Object.defineProperty(hidden, 'ignored', { value: { password: 'synthetic-do-not-send' } });
    await expect(scoreInboxTriage([hidden], port)).rejects.toThrow('Refused before judgment');
    await expect(scoreInboxTriage([{...item(), snippet: 'x'.repeat(10000) + ' password=synthetic-do-not-send'}], port)).rejects.toThrow('Refused before judgment');
    expect(accessed).toBe(0);
  });
  test('rejects getters, proxies, cycles, symbols, sparse arrays and duplicate ids without execution', async () => {
    let calls = 0;
    const getter = { ...item() }; Object.defineProperty(getter, 'metadata', { get() { calls++; return {}; } });
    const proxy = new Proxy(item(), { ownKeys() { calls++; return []; } });
    const cyclic: Record<string, unknown> = {}; cyclic['self'] = cyclic;
    for (const bad of [[getter], [proxy], [{ ...item(), metadata: cyclic }], [{ ...item(), [Symbol('secret')]: 'x' }], new Array(1), [item(),item()]]) {
      await expect(scoreInboxTriage(bad as TriageInput[], answer().port)).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });
  test('original mutations cannot alter captured judgment state or evidence', async () => {
    const input = { ...item() }, fake = answer();
    const port: JudgmentPort = { model: TRIAGE_MODEL, async ask(request) { input.subject = 'changed'; return fake.port.ask(request); } };
    const receipts = await scoreInboxTriage([input], port);
    expect(fake.requests[0]!.state).toEqual({items: captureTriageInputs([item()]).map(item => ({...item}))});
    expect(receipts[0]?.inputHash).not.toBe((await scoreInboxTriage([input]))[0]?.inputHash);
  });
  test('dry-run is wholly store-free and does not close an injected store', async () => {
    let touched = 0;
    const result = await runInboxTriage([item()], { port: answer().port, dryRun: true, get store(): TriageStore { touched++; throw new Error(); } });
    expect(result[0]?.status).toBe('settled'); expect(touched).toBe(0);
    const store = memory(); await runInboxTriage([item()], { port: answer().port, store }); expect(store.calls).toEqual(['commit']);
  });
  test('aborted before and after judgment never writes', async () => {
    for (const abortBefore of [true,false]) {
      const controller = new AbortController(), fake = answer(), store = memory();
      if (abortBefore) controller.abort();
      const port: JudgmentPort = { model: TRIAGE_MODEL, async ask(request) { controller.abort(); return fake.port.ask(request); } };
      expect((await runInboxTriage([item()], {port,store,signal:controller.signal}))[0]?.status).toBe('unavailable');
      expect(store.calls).toEqual([]);
    }
  });
  test('held/unavailable preserve history without projecting it, changed input invalidates projection', async () => {
    const store = memory();
    await runInboxTriage([item()], { store, port: answer(.01,.99).port });
    const old = store.rows.get(item().id)!.settled;
    expect((await readTriageMetadataBatch([item()],store)).get(item().id)?.label).toBe('priority');
    expect((await readTriageMetadataBatch([item('fixture-a','changed')],store)).size).toBe(0);
    for (const port of [answer(.5).port, undefined]) {
      await runInboxTriage([item()],{store,...(port ? {port} : {})});
      expect(store.rows.get(item().id)!.settled).toEqual(old);
      expect((await readTriageMetadataBatch([item()],store)).size).toBe(0);
    }
  });
  test('reordered stored evidence remains id-bound and stale incoming labels are stripped', async () => {
    const store = memory();
    await runInboxTriage([item('b')],{store,port:answer(.99).port});
    await runInboxTriage([item('a')],{store,port:answer(.01,.99).port});
    const results = await enrichItemsWithTriage([{...item('a'),triageLabel:'spam'} as TriageInput,item('b')],store);
    expect(results.map(row => row.triage?.label)).toEqual(['priority','spam']);
    expect('triageLabel' in results[0]!).toBe(false);
  });
  test('forged evidence and executable stored receipts never yield labels', async () => {
    const store = memory(); await runInboxTriage([item()],{store,port:answer().port});
    const row = store.rows.get(item().id)!;
    expect(() => checkTriageReceipt({...row.latest,label:'spam'})).toThrow();
    let calls=0; const bad = {...row}; Object.defineProperty(bad,'latest',{get(){calls++; return row.latest;}});
    store.rows.set(item().id,bad); expect((await readTriageMetadataBatch([item()],store)).size).toBe(0); expect(calls).toBe(0);
    store.rows.set(item().id, {latest: {...row.latest,id:'wrong'},settled:row.settled} as TriageStoredRecord);
    expect((await readTriageMetadataBatch([item()],store)).size).toBe(0);
  });
});


test('late triage imports keep earlier native decision policies current while triage bands stay immutable', async () => {
  const benchmarkUrl = new URL('../sdk/src/platform/routing/batteries/local-benchmark-prompt.ts', import.meta.url).href;
  const booleanUrl = new URL('../sdk/src/platform/tools/batteries/boolean-value.ts', import.meta.url).href;
  const triageUrl = new URL('../sdk/src/platform/intake/triage/battery.ts', import.meta.url).href;
  const meaningUrl = new URL('../sdk/src/platform/intake/triage/tagger/meaning.ts', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    const { STAKES_BANDS } = await import('@goodvibes-jev/judgment');
    const { localBenchmarkPromptPolicy } = await import(${JSON.stringify(benchmarkUrl)});
    const { booleanValuePolicy } = await import(${JSON.stringify(booleanUrl)});
    localBenchmarkPromptPolicy.assertCurrent(); booleanValuePolicy.assertCurrent();
    const defaults = [STAKES_BANDS.medium.yesNo, STAKES_BANDS.medium.confidence,
      STAKES_BANDS.high.yesNo, STAKES_BANDS.high.confidence];
    const descriptors = defaults.map(value => Object.getOwnPropertyDescriptors(value));
    const { inboxTriage } = await import(${JSON.stringify(triageUrl)});
    const { triageTagMeaning } = await import(${JSON.stringify(meaningUrl)});
    localBenchmarkPromptPolicy.assertCurrent(); booleanValuePolicy.assertCurrent();
    defaults.forEach((value, index) => assert.deepEqual(Object.getOwnPropertyDescriptors(value), descriptors[index]));
    const owned = [inboxTriage.items.spam.band, inboxTriage.items.urgency.band, triageTagMeaning.items.meaning.band];
    const shared = [STAKES_BANDS.high.yesNo, STAKES_BANDS.medium.yesNo, STAKES_BANDS.high.confidence];
    owned.forEach((value, index) => { assert.notEqual(value, shared[index]); assert.deepEqual(value, shared[index]); assert(Object.isFrozen(value)); });
    for (const [value, expected] of [[owned[0].yes, STAKES_BANDS.high.yesNo.yes],
      [owned[0].no, STAKES_BANDS.high.yesNo.no], [owned[1].yes, STAKES_BANDS.medium.yesNo.yes],
      [owned[1].no, STAKES_BANDS.medium.yesNo.no], [owned[2], STAKES_BANDS.high.confidence]]) {
      assert.notEqual(value, expected); assert.deepEqual(value, expected); assert(Object.isFrozen(value));
      const original = value.actAt;
      assert.equal(Reflect.set(value, 'actAt', 0), false); assert.equal(value.actAt, original);
    }
    localBenchmarkPromptPolicy.assertCurrent(); booleanValuePolicy.assertCurrent();
    process.stdout.write('native policy ownership retained\\n');
  `;
  const child = Bun.spawn({ cmd: [process.execPath, '--conditions=bun', '--eval', script], cwd: new URL('..', import.meta.url).pathname,
    env: {}, stdout: 'pipe', stderr: 'pipe' });
  let exited = false;
  const deadline = setTimeout(() => child.kill(), 4_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    exited = true;
    expect(stderr).toBe(''); expect(code).toBe(0); expect(stdout).toBe('native policy ownership retained\n');
  } finally {
    clearTimeout(deadline); if (!exited) child.kill(); await child.exited;
  }
});
