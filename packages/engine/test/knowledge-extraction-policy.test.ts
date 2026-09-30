import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import {
  KNOWLEDGE_EXTRACTOR_VERSION,
  KNOWLEDGE_EXTRACTION_SAMPLE_CHARS,
  KnowledgeExtractionJudgmentHoldError,
  assertKnowledgeExtractionInput,
  hasUsefulKnowledgeExtractionText,
  knowledgeExtractionNeedsRefresh,
  looksBinaryLikeText,
  looksLikeRawPdfPayload,
  readKnowledgeSearchText,
} from '../sdk/src/platform/knowledge/extraction-policy.js';
import { extractionReadability, pdfTextDecoding } from '../sdk/src/platform/knowledge/batteries/extraction-readability.js';
import { registry } from '../sdk/src/platform/knowledge/extraction/judgment-registry.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import type { KnowledgeExtractionRecord } from '../sdk/src/platform/knowledge/types.js';

let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function answer(p: number) {
  const fake = fakePort(() => noulAnswer(p));
  installJudgmentPort(fake.port);
  return fake;
}

function extraction(overrides: Partial<KnowledgeExtractionRecord>): KnowledgeExtractionRecord {
  return {
    id: 'extract-test', sourceId: 'source-test', extractorId: 'pdfjs', format: 'pdf',
    sections: [], links: [], estimatedTokens: 1, structure: {},
    metadata: { extractorVersion: KNOWLEDGE_EXTRACTOR_VERSION }, createdAt: 1, updatedAt: 1,
    ...overrides,
  };
}

describe('knowledge extraction refresh policy', () => {
  test('registers both decisions and runs the synthetic labelled readability fixtures', async () => {
    expect(registry.list()).toContain(extractionReadability);
    expect(registry.list()).toContain(pdfTextDecoding);
    for (const fixture of extractionReadability.fixtures) {
      const sample = (fixture.state as { sample: string }).sample;
      const fake = answer(fixture.expect.readable === 'yes' ? 0.99 : 0.01);
      expect(await hasUsefulKnowledgeExtractionText(sample)).toBe(fixture.expect.readable === 'yes');
      expect(fake.requests[0]?.context?.battery).toBe(extractionReadability.name);
      expect(fake.requests[0]?.context?.site).toBe('knowledge.extraction.readability');
    }
  });

  test('keeps useful records and structured search text only on an actionable yes', async () => {
    answer(0.99);
    expect(await knowledgeExtractionNeedsRefresh(extraction({ summary: 'The display supports HDMI eARC.' }))).toBe(false);
    expect(await knowledgeExtractionNeedsRefresh(extraction({ structure: { searchText: '仕様と設置手順' } }))).toBe(false);
    expect(await readKnowledgeSearchText({ text: 'A' })).toBe('A');
  });

  test('refreshes unreadable fields only on an actionable no', async () => {
    answer(0.01);
    expect(await knowledgeExtractionNeedsRefresh(extraction({ summary: 'Decoding noise', sections: ['Noise'] }))).toBe(true);
    expect(await looksBinaryLikeText('Even plain prose follows the fake reading.')).toBe(true);
    expect(await looksLikeRawPdfPayload('Not a syntax heuristic.')).toBe(true);
  });

  test('blank fields, owned placeholders, missing records and old versions stay deterministic', async () => {
    installJudgmentPort(undefined);
    expect(await hasUsefulKnowledgeExtractionText(' \n ')).toBe(false);
    expect(await knowledgeExtractionNeedsRefresh(null)).toBe(true);
    expect(await knowledgeExtractionNeedsRefresh(extraction({ summary: 'PDF extraction produced limited text; OCR is not used in-core.' }))).toBe(true);
    expect(await knowledgeExtractionNeedsRefresh(extraction({ summary: 'Legacy text', metadata: {} }))).toBe(true);
    expect(await knowledgeExtractionNeedsRefresh(extraction({ summary: 'Current text' }), KNOWLEDGE_EXTRACTOR_VERSION + 1)).toBe(true);
  });

  test('holds on uncertain, confirmation-only, unavailable and missing judgments', async () => {
    for (const p of [0.5, 0.7, 0.3]) {
      answer(p);
      await expect(knowledgeExtractionNeedsRefresh(extraction({ summary: 'Readable-looking text' }))).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
    }
    const unavailable = fakePort(() => { throw new Error('offline fixture'); });
    installJudgmentPort(unavailable.port);
    await expect(hasUsefulKnowledgeExtractionText('Text')).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
    installJudgmentPort(undefined);
    await expect(hasUsefulKnowledgeExtractionText('Text')).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
  });

  test('bounds requests but scans the full input and every record field before port access', async () => {
    const fake = answer(0.99);
    const long = 'Readable text. '.repeat(1_000);
    expect(await hasUsefulKnowledgeExtractionText(long)).toBe(true);
    expect((fake.requests[0]?.state as { sample: string }).sample).toHaveLength(KNOWLEDGE_EXTRACTION_SAMPLE_CHARS);
    const calls = fake.requests.length;
    for (const text of [`${long} password=synthetic-fixture`, `${long} 4111 1111 1111 1111`]) {
      await expect(hasUsefulKnowledgeExtractionText(text)).rejects.toBeInstanceOf(JudgmentInputError);
    }
    await expect(knowledgeExtractionNeedsRefresh(extraction({ structure: { searchText: 'First field is readable' }, summary: 'apiKey=synthetic-fixture' }))).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(calls);
    installJudgmentPort(undefined);
    await expect(hasUsefulKnowledgeExtractionText('password=synthetic-fixture')).rejects.toBeInstanceOf(JudgmentInputError);
  });

  test('omits unrelated epoch bookkeeping from preflight and readings, including without a port', async () => {
    const text = 'Readable document text.';
    const metadata = { extractorVersion: KNOWLEDGE_EXTRACTOR_VERSION, retrievedAt: 1790726400000 };
    const record = extraction({ structure: { searchText: text, retrievedAt: metadata.retrievedAt }, metadata });
    const fake = answer(0.99);
    expect(await knowledgeExtractionNeedsRefresh(record)).toBe(false);
    expect(await readKnowledgeSearchText({ ...metadata, text })).toBe(text);
    expect(fake.requests.map((request) => request.state)).toEqual([{ sample: text }, { sample: text }]);
    installJudgmentPort(undefined);
    // Missing judgment still holds, but irrelevant metadata is not a privacy refusal.
    await expect(knowledgeExtractionNeedsRefresh(record)).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
    await expect(readKnowledgeSearchText({ ...metadata, text })).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
  });

  test('preflights every full later text candidate before any earlier readable field starts a request', async () => {
    const fake = answer(0.99);
    const protectedTail = `${'Ordinary text. '.repeat(1_000)} apiKey=synthetic-fixture`;
    for (const field of ['searchText', 'text', 'content']) {
      for (const container of ['structure', 'metadata'] as const) {
        const record = extraction({ structure: { searchText: 'First field is readable' } });
        Object.defineProperty(record[container], field, { value: protectedTail });
        await expect(knowledgeExtractionNeedsRefresh(record)).rejects.toBeInstanceOf(JudgmentInputError);
      }
      await expect(readKnowledgeSearchText({ searchText: 'Earlier text', [field]: protectedTail })).rejects.toBeInstanceOf(JudgmentInputError);
    }
    for (const overrides of [{ excerpt: protectedTail }, { summary: protectedTail }, { sections: ['Safe section', protectedTail] }]) {
      await expect(knowledgeExtractionNeedsRefresh(extraction({ structure: { searchText: 'Earlier text' }, ...overrides }))).rejects.toBeInstanceOf(JudgmentInputError);
    }
    const hiddenSection = ['Safe section'];
    Object.defineProperty(hiddenSection, 1, { value: protectedTail });
    await expect(knowledgeExtractionNeedsRefresh(extraction({ summary: 'Earlier text', sections: hiddenSection }))).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
    installJudgmentPort(undefined);
    await expect(readKnowledgeSearchText({ searchText: 'Earlier text', content: protectedTail })).rejects.toBeInstanceOf(JudgmentInputError);
  });

  test('refuses consumed accessors without invoking them and ignores unrelated metadata accessors', async () => {
    const fake = answer(0.99);
    let invoked = 0;
    const getter = { get() { invoked += 1; return 'Getter must not execute'; } };
    for (const field of ['structure', 'metadata', 'excerpt', 'summary', 'sections'] as const) {
      const record = extraction({ structure: { searchText: 'Readable first field' } });
      Object.defineProperty(record, field, getter);
      await expect(knowledgeExtractionNeedsRefresh(record)).rejects.toBeInstanceOf(JudgmentInputError);
      expect(() => assertKnowledgeExtractionInput(record)).toThrow(JudgmentInputError);
    }
    for (const container of ['structure', 'metadata'] as const) {
      for (const field of ['searchText', 'text', 'content']) {
        const record = extraction({ structure: { searchText: 'Readable first field' } });
        Object.defineProperty(record[container], field, getter);
        await expect(knowledgeExtractionNeedsRefresh(record)).rejects.toBeInstanceOf(JudgmentInputError);
        await expect(readKnowledgeSearchText(record[container])).rejects.toBeInstanceOf(JudgmentInputError);
      }
    }
    const sections = ['Safe section'];
    Object.defineProperty(sections, 1, getter);
    await expect(knowledgeExtractionNeedsRefresh(extraction({ summary: 'Readable first field', sections }))).rejects.toBeInstanceOf(JudgmentInputError);
    expect(invoked).toBe(0);
    expect(fake.requests).toHaveLength(0);
    const record = extraction({ summary: 'Ordinary document summary' });
    Object.defineProperty(record.metadata, 'retrievedAt', getter);
    expect(await knowledgeExtractionNeedsRefresh(record)).toBe(false);
    expect(invoked).toBe(0);
  });
});
