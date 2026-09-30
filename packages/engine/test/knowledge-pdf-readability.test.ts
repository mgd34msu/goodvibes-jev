import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { extractPdf } from '../sdk/src/platform/knowledge/pdf-extractor.js';
import { KnowledgeExtractionJudgmentHoldError } from '../sdk/src/platform/knowledge/extraction-policy.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { pdfTextDecoding } from '../sdk/src/platform/knowledge/batteries/extraction-readability.js';
import { createCompressedPdfBuffer } from './_helpers/homegraph-service-fixtures.js';

let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function rawPdf(content: string, compressed = false): Buffer {
  const bytes = compressed ? deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1');
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${bytes.length}${compressed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1'),
    bytes,
    Buffer.from('\nendstream\nendobj\n%%EOF\n'),
  ]);
}

function textPort(p = 0.99, decoding = 'singleByte', confidence = 0.99) {
  const fake = fakePort((_name, question) => question.type === 'noul'
    ? noulAnswer(p) : choiceAnswer(question, decoding, confidence));
  installJudgmentPort(fake.port);
  return fake;
}

describe('PDF readability and decoding judgments', () => {
  test('empty or image-only PDF content asks nothing and requires OCR rather than guessing', async () => {
    const fake = textPort();
    await expect(extractPdf(createCompressedPdfBuffer(''))).rejects.toThrow('PDF extraction failed');
    await expect(extractPdf(rawPdf('q /Im0 Do Q'))).rejects.toThrow('PDF extraction failed');
    expect(fake.requests).toHaveLength(0);
  });

  test('preserves the pdfjs parser and filters text through the named battery', async () => {
    const fake = textPort();
    const result = await extractPdf(createCompressedPdfBuffer('A readable PDF manual.'));
    expect(result.extractorId).toBe('pdfjs');
    expect(result.structure.searchText).toBe('A readable PDF manual.');
    expect(fake.requests.every((request) => request.context?.battery === 'engine.knowledge.extraction-readability')).toBe(true);
  });

  test('preserves raw-stream inflate, escapes, nesting, deduplication and one-character fragments', async () => {
    textPort();
    const result = await extractPdf(rawPdf('BT (A) Tj (Hello \\(nested\\) \\101) Tj (A) Tj ET', true));
    expect(result.extractorId).toBe('pdf-raw');
    expect(result.structure.searchText).toBe('A\nHello (nested) A');
    expect(result.sections).toEqual(['A', 'Hello (nested) A']);
  });

  test('accepts readable prose explaining PDF tokens instead of treating tokens as binary', async () => {
    textPort();
    const text = 'PDF syntax uses %PDF and 7 0 obj with /Filter /FlateDecode.';
    const result = await extractPdf(rawPdf(`BT (${text}) Tj ET`));
    expect(result.structure.searchText).toBe(text);
  });

  test('honors the UTF-16BE BOM without an encoding guess, then judges readable text', async () => {
    const fake = textPort();
    const result = await extractPdf(rawPdf('BT <FEFF65E5672C> Tj ET'));
    expect(result.structure.searchText).toBe('日本');
    expect(fake.requests.every((request) => request.context?.battery !== pdfTextDecoding.name)).toBe(true);
  });

  test('chooses unmarked UTF-16BE via judgment rather than zero-byte ratios', async () => {
    const fake = textPort(0.99, 'utf16be');
    const result = await extractPdf(rawPdf('BT <65E5672C> Tj ET'));
    expect(result.structure.searchText).toBe('日本');
    expect(fake.requests[0]?.context?.battery).toBe(pdfTextDecoding.name);
    expect(fake.requests[0]?.state).toEqual({ singleByte: 'eåg,', utf16be: '日本' });
  });

  test('retains a single-byte hex label, but rejects malformed odd-byte hex syntax', async () => {
    textPort();
    expect((await extractPdf(rawPdf('BT <41> Tj ET'))).structure.searchText).toBe('A');
    const fake = textPort();
    await expect(extractPdf(rawPdf('BT <4> Tj ET'))).rejects.toThrow('PDF extraction failed');
    expect(fake.requests).toHaveLength(0);
  });

  test('holds on unknown or non-actionable decoding, but a definite neither rejects', async () => {
    for (const [decoding, confidence] of [['unknown', 0.99], ['singleByte', 0.5]] as const) {
      textPort(0.99, decoding, confidence);
      await expect(extractPdf(rawPdf('BT <4142> Tj ET'))).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
    }
    textPort(0.99, 'neither');
    await expect(extractPdf(rawPdf('BT <0001> Tj ET'))).rejects.toThrow('PDF extraction failed');
  });

  test('does not turn a pdfjs judgment hold into raw-parser fallback', async () => {
    const fake = textPort(0.5);
    await expect(extractPdf(createCompressedPdfBuffer('Readable-looking text.'))).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
    expect(fake.requests).toHaveLength(1);
    installJudgmentPort(undefined);
    await expect(extractPdf(createCompressedPdfBuffer('Readable-looking text.'))).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
  });

  test('preflights full decoded candidates before any sample is sent', async () => {
    const fake = textPort();
    await expect(extractPdf(rawPdf(`BT (${ 'Ordinary text. '.repeat(400) }password=synthetic-fixture) Tj ET`))).rejects.toBeInstanceOf(JudgmentInputError);
    const text = 'password=synthetic-fixture';
    const bytes = Buffer.from(text, 'utf16le');
    bytes.swap16();
    await expect(extractPdf(rawPdf(`BT <${bytes.toString('hex')}> Tj ET`))).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });
});
