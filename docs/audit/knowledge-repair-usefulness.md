# Repair fact usefulness (THE-39)

THE-37 exposed an inherited repair-caller defect: concatenating the title `Smart TV platform and integrations` with a true source statement containing `ATSC tuner support` triggered the furniture/platform safety regex. Seven supported, persisted profile facts were reported as six usable facts. The original rich-source count assertion is retained unchanged.

## Bounded conversion

`engine.knowledge.repair-fact-usefulness` replaces the semantic `isUsableRepairFact` predicate used for repair-subject linking and repair usable-fact counts. It reads the exact fact title, kind, summary, value, evidence, subject, labels and aliases against complete selected source extraction text, source provenance, the actual repair query, and declared subject identity fields. A supported explicit negative specification may be useful. Actual furniture instructions, boilerplate, unrelated subjects and unsupported quantities are negative. Incidental words in the category title and a distant source sentence do not determine usefulness.

Exact active status, fact kind, space, source association and current operator state remain code. All relevant candidate inputs are protected before any port access, serialization, cache lookup or size limit. Arbitrary metadata and database IDs remain local. Source/extraction projection uses the existing record-bound minted-reference mechanism. Whole-pass guards include excluded fact rows, edges, the gap, subjects, source/extraction versions, and missing/existing proposed target rows.

The operation-local reader cache ignores only the request-local opaque reference. Every other semantic input must match exactly; current references are rebound to each returned reading. Configuration and model changes hold the reader. Cached results are never persisted as exemptions or carried to another operation. Input, request, byte, concurrency and wall-time budgets hold instead of clipping or partially returning results.

## Two no-result contexts

- Existing stored candidate: settled `act/no` excludes that fact from the link/count set. Uncertain, malformed, unavailable, unconfigured, aborted or stale decisions hold the complete pass.
- Newly proposed promotion claim: its exact final prepared claim is read after THE-23 support and THE-32 activation preparation, before any promotion writes. A settled no holds the complete proposed batch with `not-useful`, distinct from uncertainty. It is never treated as a successful empty or partial promotion.

The prepared promotion writer remains all-or-none. No invented stored-node or operator-review identity is supplied for proposed claims. The existing promoted-count/completion meaning and target-count rule remain unchanged. Prepared linking adds the usefulness guard inside its existing batch without replacing support, activation or operator guards. Task completion/count writes likewise recheck the final prepared count. Earlier independent completed passes are not rolled back by a later pass hold.

## Verification and remaining scope

Direct fixtures cover the Smart TV/tuner case, actual furniture negatives, unsupported quantities, subject attribution, negative specifications, injection, exact semantic caching/reference rebinding, unknown identity keys, malformed/custom ports, model/configuration drift, complete late protected input, budgets and ignored-abort timeout behavior. Real temporary-store tests cover useful/negative mixed sets, operator-rejected facts, rejected excluded candidates changing after preparation, source/operator changes during a read, unavailable/uncertain pre-link holds, repeated-run counts, and first/late proposed-claim holds with no affected fact, edge or task writes.

Fixtures are explicit authored plumbing readings, not live semantic calibration. THE-35 remains the live calibration gate; THE-34 remains accumulated integration. Repair target-count thresholds, subject/model compatibility ladders, legacy repair sentence classification/ranking, other page/answer usefulness filters, and the other inventoried knowledge decisions remain separate work. No K3 or platform completion is claimed.
