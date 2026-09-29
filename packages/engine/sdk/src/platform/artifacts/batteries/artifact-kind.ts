/**
 * `engine.artifacts.kind`: what kind of content an artifact is, from its
 * media type and file name, when neither says image, audio or video (those
 * are the media type's own top-level registration and stay code). Read by Jev
 * in place of the hand lists types.ts used for data (json, csv, tsv, xml,
 * yaml, spreadsheets), documents (pdf, any text/, word, powerpoint) and
 * archives (zip, gzip, tar), which turned every unlisted type (OpenDocument,
 * RTF, EPUB, 7z, parquet) into a plain file.
 *
 * Band: low stakes. A wrong kind mislabels one artifact's knowledge source
 * type; nothing is refused, deleted or sent. A reading that does not reach
 * act records `file`, the kind that claims no category.
 */
import { defineBattery, oneOf, STAKES_BANDS } from '@goodvibes-jev/judgment';

export const ARTIFACT_KIND_OPTIONS = {
  document: 'Text meant to be read: prose, reports, papers, slides, web pages, notes, books.',
  data: 'Tables, records or structured values: JSON, CSV, spreadsheets, XML or YAML data, database or columnar files.',
  archive: 'A bundle or compressed container of other files.',
  file: 'None of these, or nothing in the type and name tells which.',
} as const;

const view = (mimeType: string, filename: string) => ({ mimeType, filename });

export const artifactKind = defineBattery({
  name: 'engine.artifacts.kind',
  version: 1,
  description: 'Whether an artifact is a document, data, an archive or a plain file, from its media type and file name.',
  accuracyFloor: 0.85,
  items: {
    kind: oneOf(
      'An artifact was stored with media type `mimeType` and file name `filename`. What kind of content is it?',
      ARTIFACT_KIND_OPTIONS,
      STAKES_BANDS.low.confidence,
    ),
  },
  fixtures: [
    { name: 'csv table', state: view('text/csv', 'sales.csv'), expect: { kind: 'data' } },
    { name: 'pdf paper', state: view('application/pdf', 'paper.pdf'), expect: { kind: 'document' } },
    { name: 'zip bundle', state: view('application/zip', 'site.zip'), expect: { kind: 'archive' } },
    { name: 'OpenDocument text', state: view('application/vnd.oasis.opendocument.text', 'minutes.odt'), expect: { kind: 'document' } },
    { name: '7z archive', state: view('application/x-7z-compressed', 'backup.7z'), expect: { kind: 'archive' } },
    { name: 'parquet data', state: view('application/vnd.apache.parquet', 'events.parquet'), expect: { kind: 'data' } },
    { name: 'word file sent as octet-stream', state: view('application/octet-stream', 'report.docx'), expect: { kind: 'document' } },
    { name: 'opaque blob', state: view('application/octet-stream', 'blob.bin'), expect: { kind: 'file' } },
    { name: 'sqlite database', state: view('application/vnd.sqlite3', 'app.db'), expect: { kind: 'data' } },
    { name: 'epub book', state: view('application/epub+zip', 'novel.epub'), expect: { kind: 'document' } },
  ],
});
