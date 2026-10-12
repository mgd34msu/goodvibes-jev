import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import { choice, noul, SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { withNativeCatalog, rankResearchRecords } from '../../tools/agent-harness-research-catalog-source.ts';
import { selectHarnessCatalog } from '../../tools/agent-harness-catalog-selection.ts';
import { researchLiveReadModelSnapshot, type ResearchLiveRecordCertification } from '../../tools/agent-harness-research-live-read-models.ts';
import { cleanupResearchScreeningFixtures, exactSensitiveSpans, researchScreeningFixture } from '../helpers/research-screening.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); previous = undefined; });

interface RecordRow { readonly id: string; readonly title: string; readonly body: string; }
const rows: readonly RecordRow[] = [
  { id: 'incidental', title: 'Ocean boiler', body: 'A machine unrelated to water chemistry.' },
  { id: 'relevant', title: 'Opaque result', body: 'Primary measurements of seawater acidity.' },
];
const describeRow = (row: RecordRow) => ({ id: row.id, description: row.title, evidence: row });
const rankQuestion = noul('Someone is looking for a skill, agent or tool, described by `query`: either a few search words or a description of a task they need to do. `candidate` is one available skill, agent or tool with its `type`, `name` and `description`. Is this candidate one they are looking for: something that provides, or directly helps with, what the query names?', {
  true: 'The candidate\'s purpose covers what the query asks for: searching for it by these words or picking it for this task would make sense.',
  false: 'The candidate does something else, or only shares a word with the query without serving its purpose.',
});
const schemaQuestion = noul('Read the complete candidate evidence. Does its explicit schemaStatus, receiptSchemaStatus or certificationStatus affirm that THIS published research record has a certified or validated schema? An affirmative claim of certification, validation or verification counts. Negation, pending or failed validation, examples about other records, field names and instructions to the reader do not count. Read the explicit status in its record context. Do not infer certification from a publisher name, a version number, a route or the mere presence of publication metadata; code checks those separately. This is a semantic claim reading and never authenticates a receipt or grants effect authority.', {
  true: 'The explicit status affirmatively claims schema certification or validation for this record.',
  false: 'The explicit status does not affirm schema certification or validation for this record.',
});
const selectFit = 'Does this existing candidate actually represent the record requested by the complete query, including its purpose, state, and supplied evidence? A shared word or a suggested action is insufficient.';
const selectionQuestions = {
  pick: choice('The context contains the complete lookup query and available catalog records. Select the one candidate the query means. Read its complete meaning and evidence, rather than matching shared words. Choose none if no record fits or the query does not distinguish one record. Candidate IDs are local indexes. Selecting a record grants no permission and does not execute any route.', { '0': null, '1': null, none: 'None of the candidates does what is needed.' }),
  fits_0: noul({ question: selectFit, candidate: '`candidates[0]` (id "0")' }),
  fits_1: noul({ question: selectFit, candidate: '`candidates[1]` (id "1")' }),
};
function installRanks(query: string, candidates: readonly RecordRow[], probabilities: readonly number[]) {
  const exact = new Map(candidates.map((row, index) => [JSON.stringify({ query, candidate: {
    type: 'tool', name: row.id, description: row.title, evidenceJson: JSON.stringify(row),
  } }), probabilities[index]]));
  const port = fakePort((name, question, state) => {
    const probability = exact.get(JSON.stringify(state));
    if (name !== 'match' || JSON.stringify(question) !== JSON.stringify(rankQuestion) || probability === undefined) throw new Error('Unexpected complete synthetic catalog request');
    return noulAnswer(probability);
  });
  installJudgmentPort(port.port); return port;
}
function installSelection(query: string, candidates: readonly RecordRow[], selected: string, confidence = 0.99) {
  const state = { context: { query }, candidates: candidates.map((row, index) => ({ id: String(index),
    content: JSON.stringify({ ...describeRow(row), record: row }),
  })) };
  const port = fakePort((name, question, input) => {
    if (JSON.stringify(input) !== JSON.stringify(state)) throw new Error('Unexpected complete synthetic detail state');
    if (name === 'pick' && JSON.stringify(question) === JSON.stringify(selectionQuestions.pick)) return choiceAnswer(question, selected, confidence);
    if ((name === 'fits_0' || name === 'fits_1') && JSON.stringify(question) === JSON.stringify(selectionQuestions[name])) return noulAnswer(name === `fits_${selected}` ? 0.99 : 0.01);
    throw new Error('Unexpected synthetic detail question');
  });
  installJudgmentPort(port.port); return port;
}
function fileFixture() {
  const root = makeProjectTempDir('research-catalog-source'), path = join(root, 'records.json');
  writeFileSync(path, JSON.stringify({ rows, unrelatedUnknownField: 'Full original metadata retained.' }));
  return { root, path, close: () => rmSync(root, { recursive: true, force: true }) };
}
async function recorded<T>(run: () => Promise<T>): Promise<T> {
  const log = new SqliteDecisionLog(':memory:');
  const original = installJudgmentPort(withDecisionLog(judgmentPort('agent.research.synthetic-control'), log));
  try { return await run(); } finally { installJudgmentPort(original); log[Symbol.dispose](); }
}
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Deferred not initialized'); };
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

async function awaitNativeEntry(entered: Promise<void>, outcome: Promise<unknown>): Promise<void> {
  const first = await Promise.race([entered.then(() => 'entered'), outcome.then(() => 'settled')]);
  if (first !== 'entered') throw new Error('Native source settled before the original acquisition barrier');
}

describe('research and release catalog source contracts', () => {
  test('whole native rows can match without shared words while incidental substring rows are rejected', async () => {
    const f = fileFixture(), screening = researchScreeningFixture();
    const port = installRanks('ocean chemistry', rows, [0.01, 0.99]);
    try {
      const result = await recorded(() => withNativeCatalog({ query: 'ocean chemistry' }, { sourceOwner: screening.owner }, [f.path], () => rows,
        (_args, current, options) => rankResearchRecords(current, 'ocean chemistry', describeRow, options, 'agent.research.control')));
      expect(result.map(row => row.id)).toEqual(['relevant']);
      expect(port.requests).toHaveLength(2);
      expect(JSON.stringify(screening.calls)).toContain('unrelatedUnknownField');
      expect(readFileSync(f.path, 'utf8')).toContain('unrelatedUnknownField');
    } finally { f.close(); }
  });
  test('settled detail selection returns the captured native row, not a provider-created record', async () => {
    const f = fileFixture(), screening = researchScreeningFixture(), port = installSelection('seawater study', rows, '1');
    let original: RecordRow | undefined;
    try {
      const result = await recorded(() => withNativeCatalog({}, { sourceOwner: screening.owner }, [f.path], () => rows,
        async (_args, current, options) => { original = current[1]; return selectHarnessCatalog(current, 'seawater study', describeRow, options, 'agent.research.detail.control'); }));
      expect<RecordRow | null | undefined>(result).toBe(original); expect(result?.id).toBe('relevant'); expect(port.requests).toHaveLength(1);
      expect(Object.keys(port.requests[0]?.questions ?? {})).toEqual(['pick', 'fits_0', 'fits_1']);
    } finally { f.close(); }
  });
  test('explicit canonical none preserves the native missing detail boundary', async () => {
    const f = fileFixture(), screening = researchScreeningFixture(), port = installSelection('book a flight', rows, 'none');
    try {
      const result = await recorded(() => withNativeCatalog({}, { sourceOwner: screening.owner }, [f.path], () => rows,
        (_args, current, options) => selectHarnessCatalog(current, 'book a flight', describeRow, options, 'agent.research.detail.control')));
      expect(result).toBeNull(); expect(port.requests).toHaveLength(1);
    } finally { f.close(); }
  });
  test('uncertain detail choice cannot become a first matching row', async () => {
    const f = fileFixture(), screening = researchScreeningFixture(); installSelection('study', rows, '1', 0.5);
    try {
      await expect(recorded(() => withNativeCatalog({}, { sourceOwner: screening.owner }, [f.path], () => rows,
        (_args, current, options) => selectHarnessCatalog(current, 'study', describeRow, options, 'agent.research.detail.control')))).rejects.toBeInstanceOf(ToolInputProjectionError);
    } finally { f.close(); }
  });
  test('live caller revocation during a canonical reading prevents publication', async () => {
    const f = fileFixture(), screening = researchScreeningFixture(); let current = true, published = false;
    const port = fakePort((name, question, state) => {
      if (name !== 'match' || JSON.stringify(question) !== JSON.stringify(rankQuestion) || JSON.stringify(state) !== JSON.stringify({ query: 'study', candidate: {
        type: 'tool', name: rows[0]?.id, description: rows[0]?.title, evidenceJson: JSON.stringify(rows[0]),
      } })) throw new Error('Unexpected complete revocation request');
      current = false; return noulAnswer(0.99);
    });
    installJudgmentPort(port.port);
    try {
      await expect(recorded(() => withNativeCatalog({}, { sourceOwner: screening.owner, assertCurrent: () => { if (!current) throw new Error('Synthetic native permission retired'); } }, [f.path], () => rows,
        async (_args, source, options) => { const result = await rankResearchRecords(source, 'study', describeRow, options, 'agent.research.revocation.control'); published = true; return result; }))).rejects.toThrow();
      expect(published).toBe(false); expect(port.requests).toHaveLength(1);
    } finally { f.close(); }
  });
  test('unsettled candidate holds the complete result', async () => {
    const f = fileFixture(), screening = researchScreeningFixture(); installRanks('ocean chemistry', rows, [0.5, 0.99]);
    try { await expect(recorded(() => withNativeCatalog({}, { sourceOwner: screening.owner }, [f.path], () => rows,
      (_args, current, options) => rankResearchRecords(current, 'ocean chemistry', describeRow, options, 'agent.research.control')))).rejects.toBeInstanceOf(ToolInputProjectionError); }
    finally { f.close(); }
  });
  test('native same-byte file replacement while screening waits refuses publication', async () => {
    const f = fileFixture(); let consumed = false, replaced = false;
    const screening = researchScreeningFixture({ beforeProposal: async () => {
      if (!replaced) { replaced = true; const next = `${f.path}.replacement`; writeFileSync(next, readFileSync(f.path)); renameSync(next, f.path); }
    } });
    try { await expect(withNativeCatalog({}, { sourceOwner: screening.owner }, [f.path], () => rows,
      async () => { consumed = true; return rows; })).rejects.toThrow(); expect(consumed).toBe(false); }
    finally { f.close(); }
  });
  test('unselected raw file PAN is refused before any semantic wire', async () => {
    const f = fileFixture(), screening = researchScreeningFixture(); let consumed = false;
    const port = installRanks('ocean chemistry', rows, [0.01, 0.99]);
    writeFileSync(f.path, JSON.stringify({ rows, privateUnknown: '4111 1111 1111 1111' }));
    try { await expect(withNativeCatalog({}, { sourceOwner: screening.owner }, [f.path], () => rows,
      async () => { consumed = true; return rows; })).rejects.toThrow(); expect(consumed).toBe(false); expect(port.requests).toHaveLength(0); expect(screening.calls).toHaveLength(0); }
    finally { f.close(); }
  });
  test('redacted raw file holes cannot be returned by an exact native no-query read', async () => {
    const f = fileFixture(); let consumed = false;
    writeFileSync(f.path, JSON.stringify({ rows, unknownSecret: 'synthetic-protected-value' }));
    const screening = researchScreeningFixture({ spans: exactSensitiveSpans(['synthetic-protected-value']) });
    try { await expect(withNativeCatalog({}, { sourceOwner: screening.owner }, [f.path], () => rows,
      async () => { consumed = true; return rows; })).rejects.toThrow(); expect(consumed).toBe(false); }
    finally { f.close(); }
  });
  test('missing native files stay absent and no-query reads issue no relevance judgment', async () => {
    const f = fileFixture(), screening = researchScreeningFixture(); rmSync(f.path);
    const port = fakePort(() => { throw new Error('Unexpected semantic request for no-query read'); }); installJudgmentPort(port.port);
    try { const result = await withNativeCatalog({}, { sourceOwner: screening.owner }, [f.path], () => ({ status: 'unavailable', rows: [] }), async (_args, current) => current);
      expect(result).toEqual({ status: 'unavailable', rows: [] }); expect(port.requests).toHaveLength(0); }
    finally { f.close(); }
  });
  test('late caller cancellation holds full file publication', async () => {
    const f = fileFixture(), abort = new AbortController(); let consumed = false;
    const screening = researchScreeningFixture({ beforeProposal: async () => { abort.abort(); } });
    try { await expect(withNativeCatalog({}, { sourceOwner: screening.owner, signal: abort.signal }, [f.path], () => rows,
      async () => { consumed = true; return rows; })).rejects.toThrow(); expect(consumed).toBe(false); }
    finally { f.close(); }
  });
  test('a native backend empty snapshot retains its original legacy envelope without invoking extra callbacks', async () => {
    let reads = 0;
    const backend = { getSnapshot: () => { reads++; return []; }, status: 'idle' }, screening = researchScreeningFixture();
    const result = await researchLiveReadModelSnapshot({ platform: { readModels: { research: { browserRuns: backend } } } }, { sourceOwner: screening.owner });
    expect(reads).toBe(1); expect(result.browserRunnerRecords).toHaveLength(1);
    expect(result.browserRunnerRecords[0]?.status).toBe('idle'); expect(result.browserRunnerRecords[0]?.certification.schemaStatus).toBe('legacy');
  });
  test('live return getter is refused without invoking it', async () => {
    let getterCalls = 0; const row: Record<string, unknown> = { id: 'live-getter' };
    Object.defineProperty(row, 'hidden', { get() { getterCalls++; return 'private'; } });
    const screening = researchScreeningFixture();
    await expect(researchLiveReadModelSnapshot({ platform: { readModels: { research: { browserRuns: [row] } } } }, { sourceOwner: screening.owner })).rejects.toThrow();
    expect(getterCalls).toBe(0); expect(screening.calls).toHaveLength(0);
  });
  test('live backend method accessor replacement refuses without invoking the getter', async () => {
    const entered = deferred<void>(), held = deferred<unknown>(); let getterCalls = 0;
    const original = () => { entered.resolve(); return held.promise; };
    const backend = { getSnapshot: original }, screening = researchScreeningFixture();
    const result = researchLiveReadModelSnapshot({ platform: { readModels: { research: { browserRuns: backend } } } }, { sourceOwner: screening.owner });
    const outcome = result.then(value => ({ value }), error => ({ error }));
    try {
      await awaitNativeEntry(entered.promise, outcome); Object.defineProperty(backend, 'getSnapshot', { get() { getterCalls++; return original; }, configurable: true });
      held.resolve({ records: [] }); const settled = await outcome;
      expect('error' in settled).toBe(true); expect(getterCalls).toBe(0); expect(screening.calls).toHaveLength(0);
    } finally { held.resolve({ records: [] }); await outcome; }
  });
  test('native live Promise respects original signal through returned snapshot', async () => {
    const entered = deferred<void>(), held = deferred<unknown>(), abort = new AbortController();
    const backend = { getSnapshot: () => { entered.resolve(); return held.promise; } }, screening = researchScreeningFixture();
    const result = researchLiveReadModelSnapshot({ platform: { readModels: { research: { browserRuns: backend } } } }, { sourceOwner: screening.owner, signal: abort.signal });
    const outcome = result.then(value => ({ value }), error => ({ error }));
    try {
      await awaitNativeEntry(entered.promise, outcome); abort.abort(); held.resolve({ records: [] });
      expect('error' in await outcome).toBe(true); expect(screening.calls).toHaveLength(0);
    } finally { held.resolve({ records: [] }); await outcome; }
  });
  test('unknown live wrapper-envelope PAN is refused before any screening or relevance wire', async () => {
    const screening = researchScreeningFixture(), port = fakePort(() => { throw new Error('Unexpected private semantic wire'); }); installJudgmentPort(port.port);
    const wrapper = { records: [{ id: 'safe-leaf', status: 'running' }], unknownEnvelope: '4111 1111 1111 1111' };
    await expect(researchLiveReadModelSnapshot({ platform: { readModels: { research: { browserRuns: wrapper } } } }, { sourceOwner: screening.owner })).rejects.toThrow();
    expect(port.requests).toHaveLength(0); expect(screening.calls).toHaveLength(0);
  });
  test('complete live record mutation during screening refuses certification', async () => {
    const row = { id: 'live-original', status: 'running', metadata: { unknown: 'original' } };
    let mutated = false;
    const screening = researchScreeningFixture({ beforeProposal: async () => { if (!mutated) { mutated = true; row.metadata.unknown = 'replacement'; } } });
    await expect(researchLiveReadModelSnapshot({ platform: { readModels: { research: { browserRuns: [row] } } } }, { sourceOwner: screening.owner })).rejects.toThrow();
    expect(mutated).toBe(true);
  });
  test('new async public option guards cannot be replaced during native source acquisition', async () => {
    const entered = deferred<void>(), held = deferred<unknown>(), screening = researchScreeningFixture();
    const options = { sourceOwner: screening.owner, assertCurrent: () => {} };
    const result = researchLiveReadModelSnapshot({ platform: { readModels: { research: { browserRuns: { getSnapshot: () => { entered.resolve(); return held.promise; } } } } } }, options);
    const outcome = result.then(value => ({ value }), error => ({ error }));
    try {
      await awaitNativeEntry(entered.promise, outcome); options.assertCurrent = () => {}; held.resolve({ records: [] });
      expect('error' in await outcome).toBe(true); expect(screening.calls).toHaveLength(0);
    } finally { held.resolve({ records: [] }); await outcome; }
  });
  test('explicit unsettled schema claim stays held without certification', async () => {
    const row = { id: 'schema-held', status: 'running', schemaStatus: 'possibly validated' }, screening = researchScreeningFixture();
    const expectedState = { query: 'Explicit schema certification', candidate: { type: 'tool', name: 'schema', description: 'Explicit schema certification claim', evidenceJson: JSON.stringify({ records: [row, {}, {}, {}, {}, {}, {}], explicit: row.schemaStatus }) } };
    const port = fakePort((name, question, state) => { if (name !== 'match' || JSON.stringify(question) !== JSON.stringify(schemaQuestion) || JSON.stringify(state) !== JSON.stringify(expectedState)) throw new Error('Unexpected complete schema claim'); return noulAnswer(0.5); });
    installJudgmentPort(port.port);
    await expect(recorded(() => researchLiveReadModelSnapshot({ platform: { readModels: { research: { browserRuns: [row] } } } }, { sourceOwner: screening.owner }))).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(port.requests).toHaveLength(1);
  });
  test('uncertain prose still holds even when native publication metadata is complete', async () => {
    const row = { id: 'schema-metadata-held', status: 'running', schemaStatus: 'possibly validated',
      schemaVersion: 'synthetic-v1', publicationGuarantee: 'native synthetic publication', publisher: 'synthetic-host' };
    const screening = researchScreeningFixture();
    const expectedState = { query: 'Explicit schema certification', candidate: { type: 'tool', name: 'schema',
      description: 'Explicit schema certification claim', evidenceJson: JSON.stringify({ records: [row, {}, {}, {}, {}, {}, {}], explicit: row.schemaStatus }) } };
    const port = fakePort((name, question, state) => {
      if (name !== 'match' || JSON.stringify(question) !== JSON.stringify(schemaQuestion) || JSON.stringify(state) !== JSON.stringify(expectedState)) throw new Error('Unexpected complete uncertain native-metadata claim');
      return noulAnswer(0.5);
    });
    installJudgmentPort(port.port);
    await expect(recorded(() => researchLiveReadModelSnapshot({ platform: { readModels: { research: { browserRuns: [row] } } } }, { sourceOwner: screening.owner }))).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(port.requests).toHaveLength(1);
  });
  test('native schema presence remains certified without an invented semantic claim', async () => {
    const screening = researchScreeningFixture(), port = fakePort(() => { throw new Error('Unexpected schema claim judgment'); }); installJudgmentPort(port.port);
    const result = await researchLiveReadModelSnapshot({ platform: { readModels: { research: { browserRuns: [{ id: 'native-presence', status: 'running', schemaVersion: 'synthetic-v1', publicationGuarantee: 'native synthetic publication', publisher: 'synthetic-host' }] } } } }, { sourceOwner: screening.owner });
    expect(result.browserRunnerRecords[0]?.certification.schemaStatus).toBe('certified'); expect(port.requests).toHaveLength(0);
  });
  test('complete native publication metadata preserves original precedence over a settled negative prose claim', async () => {
    const row = { id: 'native-metadata-negative', status: 'running', schemaStatus: 'verification failed',
      schemaVersion: 'synthetic-v1', publicationGuarantee: 'native synthetic publication', publisher: 'synthetic-host' };
    const screening = researchScreeningFixture();
    const expectedState = { query: 'Explicit schema certification', candidate: { type: 'tool', name: 'schema',
      description: 'Explicit schema certification claim', evidenceJson: JSON.stringify({ records: [row, {}, {}, {}, {}, {}, {}], explicit: row.schemaStatus }) } };
    const port = fakePort((name, question, state) => {
      if (name !== 'match' || JSON.stringify(question) !== JSON.stringify(schemaQuestion) || JSON.stringify(state) !== JSON.stringify(expectedState)) throw new Error('Unexpected complete negative native-metadata claim');
      return noulAnswer(0.01);
    });
    installJudgmentPort(port.port);
    const result = await recorded(() => researchLiveReadModelSnapshot({ platform: { readModels: { research: { browserRuns: [row] } } } }, { sourceOwner: screening.owner }));
    expect(result.browserRunnerRecords[0]?.certification.schemaStatus).toBe('certified'); expect(port.requests).toHaveLength(1);
    expect(result.browserRunnerRecords[0]?.certification.publisher).toBe('synthetic-host');
    expect(result.browserRunnerRecords[0]?.certification.missingSignals.length).toBeGreaterThan(0);
  });
  for (const [claim, probability, expected] of [['validated against the published contract', 0.99, 'certified'], ['not certified', 0.01, 'legacy']] satisfies readonly (readonly [string, number, ResearchLiveRecordCertification['schemaStatus']])[]) {
    test(`explicit schema claim uses canonical recorded reading: ${expected}`, async () => {
      const row = { id: 'schema-reading', status: 'running', schemaStatus: claim }, screening = researchScreeningFixture();
      const evidence = { records: [row, {}, {}, {}, {}, {}, {}], explicit: claim };
      const expectedState = { query: 'Explicit schema certification', candidate: { type: 'tool', name: 'schema', description: 'Explicit schema certification claim', evidenceJson: JSON.stringify(evidence) } };
      const port = fakePort((name, question, state) => { if (name !== 'match' || JSON.stringify(question) !== JSON.stringify(schemaQuestion) || JSON.stringify(state) !== JSON.stringify(expectedState)) throw new Error('Unexpected complete schema claim'); return noulAnswer(probability); });
      installJudgmentPort(port.port);
      const result = await recorded(() => researchLiveReadModelSnapshot({ platform: { readModels: { research: { browserRuns: [row] } } } }, { sourceOwner: screening.owner }));
      expect(result.browserRunnerRecords[0]?.certification.schemaStatus).toBe(expected); expect(port.requests).toHaveLength(1);
    });
  }
});
