# THE-20: extraction readability and PDF decoding

## Landed slice

The extraction-policy, PDF-extractor and HTML inventory decisions now use four named,
registered batteries:

- `engine.knowledge.extraction-readability`: readable document text, including
  non-ASCII text, short labels, tables, URLs, and prose about PDF syntax
- `engine.knowledge.pdf-text-decoding`: unmarked single-byte versus UTF-16BE
  decoding, neither readable, or unknown
- `engine.knowledge.html-main-content`: select main document blocks, including
  tables, with one recorded reading per structurally parsed block
- `engine.knowledge.html-document-title`: select among title metadata and headings,
  including none, with an independent fitness check

The registry is `knowledge/extraction/judgment-registry.ts`; existing registry
auto-discovery includes it. Fixtures are synthetic. These fixtures and fake-port
unit tests prove wiring and hold behavior, **not live model accuracy or calibration**.
No System One endpoint was configured for this work.

Removed decisions: the four binary character-ratio thresholds, the minimum
sample-length exception, PDF-token rejection, the PDF 55% ASCII fraction, the
hex-string two-byte text floor, and the zero-byte encoding guess. The exported
`looksBinaryLikeText` and `looksLikeRawPdfPayload` compatibility names now return
asynchronous readings of the same readability battery; they do not retain the
old heuristics. The old threshold constants are no longer public exports.

Version, blank-field, owned-placeholder, PDF grammar, BOM, odd-hex-length,
resource cleanup, deduplication, and output-size checks remain code. Extractor
generation is now 3, so older retained captures can be re-extracted. The 4096
character judgment sample is a transport budget, not a readability threshold.
Full candidate content is preflighted with `assertJudgmentInput` before sampling
or port access. Database ids/timestamps are not part of the readability request.

Uncertain, confirmation-only, missing, failed, malformed, or unrecorded judgments
throw a value-free hold. PDF parser fallback does not swallow these holds.
Home Graph ingestion prepares an extraction before publishing its source, and
its extraction wrapper propagates holds instead of converting them into a
missing extraction and continuing graph writes. Async decisions are awaited in
Home Graph search, repair selection, reindex, service calls, and ingest recompiles.

## Offline verification

The focused tests cover named fixture attribution, multilingual text and tables,
PDF syntax in readable prose, rejection, unknown/unavailable holds, capped wire
samples, protected material after the sample limit, both decoding candidates,
BOM and unmarked UTF-16BE, a one-byte label, parser/inflate/escape behavior,
empty/image-only PDFs, and artifact-preserving older-generation regeneration.
Temporary SQLite tests exercise actual Home Graph ingestion and re-ingestion,
recompile, and reindex under uncertain, missing and failed ports; no knowledge
writes occur and prior source/extraction records and retained artifacts survive.

Existing Home Graph regression suites use an explicit offline plumbing fixture:
the documents supplied by those tests are labelled readable, with exact rejected
samples listed for their garbled-document test. This fixture is not a classifier.

## Regular-ingest hold boundary

Regular URL and artifact ingestion reserve a source identity without writing it,
then extract and judge before creating or replacing a pending source. Finalize
accepts a one-shot prepared token tied to that exact source id, artifact id and
content hash. Preparation verifies the retained bytes against their SHA-256;
consumption checks the current artifact fingerprint, rejects unrecognized,
mismatched or already-consumed tokens, and keeps the actual result private to
the preparation module. No result from another source/artifact can be reused.

Temporary SQLite regressions cover new-source and existing-source holds for both
routes, protected input before port access, preserved retained files, source and
artifact mismatches, a changed fingerprint, one-shot consumption and corrupted
retained bytes. URL tests stub only artifact acquisition; store and extraction
execution are real and all judgment responses are deterministic fake-port data.

## HTML main-content and title selection

Both the optional DOM parser and the lightweight parser now feed the same named
block-selection and title-selection decisions. Mozilla density/keyword article
selection and first-heading title preference are removed. HTML grammar still
supplies blocks, headings, links and explicit author/site metadata. The existing
page-content pattern packs bounded requests; every block must have an actionable
reading before any content is accepted. Title choices use bounded selection
rounds plus the foundation's separate fitness check.

A definite no-content result produces an owned empty-extraction marker. A
confident no-title result leaves the title absent. Neither result falls back to
page boilerplate or the first heading. Unknown, missing and failed readings
propagate through artifact dispatch and both regular and Home Graph ingestion.
The full raw input and decoded block/title candidates are preflighted before
request clipping. The optional DOM parser can still be absent: the compiled
optional-dependency fixture exercises the lightweight parser with the same
strict judgments, without copying or removing installed dependencies.

Offline tests cover non-ASCII tables, later headings, metadata titles, empty
pages, boilerplate-only pages, title lists larger than one request, raw and
entity-encoded protected text, and new/re-ingested SQLite records under all
three hold modes. These are pipeline tests, not live semantic calibration.

## K2 inventory remainder

This slice is not a claim that the entire extraction family is complete:

- `html-readability.ts`: its main-content/title decisions are now migrated;
  structural DOM loading, grammar, deduplication, resource cleanup and caps stay code.
- `ingest-compile.ts`: entity aliases still come from `topKeywords`; this is
  pending the entity-aliasing migration, not a readability decision.
- `extractors.ts`: parser dispatch, format grammar, deterministic display
  prefixes, caps, and parser-failure warnings are PORT in the inventory.
- `ingest-inputs.ts`: input/record presence, connector identifiers, refresh
  limits/status, and HTTP scheme checks are PORT or delegated in the inventory.
  Regular artifact and URL ingest now prepare extraction before publishing a
  pending source. Ordinary parser/fetch failures keep their failed-record path;
  judgment holds preserve both new-source absence and prior indexed records.
- `home-graph/extraction-quality.ts` is the awaited inverse of the readability
  decision; `home-graph/extraction.ts` preserves the structural extraction flow
  with an explicit no-write hold boundary.

Live calibration and entity-aliasing work remain separately tracked.

## Document-only preflight correction

Refresh and search-text preflight now project every complete `searchText`, `text`
and `content` candidate from both structure and metadata, plus excerpt, summary
and sections. Unrelated metadata such as `retrievedAt` never enters the privacy
scan or judgment request. Property descriptors are inspected before reading any
consumed field: accessors are refused without execution, and non-enumerable data
candidates (including section entries) are still checked before the first reading.

Synthetic regressions cover an ordinary epoch value that happens to match a PAN
shape, both with an actionable fake port and with no port, protected text after
the sample limit in later candidates, and accessor refusals with zero getter
invocations and zero requests. Missing judgments still hold normally; no privacy
threshold, full-text check or request budget is relaxed.
