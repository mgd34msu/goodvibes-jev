# Knowledge repair profile readings (THE-37)

This bounded conversion covers the eight `semantic/repair-profile.ts` decisions recorded in `docs/inventory/engine.md` rows 1947–1954. The scope is the original `goodvibes-jev-intent.md` platform conversion, not a smaller feature or cosmetic change.

## Decisions and representation

Three registered high-stakes batteries replace whole-source concrete-feature matching, broad and category query regexes, canonical-value term tables, wattage-as-audio inference, minimum match counts, low-value cascades, and scrape-word stripping:

- `engine.knowledge.repair-profile-category`: whether the actual query requests each declared profile category
- `engine.knowledge.repair-profile-value`: whether each concrete original source span belongs to that category and supplies useful subject-specific specification information
- `engine.knowledge.repair-profile-support`: whether every selected exact value is fully supported in the complete original source context

The seven existing category titles, kinds, labels, and aliases remain a fixed output vocabulary. They do not establish relevance or feature support. Paragraph/sentence syntax only enumerates candidate spans with exact original offsets. Single newline table labels stay with values unless a complete sentence boundary occurs. No vocabulary regex selects or rewrites canonical values. 4K/8K, counts, watts, negation, and operating-mode qualifications remain verbatim. Every reading sees the full selected source text, including other models, surrounding exceptions, meaningful URLs, and scrape words. No judgment call generates prose.

A settled negative selection excludes a candidate; an explicit negative feature can itself be a positively selected, supported value. Uncertain selection, unavailable/missing ports, malformed answers, changed provider configuration/model, cancellation, or any unsupported selected value holds the entire pass. Caps reject the complete pass instead of truncating candidates or evidence. A port that ignores cancellation cannot keep the pass alive after its timeout.

## Input and persistence boundaries

All selected semantic input, subject identity, source provenance fields and local references are protected before a port is acquired or a request is serialized. Arbitrary source/extraction metadata is not sent. Only the existing in-process, record-bound producer proof can project exact minted source/extraction references. Prefixes, credential-shaped IDs, cloned records, JSON-shaped proof and caller metadata confer no exemption. Original record IDs remain in local caller maps and the existing support receipts.

`deriveRepairProfileFacts` now returns a Promise. The internal batch helper `deriveRepairProfileFactPass` preflights and settles all selected sources together. These are internal modules; no root or declared subpath export changed. The direct callers are:

- `semantic/enrichment.ts`: reads original extractor text before formatting/cleanup, awaits profile decisions and rechecks its existing generation guard before any generated node or semantic-state writes
- `semantic/self-improvement-promotion.ts`: snapshots selected and excluded source/extraction rows, reads the whole pass and rechecks the gap/subject/source guard before preparing writes
- `home-graph/page-profile-facts.ts`: batches selected source readings and rechecks source/extraction/device state before returning a plan

The existing THE-23 field/attachment support and THE-32 prepared activation/operator/provenance write guards remain in force. Profile results do not authorize serving or writing. `isKnowledgeSourceQualityFailure` recognizes the leaf profile-held error so indirect repair orchestration cannot convert an unsettled profile into fallback writes. Existing accepted/rejected operator review survives repeated profiles.

## Verification boundary

Focused fixtures cover negated HDMI/Bluetooth, another model, accessory power versus audio, four ports versus four cables, injection, one concrete display value, exact 4K/8K and active/standby distinctions, table rows and multi-sentence exceptions, complete late protected fields, late unsupported selected fields, missing/unavailable/uncertain/malformed readings, provider changes, abort/time budgets, and real-store write/idempotency/operator-state/provenance behavior. Explicit authored fake readings validate plumbing and persistence, not live model semantics.

Live fixture calibration is THE-35 and is not claimed here. Accumulated integration is THE-34. Query-subject alignment, integration intent, semantic excerpt selection, object-scope inference, shared search scoring, repair sentence ranking, entity/wiki fidelity, and other separately inventoried enrichment decisions remain open scope. This conversion does not close K3 or the platform.

## Required downstream dependency

THE-39 in `knowledge-repair-usefulness.md` removes the repair caller's inherited lexical rejection of these exact profile values. Exact selected source spans are not sent through the separate legacy canonical sentence classifier again; only exact span equality is deduplicated, and distinct unselected spans retain their existing path. A repeated-promotion fixture preserves 120 Hz without creating the old invented 100/120 Hz claim. Concrete source/extraction scope disagreements, including conflicting broad aliases, are rejected before any reading.
