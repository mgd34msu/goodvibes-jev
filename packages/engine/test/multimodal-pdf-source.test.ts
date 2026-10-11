import { expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { readMultimodalPdf } from '../sdk/src/platform/multimodal/pdf-source.js';

function pdf(text: string, commands?: string, title?: string): Buffer {
  const stream = deflateSync(Buffer.from(commands ?? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`));
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n${stream.toString('latin1')}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  if (title !== undefined) objects.push(`<< /Title (${title}) >>`);
  let body = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body, 'latin1')); body += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${title !== undefined ? ' /Info 6 0 R' : ''} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

test('ordinary compressed PDF text is fully local before entity judgment admission', async () => {
  const result = await readMultimodalPdf(pdf('AI EU receipt'), () => {});
  expect(result.source).toContain('AI EU receipt'); expect(result.extraction.format).toBe('pdf');
});

test('compressed late credentials, excessive expansion and malformed lengths hold without decoding models', async () => {
  await expect(readMultimodalPdf(pdf(`${'safe '.repeat(1_000)}password=late-credential`), () => {})).rejects.toThrow('Refused before judgment');
  await expect(readMultimodalPdf(pdf('safe '.repeat(200_000)), () => {})).rejects.toThrow('bounded plain JSON');
  const broken = Buffer.from(pdf('AI').toString('latin1').replace(/\/Length \d+/, '/Length 99999999'), 'latin1');
  await expect(readMultimodalPdf(broken, () => {})).rejects.toThrow('bounded plain JSON');
});

for (const filter of ['/Filter 7 0 R', '/F#69lter /FlateDecode', '/Filter null', '/Filter /FlateDecode /DecodeParms 7 0 R']) {
  test(`PDF stream admission rejects unbounded filter syntax: ${filter}`, async () => {
    const bytes = Buffer.from(pdf('safe '.repeat(200_000)).toString('latin1').replace('/Filter /FlateDecode', filter), 'latin1');
    await expect(readMultimodalPdf(bytes, () => {})).rejects.toThrow('bounded plain JSON');
  });
}
test('unrecognized stream delimiters and empty text cannot become successful PDF analysis', async () => {
  const malformed = Buffer.from(pdf('AI').toString('latin1').replace('\nstream\n', '\nstream \n'), 'latin1');
  await expect(readMultimodalPdf(malformed, () => {})).rejects.toThrow('bounded plain JSON');
  await expect(readMultimodalPdf(pdf(''), () => {})).rejects.toThrow('OCR');
});

test('inline image filters cannot recursively decompress outside the ordinary-stream budget', async () => {
  const bytes = pdf('', 'q BI /W 1 /H 1 /BPC 8 /F /Fl ID hostile EI Q');
  await expect(readMultimodalPdf(bytes, () => {})).rejects.toThrow('bounded plain JSON');
});

test('decoded PDF metadata and real numeric content remain privacy screened', async () => {
  await expect(readMultimodalPdf(pdf('AI', undefined, 'password=metadata-credential'), () => {})).rejects.toThrow('Refused before judgment');
  await expect(readMultimodalPdf(pdf('4111 1111 1111 1111'), () => {})).rejects.toThrow('payment card');
});
