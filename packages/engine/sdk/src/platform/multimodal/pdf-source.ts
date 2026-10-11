/** Local, bounded two-phase PDF admission. No decoding judgment is made here. */
import { inflateSync } from 'node:zlib';
import { assertJudgmentInput, JudgmentInputError } from '../gate/judgment-input.js';
import type { KnowledgeExtractionResult } from '../knowledge/extractors.js';
const MAX_SOURCE_BYTES = 750_000;
const refuse = () => new JudgmentInputError('unsupported-input');

/** Validate stream extents and bound expansion before PDF.js can decompress anything.
 * Unsupported filters/encryption/ambiguous lengths are explicit holds, never partial extraction.
 */
function admitPdfStreams(buffer: Buffer): void {
  if (buffer.length > 8 * 1024 * 1024) throw refuse();
  const body = buffer.toString('latin1');
  if (!body.startsWith('%PDF-') || /\/Encrypt\b/.test(body)) throw refuse();
  let expanded = 0, streams = 0;
  const pattern = /\bstream\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    if (++streams > 256) throw refuse();
    const eol = body.slice(pattern.lastIndex).match(/^(?:\r\n|\n|\r)/);
    if (!eol) throw refuse();
    pattern.lastIndex += eol[0].length;
    const objectStart = body.lastIndexOf(' obj', match.index);
    const dictionary = body.slice(objectStart + 4, match.index).trim();
    if (objectStart < 0 || !dictionary.startsWith('<<') || !dictionary.endsWith('>>')) throw refuse();
    if (/\/[^\s<>[\]()]*#[0-9a-f]{2}/i.test(dictionary) || /\/(?:DecodeParms|F|FFilter|FDecodeParms)\b/.test(dictionary)) throw refuse();
    const lengths = [...dictionary.matchAll(/\/Length\s+(\d+)(?:\s+(\d+)\s+R)?\b/g)];
    if (lengths.length !== 1) throw refuse();
    const length = lengths[0]!;
    let size = Number(length[1]);
    if (length[2] !== undefined) {
      const values = [...body.matchAll(new RegExp(`(?:^|[\\r\\n])${length[1]}\\s+${length[2]}\\s+obj\\s+(\\d+)\\s+endobj\\b`, 'g'))];
      if (values.length !== 1) throw refuse();
      size = Number(values[0]![1]);
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > buffer.length - pattern.lastIndex) throw refuse();
    const start = pattern.lastIndex, end = start + size;
    const terminator = body.slice(end).match(/^\s*endstream\b/);
    if (!terminator) throw refuse();
    const filters = [...dictionary.matchAll(/\/Filter\s*(\[[^\]]*\]|\/[^\s<>[\]()]+)/g)];
    if (filters.length > 1 || [...dictionary.matchAll(/\/Filter\b/g)].length !== filters.length) throw refuse();
    const filter = filters[0]?.[1]?.replace(/[\s[\]]/g, '');
    if (filter !== undefined && filter !== '/FlateDecode') throw refuse();
    let bytes: Buffer;
    try { bytes = filter ? inflateSync(buffer.subarray(start, end), { maxOutputLength: MAX_SOURCE_BYTES - expanded + 1 }) : buffer.subarray(start, end); }
    catch { throw refuse(); }
    // Inline image filters can recursively decompress data inside this stream.
    // They are outside this reader's bounded text-only subset.
    if (/\bBI\b/.test(bytes.toString('latin1'))) throw refuse();
    assertJudgmentInput(bytes.toString('utf-8'));
    expanded += bytes.length;
    if (expanded > MAX_SOURCE_BYTES) throw refuse();
    pattern.lastIndex = end + terminator[0].length;
  }
}

export async function readMultimodalPdf(buffer: Buffer, assertCurrent: () => void): Promise<{ source: string; extraction: KnowledgeExtractionResult }> {
  assertCurrent();
  // Encoded PDF syntax (including xref offsets) is structural, not semantic input.
  // Every decoded stream, page and metadata field is screened below.
  admitPdfStreams(buffer);
  const pages: string[] = [];
  let count = 0, chars = 0;
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    assertCurrent();
    const task = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: false, isEvalSupported: false, maxImageSize: MAX_SOURCE_BYTES, stopAtErrors: true });
    try {
      const document = await task.promise;
      assertCurrent();
      const metadata = await document.getMetadata();
      assertCurrent();
      assertJudgmentInput({ info: metadata.info, metadata: metadata.metadata?.getAll() });
      count = document.numPages;
      if (count > 64) throw refuse();
      for (let number = 1; number <= count; number++) {
        assertCurrent();
        const page = await document.getPage(number);
        try {
          const content = await page.getTextContent();
          assertCurrent();
          const text = content.items.map(item => 'str' in item ? item.str : '').join(' ');
          chars += text.length;
          if (chars > MAX_SOURCE_BYTES) throw refuse();
          pages.push(text);
        } finally { page.cleanup(); }
      }
    } finally { await task.destroy(); }
  } catch { assertCurrent(); throw refuse(); }
  const source = pages.join('\n\n');
  // All pages are local and complete before the first hosted reading.
  assertJudgmentInput(source);
  if (!source.trim()) throw new Error('PDF extraction failed: no text was extracted. OCR or a dedicated PDF provider is required.');
  assertCurrent();
  return { source, extraction: { extractorId: 'pdfjs', format: 'pdf',
    title: source.split('\n').find(line => line.trim())?.slice(0, 320),
    summary: source.slice(0, 320), excerpt: source.slice(0, 480), sections: pages.slice(0, 12), links: [],
    estimatedTokens: Math.ceil(source.length / 4), structure: { pageCount: count, extractedTextChars: source.length },
    metadata: { limitations: ['PDF text extraction does not perform OCR for scanned images.'] },
  } };
}
