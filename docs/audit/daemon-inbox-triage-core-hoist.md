# Typed inbox triage core (THE-109)

## Scope and source mapping

Pinned source: `mgd34msu/goodvibes-daemon` at
`254699bf5d834cdca41436211ada1ae32bf89258`,
`src/daemon/handlers/triage/scorer.ts`, `pipeline.ts`, and `types.ts`.

- Scorer semantic lexicons, message-shape weights and fixed probability cutoffs
  are replaced by the registered `engine.intake.inbox-triage` v1 battery. It asks
  fixed spam and urgency questions, pinned to `jev-1.13.0`, with high and medium
  stakes bands respectively. Synthetic calibration fixtures accompany it.
- Both questions for every item share exactly one explicit `JudgmentPort.ask`
  call, attributed as a fan-out. No port is created, no credentials resolved,
  and no fallback heuristic or live provider is installed.
- Label composition retains spam precedence when its positive probability is
  at least urgency, otherwise positive urgency becomes priority, otherwise
  normal. Both readings must be `act`; confirm/escalate yields `held` with no
  label. Scores and signals round to two decimal places. The signal name
  `urgency` explicitly identifies the second reading. Canonical tags remain
  `GoodVibes/Spam`, `GoodVibes/Priority`, and `GoodVibes/Normal`.
- Pipeline persistence is now an explicit `TriageStore` port, with the default
  `SqliteTriageStore` stored at
  `.goodvibes/tui/operator/inbox-triage.sqlite` under the supplied working directory.
  Settled evidence and the latest receipt are written together atomically.

## Public host-only contract

The existing `@goodvibes-jev/engine/sdk/platform/intake` subpath exports the
battery/model, closed types, `scoreInboxTriage`, `runInboxTriage`,
`readTriageMetadataBatch`, `enrichItemsWithTriage`, `SqliteTriageStore`, and
`labelToTag`. No browser/root facade gains filesystem code.

`TriageInput` contains provider-scoped id, surface, optional subject/snippet,
conversation kind and unread state. Metadata and additional supplied properties
are inspected but are not semantic features. Composition must deliberately map
provider previews to this input; the core does not pretend every inbox adapter
already supplies a complete semantic message.

The entire original batch is descriptor-captured, bounded and privacy-inspected
before field selection, hashing, port access or logging. Proxies, accessors,
functions, cycles, symbols, sparse/decorated arrays and exotic prototypes are
rejected without invoking their code. Non-enumerable original data is inspected
as well. Declared credentials/card material, including material beyond normal
preview lengths, is refused by the existing local judgment privacy boundary.
Inputs are never clipped to get a judgment. Batches are bounded to 100 items,
with unique ids, 20,000 data nodes, 64 nesting levels and one million string
characters. Budget failures refuse the input; they do not manufacture a label.

Missing ports, failed/malformed answers, wrong model provenance and cancellation
produce `unavailable` receipts. Those are distinct from a valid but held reading.
The core emits no log of original text, provider failures or input fingerprints.
A caller-supplied judgment port owns its transport and recording side effects;
using a recording or live port is an explicit host responsibility, including
during dry-run.

A settled receipt includes the exact semantic input's SHA-256 binding,
battery/version/model, original readings, and re-derived label/score/tags/signals.
Evidence capture checks all data before field access, then independently
recomputes bands and conclusions. Returned evidence is deeply immutable.
Stored maps are matched by id, never by insertion order. A receipt cannot be
projected over changed input or different battery/model provenance. Incoming
triage projections are stripped before checked current evidence is added.

Held/unavailable attempts update the latest receipt while preserving the last
settled evidence as history. History is not a current label: only identical
latest and settled receipts matching the current input can project. Read-only
metadata collection uses one store batch read. The SQLite implementation reads
and validates the complete image in that operation, then filters the requested
ids; this prioritizes corruption detection over large-store query scalability.

`runInboxTriage` uses a supplied store without closing it, or owns and closes a
store when given a working directory. Persistence without either is an explicit
error. `dryRun` is wholly write-free with respect to triage persistence: it performs
no storage read, open, constructor call, write or close,
even when a store getter is supplied. Cancellation is checked before and after
judgment and at persistence admission/publication. An aborted run does not
persist its unavailable attempt.

## Persistence and lifecycle

Each operation reloads the latest SQLite image under a process-wide queue keyed
by canonical working directory and store path. Two instances and aliases of the
same existing working directory therefore cannot publish stale snapshots over
one another. A commit validates the complete batch before touching the store,
updates both columns in one transaction, exports a prepared image and atomically
renames a same-directory exclusive temporary file. Readers and close do not
write. Close drains admitted work, rejects new work, and is idempotent.

Corrupt images, incompatible schemas, inconsistent records and unexpected
schema objects are refused without quarantine, repair or replacement. Managed
path symlinks and non-regular files are refused; temporary files use exclusive
creation and no-follow flags. The working-directory alias is resolved once.
Coordination is process-local: a working directory requires one process owner.
This is not cross-process mutation locking or protection from a hostile process
racing ancestor directory replacements.

## Verification

- Focused synthetic scorer/pipeline and SQLite regression suites cover single
  batch requests, every disposition, input privacy, malicious objects, immutable
  evidence, id reordering, historical suppression, dry-run, cancellation,
  atomic batches, reopen durability, alias/multi-instance ordering, close
  drainage, corruption and symlink refusal.
- Consumer-vantage type fixture: `test/types/intake-triage-public.ts`.
- The PR records exact final type/API/architecture checks and CI status. Live
  calibration and provider integration are deliberately not claimed.

## Remaining composition

No inbox catalog wrapper, poller/provider adapters, tag writes, reactions,
credential wiring, executor admission, daemon-wide parity or default live
transmission is included. THE-49 legacy IMAP and native evaluator changes are
outside this slice. A host must supply an authorized judgment port and explicit
source mapping before this core processes real messages. This draft is for
review; no merge, release or deployment is implied.
