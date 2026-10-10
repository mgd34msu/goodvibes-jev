# Gemini response identity

`ChatResponse.responseIdentity` is optional. Gemini populates it for a completed
successful adapter attempt. Other adapters may omit it. This is diagnostic
provenance, not routing authority, policy evidence, independent hosting
attestation, or a durable proof of every call in a run.

- `requested.provider`, `requested.adapterKind`, and `requested.model` describe
  the actual adapter request. The model is the original requested identifier,
  not a claim about which model served it. A synthetic wrapper preserves this
  backend response unchanged; it does not replace it with its own alias. The
  requested primitives are snapshotted when the accumulator is created.
- `source: 'provider-reported'` labels the provenance of `modelVersion` and
  `responseId`. Google supplies these fields in its SSE response JSON.
- Each field is `missing`, `observed` with a `value`, or `rejected` with
  `invalid` and/or `conflicting` reasons. A response ID alone is not model
  identity evidence. Missing model versions are never filled from a request.
- Accepted wire values are 1–512 printable, non-whitespace ASCII characters.
  Values are neither trimmed nor truncated. Null, wrong types, controls,
  whitespace, non-ASCII and oversized values are rejected conservatively.
  Rejected raw values and full response objects are not retained in identity.
- Every parsed SSE chunk is considered, including metadata-only chunks and the
  final line without a newline. Omission between chunks is normal. Repeated
  identical values are accepted. Differing valid values mark a conflict;
  subsequent values cannot repair an invalid field or overwrite a conflict.
  Both rejection reasons are retained if both occur.
- `hasUnparsedDataChunks` is true if any SSE data chunk failed JSON parsing.
  Existing warnings and skipped-chunk behavior are preserved. Observed valid
  fields remain available, but consistency across a parse gap is unknown; the
  flag does not claim either identity field itself contained an invalid value.
  This is successful-response diagnostic evidence, not complete wire proof.
- Each actual retry starts fresh inside the existing retry callback. Concurrent
  calls on the same provider have independent accumulators. No failed-attempt
  ledger is created and the reporter's global `UNOBSERVED` remains unchanged.

The change does not alter content, usage, stop reasons, retry admission, model
selection, provider family classification, or privacy rules. Tests use fake
fetch/SSE only; no live calls or credentials are required.
