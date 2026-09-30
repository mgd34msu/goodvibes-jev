import { inflateSync } from 'node:zlib';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { pdfTextDecoding } from './batteries/extraction-readability.js';
import type { KnowledgeExtractionResult } from './extractors.js';
import {
  KNOWLEDGE_MAX_STRUCTURE_SEARCH_TEXT_CHARS,
  KNOWLEDGE_EXTRACTION_SAMPLE_CHARS,
  KnowledgeExtractionJudgmentHoldError,
  hasUsefulKnowledgeExtractionText,
  requireExtractionJudgment,
} from './extraction-policy.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

function cleanText(value: string): string {
  return value
    .replace(/\u0000/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

async function searchTextPayload(value: string): Promise<string | undefined> {
  const cleaned = cleanText(value);
  if (!(await hasUsefulKnowledgeExtractionText(value))) return undefined;
  return cleaned.length <= KNOWLEDGE_MAX_STRUCTURE_SEARCH_TEXT_CHARS
    ? cleaned
    : cleaned.slice(0, KNOWLEDGE_MAX_STRUCTURE_SEARCH_TEXT_CHARS);
}

function estimateTokens(...chunks: Array<string | undefined | null>): number {
  const total = chunks
    .filter((value): value is string => typeof value === 'string')
    .reduce((sum, value) => sum + value.length, 0);
  return Math.max(1, Math.ceil(total / 4));
}

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\n+/)
    .map((line) => line.trim())
    .find(Boolean);
}

function summarizeText(text: string, maxLength = 320): string | undefined {
  const cleaned = cleanText(text);
  if (!cleaned) return undefined;
  if (cleaned.length <= maxLength) return cleaned;
  const sentence = cleaned.match(/^(.{0,320}?[.!?])(?:\s|$)/)?.[1]?.trim();
  return sentence && sentence.length >= 40 ? sentence : `${cleaned.slice(0, maxLength - 1).trim()}...`;
}

function excerptText(text: string, maxLength = 480): string | undefined {
  const cleaned = cleanText(text);
  if (!cleaned) return undefined;
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1).trim()}...`;
}

async function uniqueStrings(values: Iterable<string>, limit = 24): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = cleanText(value);
    if (!trimmed || seen.has(trimmed) || !(await hasUsefulKnowledgeExtractionText(value))) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= limit) break;
  }
  return result;
}

interface PdfJsExtractionAttempt {
  readonly result?: KnowledgeExtractionResult | undefined;
  readonly warning?: string | undefined;
}

interface RawPdfExtractionDiagnostics {
  failedFlateDecodeStreams: number;
  firstFlateDecodeError?: string | undefined;
}

export async function extractPdf(buffer: Buffer): Promise<KnowledgeExtractionResult> {
  const parsed = await extractPdfWithPdfJs(buffer);
  if (parsed.result) return parsed.result;
  const raw = await extractPdfRawStreams(buffer, parsed.warning ? [parsed.warning] : []);
  if (raw) return raw;
  throw new Error('PDF extraction failed: no readable text was extracted. OCR or a dedicated PDF provider may be required.');
}

async function extractPdfWithPdfJs(buffer: Buffer): Promise<PdfJsExtractionAttempt> {
  let pageCount: number;
  const pageTexts: string[] = [];
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
    try {
      const document = await loadingTask.promise;
      pageCount = document.numPages;
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const lines = textContentItemsToLines(content.items);
        if (lines.length > 0) pageTexts.push(lines.join('\n'));
        page.cleanup();
      }
    } finally {
      // The loading task owns teardown in pdfjs 5.x and 6.x.
      await loadingTask.destroy();
    }
  } catch (error) {
    const warning = `PDF.js extraction failed; used raw stream fallback: ${summarizeError(error)}`;
    logger.warn('PDF extraction: pdfjs path failed; trying raw stream extraction', { error: summarizeError(error) });
    return { warning };
  }
  // Parsing fallback is allowed; a judgment outage or uncertain reading is not.
  const uncleaned = pageTexts.join('\n\n');
  assertJudgmentInput(uncleaned);
  const searchText = await searchTextPayload(uncleaned);
  if (!searchText) return {};
  const text = cleanText(uncleaned);
  return {
    result: {
      extractorId: 'pdfjs',
      format: 'pdf',
      title: firstNonEmptyLine(text) ?? 'PDF document',
      summary: summarizeText(text) ?? 'PDF document.',
      excerpt: excerptText(text),
      sections: await uniqueStrings(text.split(/\n+/), 24),
      links: await uniqueStrings(Array.from(text.matchAll(/\bhttps?:\/\/[^\s)]+/g), (match) => match[0]), 50),
      estimatedTokens: estimateTokens(text),
      structure: { pageCount, extractedTextChars: text.length, searchText },
      metadata: { limitations: ['PDF text extraction does not perform OCR for scanned images.'] },
    },
  };
}

function textContentItemsToLines(items: readonly unknown[]): string[] {
  const lines: string[] = [];
  let current = '';
  for (const item of items) {
    const record = unknownRecord(item);
    const text = typeof record.str === 'string' ? record.str : '';
    if (text) current = current ? `${current} ${text}` : text;
    if (record.hasEOL === true && current) {
      lines.push(current);
      current = '';
    }
  }
  if (current) lines.push(current);
  return lines;
}

function unknownRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

async function extractPdfRawStreams(buffer: Buffer, initialWarnings: readonly string[] = []): Promise<KnowledgeExtractionResult | undefined> {
  const body = buffer.toString('latin1');
  const texts: string[] = [];
  const diagnostics: RawPdfExtractionDiagnostics = { failedFlateDecodeStreams: 0 };
  const streamRe = /(<<[\s\S]{0,4096}?>>)\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(body)) !== null) {
    const dictionary = match[1]! ?? '';
    const rawChunk = match[2]! ?? '';
    const chunk = decodePdfStreamChunk(dictionary, rawChunk, diagnostics);
    texts.push(...await extractPdfTextStrings(chunk));
  }
  assertJudgmentInput(texts);
  const readable = await uniqueStrings(texts, 512);
  const combined = readable.slice(0, 64).join('\n');
  const searchable = readable.join('\n');
  const searchText = await searchTextPayload(searchable);
  if (!searchText) return undefined;
  const warnings = [...initialWarnings];
  if (diagnostics.failedFlateDecodeStreams > 0) {
    warnings.push(
      `Failed to inflate ${diagnostics.failedFlateDecodeStreams} FlateDecode PDF stream(s); extracted readable text from remaining streams.`
      + (diagnostics.firstFlateDecodeError ? ` First error: ${diagnostics.firstFlateDecodeError}` : ''),
    );
  }
  return {
    extractorId: 'pdf-raw',
    format: 'pdf',
    title: firstNonEmptyLine(combined) ?? 'PDF document',
    summary: summarizeText(combined) ?? 'PDF document text extracted from raw streams.',
    excerpt: excerptText(combined),
    sections: await uniqueStrings(combined.split(/\n+/), 8),
    links: await uniqueStrings(Array.from(combined.matchAll(/\bhttps?:\/\/[^\s)]+/g), (linkMatch) => linkMatch[0]), 50),
    estimatedTokens: estimateTokens(combined),
    structure: {
      extractedStringCount: texts.length,
      ...(searchText ? { searchText } : {}),
    },
    metadata: {
      limitations: texts.length === 0
        ? ['No readable text streams were found. Complex PDFs need OCR or a dedicated provider.']
        : ['PDF text extraction does not perform OCR for scanned images.'],
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(diagnostics.failedFlateDecodeStreams > 0 ? { failedFlateDecodeStreamCount: diagnostics.failedFlateDecodeStreams } : {}),
    },
  };
}

function decodePdfStreamChunk(
  dictionary: string,
  rawChunk: string,
  diagnostics: RawPdfExtractionDiagnostics,
): string {
  if (!/\/FlateDecode\b/i.test(dictionary)) return rawChunk;
  try {
    return inflateSync(Buffer.from(rawChunk, 'latin1')).toString('latin1');
  } catch (error) {
    diagnostics.failedFlateDecodeStreams += 1;
    diagnostics.firstFlateDecodeError ??= summarizeError(error);
    return '';
  }
}

async function extractPdfTextStrings(chunk: string): Promise<string[]> {
  return [
    ...extractLiteralStrings(chunk),
    ...await extractHexStrings(chunk),
  ];
}

function extractLiteralStrings(chunk: string): string[] {
  const values: string[] = [];
  let index = 0;
  while (index < chunk.length) {
    if (chunk[index] !== '(') {
      index += 1;
      continue;
    }
    const parsed = readPdfLiteralString(chunk, index + 1);
    if (parsed) {
      values.push(parsed.value);
      index = parsed.nextIndex;
    } else {
      index += 1;
    }
  }
  return values;
}

function readPdfLiteralString(chunk: string, start: number): { readonly value: string; readonly nextIndex: number } | undefined {
  let depth = 1;
  let escaped = false;
  let value = '';
  for (let index = start; index < chunk.length; index += 1) {
    const char = chunk[index]!;
    if (escaped) {
      const decoded = decodePdfEscape(char, chunk.slice(index + 1, index + 3));
      value += decoded.value;
      index += decoded.consumed;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '(') {
      depth += 1;
      value += char;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return { value, nextIndex: index + 1 };
      value += char;
      continue;
    }
    value += char;
  }
  return undefined;
}

function decodePdfEscape(char: string, following: string): { readonly value: string; readonly consumed: number } {
  switch (char) {
    case 'n':
      return { value: '\n', consumed: 0 };
    case 'r':
      return { value: '\r', consumed: 0 };
    case 't':
      return { value: '\t', consumed: 0 };
    case 'b':
      return { value: '\b', consumed: 0 };
    case 'f':
      return { value: '\f', consumed: 0 };
    case '(':
    case ')':
    case '\\':
      return { value: char, consumed: 0 };
    default:
      if (/[0-7]/.test(char)) {
        const octal = `${char}${(following.match(/^[0-7]{0,2}/)?.[0] ?? '')}`;
        return { value: String.fromCharCode(Number.parseInt(octal, 8)), consumed: octal.length - 1 };
      }
      return { value: char, consumed: 0 };
  }
}

async function extractHexStrings(chunk: string): Promise<string[]> {
  const values: string[] = [];
  const hexRe = /(?<!<)<([0-9A-Fa-f\s]*)>(?!>)/g;
  let match: RegExpExecArray | null;
  while ((match = hexRe.exec(chunk)) !== null) {
    const text = await decodeHexPdfString(match[1] ?? '');
    if (text) values.push(text);
  }
  return values;
}

async function decodeHexPdfString(value: string): Promise<string | undefined> {
  const hex = value.replace(/\s+/g, '');
  // Preserve the parser's complete-byte rule, not the old two-byte text floor.
  if (hex.length === 0 || hex.length % 2 !== 0) return undefined;
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    if (bytes.length % 2 !== 0) return undefined;
    return decodeUtf16Be(bytes.subarray(2));
  }
  const singleByte = bytes.toString('latin1');
  const utf16be = bytes.length % 2 === 0 ? decodeUtf16Be(bytes) : null;
  // Both full interpretations are inspected before either bounded candidate leaves.
  assertJudgmentInput({ singleByte, utf16be });
  return requireExtractionJudgment(async () => {
    const run = await pdfTextDecoding.run(judgmentPort('knowledge.extraction.pdf-decoding'), {
      singleByte: singleByte.slice(0, KNOWLEDGE_EXTRACTION_SAMPLE_CHARS),
      utf16be: utf16be?.slice(0, KNOWLEDGE_EXTRACTION_SAMPLE_CHARS) ?? null,
    }, { site: 'knowledge.extraction.pdf-decoding' });
    const reading = run.readings.decoding;
    if (reading.outcome !== 'act' || reading.choice === 'unknown' || (reading.choice === 'utf16be' && utf16be === null)) {
      run.recordAction('hold');
      throw new KnowledgeExtractionJudgmentHoldError();
    }
    run.recordAction(reading.choice);
    switch (reading.choice) {
      case 'neither': return undefined;
      case 'utf16be': return utf16be ?? undefined;
      case 'singleByte': return singleByte;
      default: throw new KnowledgeExtractionJudgmentHoldError();
    }
  });
}

function decodeUtf16Be(bytes: Buffer): string {
  const swapped = Buffer.alloc(bytes.length);
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    swapped[index] = bytes[index + 1]!;
    swapped[index + 1] = bytes[index]!;
  }
  return swapped.toString('utf16le');
}
