import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { bindJudgmentPortAuthority, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { processEndpointCandidates } from '@goodvibes-jev/engine/terminal-shell';
import { MAX_LINES, ProcessOutputLog } from '../../core/process-output-log.ts';
import { makeProcessOutputReadingFixture, processEvidenceRows as rowsOf } from '../helpers/process-output-reading.ts';

const rec = (stdout: string[], stderr: string[] = [], done = false) => ({ stdout, stderr, done });
const logs: ProcessOutputLog[] = [];
const makeLog = (changed: () => void = () => {}) => { const log = new ProcessOutputLog(changed); logs.push(log); return log; };
let previous: ReturnType<typeof installJudgmentPort>;
const errorTexts = new Set(['error TS2345: bad', 'Build failed with 2 errors', 'Die Verbindung konnte nicht hergestellt werden.']);
const listeningTexts = new Set(['Local: http://localhost:5173/', 'Server listening on port 3000', 'http://127.0.0.1:8080', 'http://localhost:9000']);
const authoredPort = () => makeProcessOutputReadingFixture([...errorTexts], [...listeningTexts]);
async function bounded<T>(work: Promise<T>, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Process reading did not settle: ${stage}`)), 2000); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
beforeEach(() => { previous = installJudgmentPort(authoredPort().port); });
afterEach(async () => { await Promise.all(logs.splice(0).map(log => log.dispose())); installJudgmentPort(previous); });

describe('process output log', () => {
  test('timestamps and partial lines stay local until a complete line arrives', () => {
    const log = makeLog();
    const out = ['ready in 412 ms\nLocal: http://localhost:5173/\npart'];
    log.poll(new Map([['p', rec(out)]]), 1000);
    expect(log.lines('p').map(l => [l.at, l.text])).toEqual([[1000, 'ready in 412 ms'], [1000, 'Local: http://localhost:5173/']]);
    expect(log.lines('p').every(line => line.error === undefined)).toBe(true);
    out.push('ial line\n');
    log.poll(new Map([['p', rec(out)]]), 2000);
    expect(log.lines('p').at(-1)).toMatchObject({ at: 2000, text: 'partial line' });
  });
  test('a finished process flushes its last partial line', () => {
    const log = makeLog(); log.poll(new Map([['p', rec(['no newline'], [], true)]]), 5);
    expect(log.lines('p').map(l => l.text)).toEqual(['no newline']);
  });
  test('canonical observations mark actual errors after controls and progress redraws are stripped', async () => {
    let changed = 0;
    const log = makeLog(() => changed++);
    log.poll(new Map([['p', rec(['\x1b[32mok\x1b[0m\n', '10%\r50%\r100%\n'], ['error TS2345: bad\n'])]]), 1);
    const before = log.revision('p');
    expect(log.lines('p').map(l => l.text)).toEqual(['ok', '100%', 'error TS2345: bad']);
    await log.whenSettled();
    expect(log.lines('p').map(l => l.error)).toEqual([false, false, true]);
    expect(log.lines('p')[2]?.stream).toBe('stderr');
    expect(log.revision('p')).toBeGreaterThan(before);
    expect(changed).toBe(1);
  });
  test('port candidates are exact integer spans, and ambiguous announcements never pick the first port', async () => {
    const text = 'http://127.0.0.1:8080 port 65536 modules 3000';
    const candidates = processEndpointCandidates([{ id: 'line', text, raw: text, stream: 'stdout' }]);
    expect(candidates?.map(c => [text.slice(c.start, c.end), c.port])).toEqual([['8080', 8080], ['3000', 3000]]);
    const log = makeLog();
    log.poll(new Map([['p', rec(['http://127.0.0.1:8080\nhttp://localhost:9000\n'])]]), 1);
    expect(log.port('p')).toBeUndefined();
    await log.whenSettled();
    expect(log.port('p')).toBeUndefined();
    log.poll(new Map([['p', rec(['Server listening on port 3000\n'])]]), 2);
    await log.whenSettled(); expect(log.port('p')).toBe(3000);
  });
  test('the local log remains bounded and forgets removed processes', () => {
    const log = makeLog();
    const chunk = Array.from({ length: MAX_LINES + 25 }, (_, i) => `line ${i}`).join('\n') + '\n';
    log.poll(new Map([['p', rec([chunk])]]), 1);
    expect(log.lines('p')).toHaveLength(MAX_LINES); expect(log.dropped('p')).toBe(25);
    expect(log.lines('p')[0]?.text).toBe('line 25');
    log.poll(new Map(), 2); expect(log.lines('p')).toHaveLength(0);
  });
  test('quoted failures and successful error tests remain neutral; failures in another language are read', async () => {
    const log = makeLog();
    log.poll(new Map([['p', rec(['Task: fix failed tests\nAll error-handling tests passed; 0 failures.\nDie Verbindung konnte nicht hergestellt werden.\n'])]]));
    await log.whenSettled();
    expect(log.lines('p').map(l => l.error)).toEqual([false, false, true]);
  });
  test('stable polls and paints do not repeat observations; appends retain exact line references', async () => {
    const fixture = authoredPort(); installJudgmentPort(fixture.port);
    const log = makeLog(); const record = rec(['Build failed with 2 errors\n']); const records = new Map([['p', record]]);
    log.poll(records); await log.whenSettled(); const first = log.lines('p')[0]; const calls = fixture.requests.length;
    for (let i = 0; i < 8; i++) { log.poll(records); log.lines('p'); log.port('p'); }
    await log.whenSettled(); expect(fixture.requests).toHaveLength(calls);
    record.stdout.push('repaired\n'); log.poll(records); await log.whenSettled();
    expect(log.lines('p')[0]).toBe(first); expect(first?.error).toBe(true);
    const newErrorKeys = fixture.requests.slice(calls).flatMap(request => Object.keys(request.questions).filter(key => key.startsWith('error:')));
    expect(newErrorKeys).toHaveLength(1);
  });
  for (const retirement of ['remove', 'replace arrays', 'trim arrays', 'mutate chunk', 'done', 'dispose', 'source'] as const) {
    test(`${retirement} drains a reader that ignores cancellation without admitting obsolete results`, async () => {
      const fixture = authoredPort(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
      let first = true;
      const port: JudgmentPort = { ...fixture.port, async ask(request) {
        if (first) { first = false; entered.resolve(); await release.promise; }
        return fixture.port.ask(request);
      } };
      const source = new AbortController(); bindJudgmentPortAuthority(port, () => ({ identity: source, signal: source.signal, assertCurrent() {} })); installJudgmentPort(port);
      const log = makeLog(); const record = rec(['Build failed with 2 errors\n', 'earlier\n']); const records = new Map([['p', record]]);
      log.poll(records); const pending = log.whenSettled();
      try {
        await bounded(entered.promise, `${retirement} entered`);
        if (retirement === 'remove') records.clear();
        if (retirement === 'replace arrays') record.stdout = ['new output\n'];
        if (retirement === 'trim arrays') record.stdout.splice(0, 1);
        if (retirement === 'mutate chunk') record.stdout[0] = 'new output\n';
        if (retirement === 'done') record.done = true;
        if (retirement === 'dispose') await log.dispose();
        else if (retirement === 'source') source.abort();
        else log.poll(records);
        await bounded(pending, `${retirement} cancelled`);
        expect(log.lines('p').every(line => line.error === undefined)).toBe(true);
        expect(log.port('p')).toBeUndefined();
      } finally { release.resolve(); }
      await bounded(log.whenSettled(), `${retirement} replacement`);
      if (retirement === 'replace arrays' || retirement === 'mutate chunk') expect(log.lines('p')[0]?.text).toBe('new output');
      expect(log.lines('p').some(line => line.error === true)).toBe(retirement === 'done');
    });
  }
  test('a source replacement retires completed observations and rereads under the new authority', async () => {
    const log = makeLog(); const records = new Map([['p', rec(['Build failed with 2 errors\n'])]]);
    log.poll(records); await log.whenSettled(); expect(log.lines('p')[0]?.error).toBe(true);
    const fixture = fakePort(() => noulAnswer(0.01)); installJudgmentPort(fixture.port);
    expect(log.lines('p')[0]?.error).toBeUndefined();
    log.poll(records); await log.whenSettled(); expect(log.lines('p')[0]?.error).toBe(false);
  });
  test('local timestamps cannot enter semantic evidence or trigger card-shape screening', async () => {
    const fixture = authoredPort(); installJudgmentPort(fixture.port);
    const timestamp = 1791676800009;
    const log = makeLog(); log.poll(new Map([['p', rec(['Build failed with 2 errors\n'])]]), timestamp);
    await log.whenSettled();
    expect(log.lines('p')[0]).toMatchObject({ at: timestamp, error: true });
    expect(fixture.requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(fixture.requests)).not.toContain(String(timestamp));
  });
  for (const change of ['remove', 'replace arrays', 'trim', 'mutate'] as const) {
    test(`completed line observations are held after ${change} without another poll`, async () => {
      const log = makeLog(); const record = rec(['Build failed with 2 errors\n', 'earlier\n']); const records = new Map([['p', record]]);
      log.poll(records); await log.whenSettled(); expect(log.lines('p')[0]?.error).toBe(true);
      if (change === 'remove') records.clear();
      if (change === 'replace arrays') record.stdout = ['all passed\n'];
      if (change === 'trim') record.stdout.splice(0, 1);
      if (change === 'mutate') record.stdout[0] = 'all passed\n';
      expect(log.lines('p').every(line => line.error === undefined)).toBe(true);
    });
  }
  test('complete raw output and unfinished tails are screened before any hosted call', async () => {
    const fixture = authoredPort(); installJudgmentPort(fixture.port);
    const log = makeLog(); log.poll(new Map([['p', rec(['ordinary\n' + 'x'.repeat(20_000) + '\napi_key=PRIVATE_OUTPUT_SECRET'])]]));
    await log.whenSettled(); expect(fixture.requests).toHaveLength(0);
    expect(log.lines('p').every(line => line.error === undefined)).toBe(true);
  });
  test('uncertain observations do not fabricate error severity or listening ports', async () => {
    installJudgmentPort(fakePort(() => noulAnswer(0.5)).port);
    const log = makeLog(); log.poll(new Map([['p', rec(['Build failed with 2 errors\nServer listening on port 3000\n'])]]));
    await log.whenSettled(); expect(log.lines('p').map(line => line.error)).toEqual([undefined, undefined]); expect(log.port('p')).toBeUndefined();
  });
  test('bounded pages include the full retained context and run no more than four concurrently', async () => {
    const fixture = authoredPort(); let active = 0, maximum = 0;
    const port: JudgmentPort = { ...fixture.port, async ask(request) {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      try { return await fixture.port.ask(request); } finally { active--; }
    } };
    installJudgmentPort(port);
    const text = Array.from({ length: 300 }, () => 'ordinary output').join('\n') + '\n';
    const log = makeLog(); log.poll(new Map([['p', rec([text])]])); await log.whenSettled();
    expect(fixture.requests).toHaveLength(5); expect(maximum).toBeLessThanOrEqual(4);
    for (const request of fixture.requests) { expect(Object.keys(request.questions).length).toBeLessThanOrEqual(64); expect(rowsOf(request.state, 'lines')).toHaveLength(300); }
  });
  test('source mutations without another poll still prevent logging or publication', async () => {
    const fixture = authoredPort(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); const actions: string[] = [];
    const port: JudgmentPort = { ...fixture.port, recorder: { recordReadings() {}, recordAction(_id, action) { actions.push(action); } }, async ask(request) { entered.resolve(); await release.promise; return { ...await fixture.port.ask(request), decisionId: 'owned-output' }; } };
    installJudgmentPort(port);
    const log = makeLog(); const record = rec(['Build failed with 2 errors\n']); log.poll(new Map([['p', record]])); const pending = log.whenSettled(); await entered.promise;
    record.stdout[0] = 'all passed\n'; release.resolve(); await pending;
    expect(actions).toEqual([]); expect(log.lines('p')[0]?.error).toBeUndefined();
  });
  test('one failed page cancels and drains its uncooperative sibling pages', async () => {
    const fixture = authoredPort(); const release = Promise.withResolvers<void>(); const signals: AbortSignal[] = [];
    let calls = 0;
    const port: JudgmentPort = { ...fixture.port, async ask(request) {
      if (request.signal) signals.push(request.signal);
      if (++calls === 1) throw new Error('Hosted page failed');
      await release.promise; return fixture.port.ask(request);
    } };
    installJudgmentPort(port);
    const log = makeLog(); log.poll(new Map([['p', rec([Array.from({ length: 130 }, () => 'ordinary output').join('\n') + '\n'])]]));
    try {
      await bounded(log.whenSettled(), 'failed page drain');
      expect(signals).toHaveLength(3); expect(signals.every(signal => signal.aborted)).toBe(true);
      expect(log.lines('p').every(line => line.error === undefined)).toBe(true);
    } finally { release.resolve(); }
  });
});
