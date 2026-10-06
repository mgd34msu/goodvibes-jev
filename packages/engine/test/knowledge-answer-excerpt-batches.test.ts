import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { createSemanticWriteGuard } from '../sdk/src/platform/knowledge/semantic/primary-source-plan.js';
import { withAnswerVerificationBudget } from '../sdk/src/platform/knowledge/semantic/answer-verification/budget.js';
import { prepareAnswerSourceExcerptBatches, prepareAnswerSourceExcerpts } from '../sdk/src/platform/knowledge/semantic/answer-excerpts/prepare.js';

let previous: JudgmentPort | undefined;
const roots: string[] = [], spaceId = 'wiki:excerpt-batches', query = 'What features does AC-7 have?';
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function readings(value = 0.99) { const fake = fakePort(() => noulAnswer(value)); installJudgmentPort(fake.port); return fake; }
async function fixture(texts: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-excerpt-batches-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); await store.init();
  const entries = [];
  for (const [index, text] of texts.entries()) {
    const source = await store.upsertSource({ id: `private-source-${index}`, connectorId: 'synthetic', sourceType: 'manual',
      title: `AC-7 reference ${index}`, status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
    const extraction = await store.upsertExtraction({ id: `private-extraction-${index}`, sourceId: source.id,
      extractorId: 'synthetic', format: 'text', excerpt: text, metadata: { knowledgeSpaceId: spaceId } });
    entries.push({ source, extraction, context: 'Original claims and qualifications.' });
  }
  return { store, entries };
}

describe('complete-source excerpt batches', () => {
  test('prepares 32 large decoys before reading only the requested exact original source', async () => {
    const text = 'AC-7: No Bluetooth.';
    const { store, entries } = await fixture([text, ...Array.from({ length: 32 }, () => 'x'.repeat(128 * 1024))]);
    const fake = readings();
    const prepared = prepareAnswerSourceExcerptBatches(store, query, entries, createSemanticWriteGuard(store));
    expect(fake.requests).toHaveLength(0); prepared.start();
    const selected = await prepared.read(new Set([entries[0]!.source.id]));
    expect(selected.size).toBe(1); expect(fake.requests).toHaveLength(1);
    expect(selected.get(entries[0]!.source.id)).toEqual([{ sourceId: entries[0]!.source.id,
      extractionId: entries[0]!.extraction.id, field: 'extraction.excerpt', start: 0, end: text.length, text }]);
    expect(JSON.stringify(fake.requests)).not.toContain('private-source-');
    expect(JSON.stringify(fake.requests)).not.toContain('private-extraction-');
  });
  test('complete source batching preserves merged offsets and cross-field table bundles', async () => {
    const { store, entries } = await fixture(['AC-7: No Bluetooth.', 'AC-7 runs twelve hours.\n\nOnly in standby; active use lasts two hours.']);
    const second = entries[1]!;
    await store.upsertExtraction({ ...second.extraction, excerpt: '', sections: ['Model | Inputs', 'AC-7 | 4', 'Mini variant excluded.'] });
    readings(); const ids = new Set(entries.map((entry) => entry.source.id));
    const old = prepareAnswerSourceExcerpts(store, query, entries, createSemanticWriteGuard(store)); old.start();
    const expected = await old.read(ids);
    const batched = prepareAnswerSourceExcerptBatches(store, query, entries, createSemanticWriteGuard(store)); batched.start();
    const actual = await batched.read(ids);
    expect([...actual]).toEqual([...expected]);
    expect(actual.get(second.source.id)?.map((span) => span.field)).toEqual(['extraction.excerpt', 'extraction.sections[0]', 'extraction.sections[1]', 'extraction.sections[2]']);
    expect(Object.isFrozen(actual.get(second.source.id))).toBe(true);
  });
  test('protected later original content is refused synchronously before any request', async () => {
    const { store, entries } = await fixture(['AC-7 has four inputs.', `${'x'.repeat(128 * 1024)}\nAuthorization: Bearer synthetic-fixture`]);
    const fake = readings();
    expect(() => prepareAnswerSourceExcerptBatches(store, query, entries, createSemanticWriteGuard(store))).toThrow(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });
  test('one source above the unchanged complete-input budget holds without clipping', async () => {
    const { store, entries } = await fixture(['AC-7 has four inputs.', 'x'.repeat(160_000)]); const fake = readings();
    expect(() => prepareAnswerSourceExcerptBatches(store, query, entries, createSemanticWriteGuard(store))).toThrow('budget');
    expect(fake.requests).toHaveLength(0);
  });
  test('cross-source actual and requested model drift holds the complete selection', async () => {
    const { store, entries } = await fixture(['AC-7 has four inputs.', 'AC-7 does not support Bluetooth.']);
    for (const field of ['model', 'requestedModel'] as const) {
      const fake = readings(); let index = 0;
      installJudgmentPort({ ...fake.port, async ask(request) { return { ...await fake.port.ask(request), [field]: `model-${++index}` }; } });
      const prepared = prepareAnswerSourceExcerptBatches(store, query, entries, createSemanticWriteGuard(store)); prepared.start();
      await expect(prepared.read(new Set(entries.map((entry) => entry.source.id)))).rejects.toMatchObject({ reason: 'stale' });
      expect(fake.requests).toHaveLength(2);
    }
  });
  test('same-turn source revocation stops the next actual span dispatch', async () => {
    const { store, entries } = await fixture(['AC-7 has four inputs.\n\nOnly in the European variant.']);
    const fake = readings(); const original = store.getSource(entries[0]!.source.id)!;
    installJudgmentPort({ ...fake.port, async ask(request) {
      (original as { summary?: string }).summary = 'Revoked in the same turn.';
      return fake.port.ask(request);
    } });
    const prepared = prepareAnswerSourceExcerptBatches(store, query, entries, createSemanticWriteGuard(store)); prepared.start();
    await expect(prepared.read(new Set([original.id]))).rejects.toMatchObject({ reason: 'stale' });
    expect(fake.requests).toHaveLength(1);
  });
  test('configuration revocation stops the next actual span dispatch', async () => {
    const { store, entries } = await fixture(['AC-7 has four inputs.\n\nOnly in the European variant.']); const fake = readings();
    installJudgmentPort({ ...fake.port, async ask(request) {
      installJudgmentPort(fakePort(() => noulAnswer(0.99)).port); return fake.port.ask(request);
    } });
    const prepared = prepareAnswerSourceExcerptBatches(store, query, entries, createSemanticWriteGuard(store)); prepared.start();
    await expect(prepared.read(new Set([entries[0]!.source.id]))).rejects.toMatchObject({ reason: 'stale' });
    expect(fake.requests).toHaveLength(1);
  });
  test('a changed excluded source still invalidates the captured all-source pass', async () => {
    const { store, entries } = await fixture(['AC-7 has four inputs.', 'A decoy reference.']); const fake = readings();
    installJudgmentPort({ ...fake.port, async ask(request) {
      (store.getExtractionBySourceId(entries[1]!.source.id)! as { excerpt: string }).excerpt = 'Changed after preparation.';
      return fake.port.ask(request);
    } });
    const prepared = prepareAnswerSourceExcerptBatches(store, query, entries, createSemanticWriteGuard(store)); prepared.start();
    await expect(prepared.read(new Set([entries[0]!.source.id]))).rejects.toMatchObject({ reason: 'stale' });
    expect(fake.requests).toHaveLength(1);
  });
  test('late uncertain or unavailable source readings do not return earlier spans', async () => {
    const { store, entries } = await fixture(['AC-7 has four inputs.', 'AC-7 does not support Bluetooth.']);
    for (const reason of ['unsettled', 'unavailable'] as const) {
      const fake = readings(), uncertain = fakePort(() => noulAnswer(0.6)); let count = 0;
      installJudgmentPort({ ...fake.port, async ask(request) {
        if (++count === 2 && reason === 'unavailable') throw new Error('Synthetic unavailable');
        return count === 2 ? uncertain.port.ask(request) : fake.port.ask(request);
      } });
      const prepared = prepareAnswerSourceExcerptBatches(store, query, entries, createSemanticWriteGuard(store)); prepared.start();
      await expect(prepared.read(new Set(entries.map((entry) => entry.source.id)))).rejects.toMatchObject({ reason });
    }
  });
  test('a shared caller deadline aborts ignored-signal reads without starting a later source', async () => {
    const { store, entries } = await fixture(['AC-7 has four inputs.', 'AC-7 does not support Bluetooth.']);
    const fake = readings(); let active: AbortSignal | undefined, count = 0;
    installJudgmentPort({ ...fake.port, async ask(request) { active = request.signal; count++; return new Promise(() => {}); } });
    await expect(withAnswerVerificationBudget(async (signal) => {
      const prepared = prepareAnswerSourceExcerptBatches(store, query, entries, createSemanticWriteGuard(store, signal), signal); prepared.start();
      return prepared.read(new Set(entries.map((entry) => entry.source.id)));
    }, 30)).rejects.toMatchObject({ reason: 'budget' });
    expect(count).toBe(1); expect(active?.aborted).toBe(true);
  });
  test('an empty source set retains the caller read-set guard without acquiring a port', async () => {
    const { store, entries } = await fixture(['AC-7 has four inputs.']);
    const guard = createSemanticWriteGuard(store); guard.source(entries[0]!.source.id);
    const prepared = prepareAnswerSourceExcerptBatches(store, query, [], guard);
    expect([...await prepared.read(new Set())]).toEqual([]);
    (store.getSource(entries[0]!.source.id)! as { summary?: string }).summary = 'A later correction.';
    expect(() => prepared.assertCurrent()).toThrow('stale');
  });
  test('selection IDs are captured before awaits and settled empty spans stay empty', async () => {
    const { store, entries } = await fixture(['AC-7 has four inputs.', 'AC-7 does not support Bluetooth.']); const fake = readings(0.01);
    const ids = new Set([entries[0]!.source.id]);
    installJudgmentPort({ ...fake.port, async ask(request) { ids.add(entries[1]!.source.id); return fake.port.ask(request); } });
    const prepared = prepareAnswerSourceExcerptBatches(store, query, entries, createSemanticWriteGuard(store)); prepared.start();
    const selected = await prepared.read(ids);
    expect([...selected]).toEqual([[entries[0]!.source.id, []]]); expect(fake.requests).toHaveLength(1);
  });
});
