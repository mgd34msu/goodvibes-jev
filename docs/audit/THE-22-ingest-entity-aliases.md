# THE-22: structured ingest entity aliases

## Closed decision

Inventory row `sdk/src/platform/knowledge/ingest-compile.ts:337` previously
assigned the same four `topKeywords` to every structured entity. Token frequency,
minimum word length and a stopword list no longer decide entity aliases at this
site. `engine.knowledge.entity-alias`, version 1, is a registered yes/no battery
with labelled synthetic fixtures. Each candidate must be an actionable yes for
the particular entity. No reading is inferred from matching words or popularity.

Structured entity discovery remains deterministic: exact supported tag prefixes,
metadata keys, the repository-source title rule, the existing eight-values-per-kind
cap, original node kind/title/slug, source relationships and provenance are
preserved. No identifiers are invented by the judgment. Existing domain, topic,
folder, section and URL relationships keep their original rules.

## Input and work boundaries

- The only judgment data is the entity kind/title, a lexical candidate, and a
  bounded sample of the existing source title/summary and extraction summary/sections
- All complete prospective text, all participating entity identities, joined
  evidence and every complete request are checked by `assertJudgmentInput` before
  the first request; the original text is checked before any transport clipping
- Unrelated metadata, credential fields, source provenance and artifact bytes are
  neither sampled nor forwarded
- Word boundaries nominate candidates in document order with exact spelling,
  including one-character words and non-Latin names. There is no frequency sort,
  stopword list, semantic token-length floor, or heuristic fallback
- At most 16 candidate words per entity, 128 requests per compile, 4,096 evidence
  characters per request, and four retained aliases per entity. Candidate capacity
  is shared equally across the entity count. Words over 128 characters are outside
  the transport budget, and names over 512 characters explicitly hold rather than
  sending an altered entity identity. A word crossing the evidence boundary is
  never synthesized into a truncated candidate
- These limits bound work and transport. They do not assert which candidate is
  semantically an alias; each retained alias still needs its own actionable reading

## Mutation and holds

Alias preparation finishes before `compileKnowledgeSource` writes any graph
nodes or edges, and before the standalone structured-entity compiler writes any
entities. A missing/unavailable port, malformed response, uncertain result or
confirmation-band result throws a value-free `KnowledgeEntityAliasHoldError`.
There is no partial alias result or old-keyword fallback, and existing graph
records are untouched by a held compile. An empty candidate set needs no reading.

This is a graph compilation boundary. It does not change the upstream ingestion
source/extraction persistence lifecycle or classify all source-ingestion failures
as extraction holds. It also does not migrate other `topKeywords` consumers.

## Verification

`knowledge-entity-alias-judgment.test.ts` exercises the registered fixture labels
with a deterministic port; per-entity aliases; frequent non-alias words; exact
identifier/provenance preservation; multilingual and one-character candidates;
no, confirm, uncertain, missing, unavailable and malformed results; late-batch
holds on both new and existing graphs; protected text beyond request samples;
later protected identities; request and text budgets; and empty/exact cases.
Existing `knowledge-ingest-compile.test.ts` assertions are unchanged.

These are deterministic control-flow and fixture-contract checks, not live
calibration. Live calibration of the battery still requires the configured
System One port and honest recorded results.
