# Account registries and memory credential containment

`AsyncAgentAccountRegistry` is an additive persistence seam for content readers that need asynchronous work. The original `AgentAccountRegistry` and `SecretLikeTextPredicate` remain synchronous for existing consumers, including email/style-reply. Both registries use the same field validation, normalization, id allocation, duplicate handling, count cap, sweep rules and serialization helpers.

The caller must supply `readSecretLikeText`. There is no default reader and no automatic hosted judgment. Only literal `false` or `{ outcome: 'clear' }` clears a field. Literal `true` and `{ outcome: 'secret' }` identify secret content. `held`, `unavailable`, thrown failures and malformed reader results stop the operation. An unresolved stored record cannot become an empty writable store.

Each operation reads and validates one file revision. A process-wide queue serializes operations from instances with the same resolved path. After every awaited content check, the registry checks cancellation, and before disclosure or mutation it compares the current file's bytes and file identity against the captured revision. An intervening legacy synchronous writer, replacement, deletion or content change causes an explicit retry error rather than stale disclosure or lost updates. The final write uses a unique temporary file and atomic rename.

Cancellation races unresponsive readers, reaches the exact reader signal, and cannot publish a late result or poison a later caller. Reader decisions are remembered only within one operation. Queued cancelled callers never start a reading or mutation.

This does not provide a cross-process transaction lock. The revision check detects changes while asynchronous readings are pending; it is not a filesystem compare-and-swap against a concurrent external writer during the final synchronous replacement.

The broad memory-field/token screening contract and the narrower at-rest journal
reader are not interchangeable. At-rest screening covers only the candidate spans
selected by its writer; it does not by itself screen arbitrary memory fields.

## Registry validation and special files

The focused suite covers awaited lifecycle operations, literal result validation, pending and failed clearance, malformed existing stores, secret records withheld on read, cancellation before disclosure/write, cancellation while queued, same-path concurrent instances, intervening legacy writes, deletion and same-content file replacement. The original synchronous registry regression suite is run alongside it.

Open registry files with `O_RDONLY | O_NONBLOCK`, then `fstat` the actual descriptor
before reading. Preserve before/after descriptor identity and whole-file revision
checks. Do not introduce a pre-stat race or treat a special file as an empty store.
Use externally bounded POSIX subprocess checks for initial FIFO list/write, FIFO
replacement during pending list/write, cancellation before the replacement
recheck and ordinary disclosure. Each FIFO remains untouched, with no temporary
write files. A blocking FIFO open must not prevent the event loop observing
cancellation; the externally owned two-second parent deadline must kill and
reap a wedged probe.

## Synchronous issuer containment

Agent memory safety is a synchronous refusal predicate, used directly by memory
entry points and through PersonaRegistry's shared assertion by local record
stores. It is not a journal redactor. Canonical issuer-format containment covers
GitLab, Slack, AWS and GitHub fine-grained tokens without deriving classification
from a redactor's output marker or mistakenly treating registered profile values
as credentials.

A pure `containsIssuerCredential(text): boolean` export on the existing public
`@goodvibes-jev/engine/sdk/platform/utils` subpath shares the engine's canonical
issuer-format patterns. It consults neither profile/identity readers nor any
judgment provider. Agent adds this predicate before the existing four guards.
Existing refusal wording, synchronous APIs and reject-before-write semantics
remain unchanged. No bootstrap mutation or new background work is needed: the
existing caller graph imports the predicate directly.

Issuer-format containment does not replace broad semantic credential screening. Existing
PEM, short `sk-`, broader GitHub and assignment guards remain. Their known false
positives and their protection must not be silently dropped. Ambiguous `key-`
and `Bearer` candidates are not newly refused; ordinary documentation, secret
references, registered personal details and paths remain valid memory.

## Why not the at-rest judgment reader

`readAtRestCredentialSpans` is an internal engine journal helper, not an export
on the public runtime barrel/export map. It admits complete original JSON/JSONL
sources through local protected-input and issuer screening before projecting
candidate text and nearby context. Protected or unsupported originals are
refused. This deterministic admission floor does not certify arbitrary unknown
credential formats as safe.

Remembered readings are keyed by the admitted original/projection revision and
candidate offsets. Reuse revalidates redaction and installed judgment-port
authority; in-flight readings also check that the original remains admissible
at the same revision. Candidate/context judgments operate on admitted projected
journal text rather than bypassing original-source screening.

The helper addresses journal candidate masking, not every memory field or
assignment, and exposes no caller AbortSignal/deadline parameter. Reusing it as
a memory predicate would change synchronous persistence into asynchronous work
without providing an operation-specific atomic memory-write and cancellation
contract. A source-bound journal allowance cannot itself authorize a separate
durable memory write. Synchronous protection remains available without an
installed judgment provider and introduces no asynchronous persistence race.

## Account preflight and policy

Capture the five account record inputs once and screen them with shared memory
safety before outward-effect/taint policy evaluation, including `serviceDomain`
used in policy descriptions. Feed the same captured values into policy and
persistence, without duplicating issuer patterns or classifying profile values
as credentials.

The preflight is a refusal only. Benign account records still invoke and obey
the existing outward-effect policy, and the registry retains its independent
write-time validation. Validate through a real bootstrap-composed registry test that retains
untrusted page content and checks 45 protected-value/field combinations: zero
judgment requests, static non-secret errors and no account record. Benign
controls exercise both policy refusal and allowance. The negative control removes only preflight and must detect judgment requests
before eventual persistence refusal can be mistaken for privacy protection.

## Conditions for a semantic memory screening port

Replacing compatibility guards requires a designed and tested memory-appropriate
screening port with:

1. Protected inputs: established issuer formats handled locally first; no raw
   credential candidates or unsanitized neighboring content sent to a model.
   Specify exactly what structural/context evidence may cross the boundary.
2. Per-operation cancellation and a bounded deadline/work budget. Cancellation,
   unavailable provider, malformed response and uncertainty must never authorize
   persistence; cancellation must prevent the caller's subsequent write.
3. Decisions bound to the exact field set, context and operation. A source-bound
   journal allowance must not authorize a separate memory write.
4. An explicit safe fallback and reviewed confidence rule for ambiguous spans,
   including benign prose, profile values and valid secret-store references.
5. Atomic validation-before-write across create/update/import/editor/tool entry
   points, with real composition tests and no check/write gap introduced by an
   await. Address caller APIs deliberately rather than silently returning a
   Promise where a synchronous predicate is expected.

## Verification contract

Synthetic fixtures only. Public-subpath tests cover every canonical issuer
format, repeated/interleaved calls, profile/identity independence and candidate
separation. Product tests cover legacy refusals, allowed benign memory and
secret references, PersonaRegistry through shell paths, and the real local
memory tool/spine/SQLite composition including unchanged records on failed
updates and close/reopen durability. The bootstrap composition regression additionally runs the real
`composeAgentToolRegistry` used by bootstrap-core, verifies memory and account
refusals, confirms an already-cancelled tool call cannot write, and saves benign
memory with no judgment provider installed.

Preserve negative controls that remove only the canonical issuer predicate while
benign-memory behavior stays permitted. Validate engine public-subpath import,
declarations/types, original at-rest redaction compatibility, Agent production and
test types, workspace/credential-scope checks and unchanged public API ownership.
Synthetic fixtures need neither a live model nor real credentials.

## Registry-entry capture and cancellation

Parameter auto-repair runs before a tool's execute wrapper, so valid-record
preflight alone is too late for malformed calls. Account and local registry
registration install a registry-entry guard that snapshots the
whole argument object and screens every nested string/key before repair can
receive it. Spare arguments are included because they may become repair input.
The same captured input continues into repair and the original tool wrappers;
protected text is refused with value-free errors. Existing policy and durable
registry checks are retained.

Account derivation also carries retained untrusted source text and origin, not
only the proposed record fields. Account recording refuses protected values in
that context before asking a judgment. It does not redact the evidence and
interpret the redacted context as permission. Ordinary untrusted context still
runs the original derivation policy and retains both allow and refuse outcomes.

Account execution now passes its AbortSignal into the additive, optional shared
TaintOptions.signal. Derivation races pending provider work, checks before any
queued ask, refuses late reading/action recording, and drains late completion.
Already-cancelled checks fail even without retained sources. The account tool
also checks cancellation immediately before persistence, reporting a static
cancelled result without echoing the arbitrary abort reason.

Validate actual bootstrap with malformed account/memory arguments (including
nested spare input), protected source text/origin and cancellation while a
provider is paused. Preserve already-aborted, late completion, queued work,
recorder suppression and active-signal allow/refuse/uncertain checks. Protected
format containment is not a general semantic credential-screening guarantee.
