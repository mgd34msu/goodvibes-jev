# Answer linked-object alignment and integration intent (THE-38)

## Contract and bounded replacement

The semantic answer input's `linkedObjects` are current local context candidates.
The Home Graph caller builds them from its search results; there is no explicit
selected-target or operator-authority field. Their exact caller association is
retained, but it cannot force the relevance reader to accept an object. A
supplied local candidate must match the current complete row. Foreign,
inactive, generated and non-object rows do not become eligible through caller
JSON. This reader never changes records, review state or permissions.

`answer-object-alignment/prepare.ts` builds a synchronous prepared read-set before
initial evidence selection can contact a semantic port. It includes the current
scoped object universe, caller context, extension declarations, source/node
records and pertinent graph state. The answer's ordinary and no-evidence paths
await the same prepared selection. A settled empty selection stays empty; neither
caller context nor the former fallback filtering can repopulate it. Existing
query-to-gap policy can still create a subjectless gap; the alignment reading does
not grant gap, serving or operator authority.

The converted answer path no longer calls generic-token removal,
`inferAnswerObjectScope`, `canonicalRepairSubjectNodes`, model-name pattern tests,
fixed object-kind preference or the integration-query regex. Exact core object
kinds and extension-declared `subjectKinds` determine candidate membership. The
Home Assistant namespace uses the exact built-in Home Graph extension declaration
so standalone semantic-service callers retain their existing object vocabulary;
custom declarations remain additive. No Home Graph heuristic consumer is called;
concrete physical/logical identity, integration identity and question alignment
are readings. Fact/wiki/gap/generated projections, inactive rows and foreign
spaces are excluded structurally. Broad Home Assistant requests retain their
existing namespace scope; relations and subject references must still agree on
their actual concrete space.

`engine.knowledge.answer-integration-intent` reads the full question with the
candidate set. `engine.knowledge.answer-object-alignment` reads each candidate
with the entire set so that singular ambiguity, plural questions, variants and
semantic paraphrases are visible. No kind-name substring selects or suppresses
an integration. Selection requires settled concrete-object and alignment yes,
and either settled non-integration identity or settled integration intent yes.
All readings must settle at act; no, uncertain, unavailable/unconfigured,
malformed, stale, cancelled and budget-held outcomes remain distinct. There is no
heuristic fallback. Ordering uses the actual alignment probability, with stable
local order for ties, without converting to legacy points or answer confidence.

## Protected input and provenance

Full title, summary, aliases and the selected semantic metadata are protected
before serialization, character budgets or the first answer request. Identity
includes model/manufacturer/variant, subject and target-hint meaning, and the
Home Assistant identity fields used downstream. Complete structured values are
scanned before JSON conversion. The shared answer fact-claim projection also
includes subject aliases and the string model/manufacturer values consumed by
`answer-verification/evidence.ts`, including provenance-only subjects outside the
object candidate set and a strict source-only window. Non-string unused
model/manufacturer metadata remains omitted. This adds THE-21/THE-38 preflight
consumer coverage without changing evidence ranking or eligibility. A protected
later alias or model holds the whole
answer before initial evidence requests. Arbitrary administrative metadata,
database timestamps and bookkeeping node/source/edge IDs are not transmitted.

Request-local object/context references map to exact current store records.
Actual local target records can prove a particular target-hint ID is a structural
reference; unknown IDs remain subject to ordinary protected-input checks. This is
not a prefix exemption, blanket `id` exemption or a caller-supplied capability.
Original IDs, caller membership, source/node evidence references, fact membership
and exact graph edges are retained locally as provenance. No record is rewritten.

The prepared read-set is checked after semantic awaits and before dependent
answer generation or gap preparation, and its guard is carried to the existing
gap write entry. Candidate changes, operator metadata, graph changes, new
potentially ambiguous objects, caller mutation, extension changes and cancellation
invalidate the pass. Generation/fidelity retains THE-21 initial evidence lineage,
THE-23 claim support and THE-32 activation boundaries. This is an optimistic
read-set/write-entry barrier, not a transaction or whole repair-driver rollback.

Budgets are explicit: 100 candidates, 24 selected objects, 400 associations per
candidate and 160,000 projected characters, with four concurrent candidate
readings and a bounded deadline. Overflow holds; it does not silently discard a
plausible target or clip protected content. A no-candidate pass requires no model.

## Deterministic proof and limits

The foundation fixtures cover paraphrases, singular ambiguity and plural targets,
connection meaning without old intent keywords, incidental integration words,
concrete identity without a model pattern, actual probability units, settled no,
uncertainty, unavailable readers, malformed probabilities, protected late content,
configuration changes, aborts and ignored-signal deadlines.

Temporary SQLite fixtures exercise the prepared caller path and exact local
provenance, structural exclusions, extension declarations, protected pre-evidence
input, stale supplied rows, operator/graph/new-object races and late ranking or
verification changes. Both ordinary and no-evidence paths hold before downstream
generation/repair writes. Existing answer expectations are preserved through
specific authored question/title readings; these fake-port fixtures do not
establish live semantic accuracy.

Focused commands use the repository-owned runner:

`bun packages/engine/scripts/test.ts test/knowledge-answer-object-alignment.test.ts test/knowledge-answer-object-plan.test.ts test/knowledge-semantic-answer.test.ts`

The completed accumulated proof passes 667 tests / 4,037 assertions across the 65
explicit offline knowledge/Home Graph suites, including 31 new alignment/plan
regressions. The package build, forced solution compiler, standalone type tests,
API/subpath checks, line-cap, credential-scope, no-any and error-contract checks
pass. The API surface remains unchanged (160 SDK subpaths / 9,738 exports and
three terminal-shell subpaths / 191 exports). Final commits use the normal hook,
which repeats build, compiler and API checks without a bypass.

The initial fresh-worktree run exposed two missing-dist setup errors and four
standalone HA fixture failures. The build prerequisite and declared HA vocabulary
plus exact authored readings fixed them; the original assertions remain intact.
The successful full rerun is the verification result above. THE-35 retains live
calibration/latency proof and THE-34 retains the cross-dot/full CI proof.

## Remaining inventory

The pinned `docs/inventory/engine.md` entries at 1826 (answer subject tokens),
1832 (answer integration regex) and the answer consumers of the shared object-scope
policies at 1909 onward identify this conversion. Shared Home Graph/search/repair
object-scope consumers remain unchanged and inventoried, including Home Graph's
own upstream search filtering. Query-to-gap identity, excerpt selection, broader
repair-subject policy, packet/search ranking and the remaining K3 inventory are
separate follow-ons. THE-37/39 owns repair-profile/usefulness consumers. This
change does not claim all K3 complete or a live accuracy result.
