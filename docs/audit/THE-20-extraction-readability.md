# THE-20: extraction readability and PDF decoding

## Landed slice

The extraction-policy and PDF-extractor inventory decisions now use two named,
registered batteries:

- `engine.knowledge.extraction-readability`: readable document text, including
  non-ASCII text, short labels, tables, URLs, and prose about PDF syntax
- `engine.knowledge.pdf-text-decoding`: unmarked single-byte versus UTF-16BE
  decoding, neither readable, or unknown

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
generation is now 2, so older retained captures can be re-extracted. The 4096
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

## K2 inventory remainder

This slice is not a claim that the entire extraction family is complete:

- `html-readability.ts`: main-content block selection still uses the Mozilla
  library's heuristics and title selection still prefers the first heading.
  These require separate candidate-selection judgments.
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

Live calibration and broader K2 main-content/title work remain separately tracked.
