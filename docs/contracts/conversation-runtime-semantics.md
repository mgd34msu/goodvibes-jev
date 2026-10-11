# Conversation and shared runtime semantics

These contracts cover canonical engine behavior consumed by Agent, TUI, daemon
and WebUI. Related ownership boundaries are documented in
[runtime resource lifetimes](runtime-resource-lifetimes.md),
[self-update transactions](self-update-transactions.md) and
[test-runner ownership](test-runner-ownership.md).

## Core turn and strategy readings

### Semantic decisions

- `engine.core.turn-shape`: typed chat/task/project intent, an independent specification/plan-needed yes/no reading, and the existing request-risk rubric
- `engine.core.execution-strategy`: task-grounded choice among single/cohort/background/remote. Display rankings are returned probabilities, not a point ladder
- Explicit owner overrides and pinned modes stay structural. An uncertain automatic choice is recorded as held and raises `PlannerJudgmentError`; unavailable remote/background capabilities cannot be invented by the reading
- `classifyIntent`, `AdaptivePlanner.select`, `shouldDecompose`, `proposeWorkstream`, and `prepareConversationForTurn` are asynchronous. Callers await them; no synchronous heuristic backup survives
- The complete turn text is read once for intent/plan/risk. Planner telemetry consumes that same reading, including actual risk, then asks the separate strategy question with the full task
- The generic protected-input boundary runs before these judgment requests

### Turn lifetime and contract ownership

The orchestrator reserves the turn and starts its cancellation/queue fence before asynchronous judgment. The submitted user message remains in the transcript when judgment fails or is cancelled. Judgment errors are already typed, so their display does not recursively ask the unavailable judgment service to interpret them. All failures pass through the normal submission finalizer.

A newer message queues even if an abort has already cleared the displayed thinking state but the earlier reading is still settling. It cannot replace the earlier turn's controller or submission key. The cancellation transcript boundary is captured immediately after the user message is added, before awaiting judgment.

Plan priming waits for contract intake. A request consumed by the contract runner, or executing as a session-mode contract unit, does not receive a competing legacy project-plan instruction. An ordinary conversation can be primed by yes at act, unless an execution plan already exists. Uncertainty does not inject a guessed plan.

### Validation

The focused suites cover retrospective documentation, short project requests, contrary-to-old-keyword readings, empty text, uncertain planning, missing/failed/cancelled ports, protected input, owner overrides, stale choices after overrides, unavailable strategies, probability-based history, existing plans, multimodal fallback, no provider spend before judgment, retry after failed preflight, cancellation and queued follow-ups. Existing decomposition, workstream, hosted contract and compaction behavior is exercised with explicit recorded readings.

Commands from the repository root:

- `bun packages/engine/scripts/test.ts test/intent-classifier.test.ts test/adaptive-planner.test.ts test/plan-decomposition.test.ts test/workstream-planner-inputs.test.ts test/workstream-services.test.ts test/hosted-session-turn.test.ts test/hosted-session-contracts.test.ts test/hosted-session-exec-posture.test.ts test/compaction-manager-session-bootstrap.test.ts`
- `bun run judgment:lint`
- `bun run typecheck`
- `bun run api:extract && bun run api:subpath && bun run api:check`

Core decisions are registered through
`sdk/src/platform/core/judgment-registry.ts`, with fixtures for every answer and
a 0.90 accuracy floor. Deterministic readings validate behavior and failures,
not semantic accuracy. Configured calibration uses:

```sh
bun run --cwd packages/judgment calibrate --registry ../engine/sdk/src/platform/core/judgment-registry.ts
```

## Channel conversation capabilities

Conversation retains `outsideContract: true` and its reply style. A locally typed
or already-confirmed continuation keeps its original task and normal capability
path; it does not inherit the conversational instruction or restricted tools.
Existing proposal delivery/acceptance, refusal, expiry, and raw authorized-work
checks remain in the compatibility run.

- The conversational capability fragment is conditional on the existing
  continuation authorization decision. An unconditional spread must not narrow confirmed contract work.
- A conversational routing list may select fewer of read/find/fetch/profile,
  including an explicitly empty set. It cannot add write/edit/exec or another
  capability. These are exact tool identifiers, not a reading of user language.
- Profile admission requires a matching explicit `profile.ownerChannels` grant.
  Its empty shipped default grants nothing. Exact addresses and intentional
  surface wildcards remain supported. `occasions.nudgeChannel` is a delivery
  preference, not a personal-data read grant, even when explicitly configured.
  The existing standalone `resolveCaptureAuthority` nudge fallback is unchanged
  for legacy callers; this stricter condition belongs to the new tool admission.
- Profile includes personal reads as well as writes. If channel authority is
  denied, the capability list omits profile entirely; an explicit routing list
  cannot add it back. A real permitted-collaborator ingress on shipped defaults
  attempts both list and acknowledgment through the provider loop, and must
  receive unavailable-tool results with no synthetic store reads or mutations.
- Every first channel turn receives a bound capture decision, including a turn
  with no session id. Unknown origin is explicitly routed and untrusted, rather
  than inheriting the unbound profile tool's local-owner default.
- The current ingress channel id decides capture. An unrelated route attached
  to the same session cannot authorize the turn. Continuations use their exact
  input's bound route channel id, falling back to the input's external id when
  no channel id was supplied. Telegram bot usernames and Slack workspace ids
  are account identity, not the configured owner-channel address.
- `conversationalTurnSpawnOptions` accepts optional explicit `channel` identity
  and a narrowing `tools` list. Its previous input shape remains compatible;
  channel profile admission requires the explicit owner grant above. The two composition roots always supply the explicit routed identity; other hosts adopting this
  seam must do the same for channel turns.

The spawn-contract capability/config adapters tolerate older schemas that throw
for unknown keys. Missing or malformed reads grant no channel authority. Exact
capability membership is not a semantic classifier or permission to rewrite
root-spawn tasks or overwrite another runtime composition.

### Acknowledgment authority

`acknowledge_occasion` requires the bound
owner-authority decision, while deliberately remaining available to the owner
when `profile.conversationalCapture` is off. The capture preference does not
remove personal reads or acknowledgment from an explicitly authorized owner. Tests call the actual bound profile
tool and prove both no unauthorized occasion write and successful owner writes;
binding also leaves the original shared tool unchanged.

Validate the first and queued follow-up channel turns through real services,
daemon, session broker and AgentManager with a scripted provider recording its
tool definitions. Release the follow-up through actual completion. Retain normal
capabilities for local/already-confirmed continuations, exact explicit empty
narrowing, default-denied collaborator personal reads/writes, bound route identity
without a session, and proposal delivery/acceptance/refusal/expiry compatibility.

## Typed outcomes and retained records

### Typed outcomes

The role-tool member of `ConversationMessageSnapshot` carries optional
`outcome: 'ok' | 'error' | 'cancelled'`. New `addToolResults` records use
`cancelled === true` first, then the boolean `success` field. A failed result
whose error merely says "cancelled" remains an error; a successful result whose
output starts with "Error:" remains successful. Legacy and newly imported
provider-only results without an outcome remain unknown. Consumers must not
infer an absent outcome from text.

Provider-facing content remains unchanged, including partial output and error
diagnostics. The outcome is store/UI metadata and is not sent in ProviderMessage.
Per-call cancellation already supplies typed cancellation; unresolved synthetic
results remain errors unless a producer supplies actual typed cancellation.
Outcome metadata does not reinterpret whole-turn exit reasons.

### Exact retention and provenance

`replaceMessagesForLLM` restores retained records whole, then invalidates the same cache revision.
System records remain intact at the front and the conversation title is retained.

The cached provider list must align with the stored non-system list in length,
role and complete model-facing projection. Object identity restores the exact
source occurrence. A copied record may restore only an exact unique projection,
including full tool-call names/arguments or tool-result call ID/content/name.
Each source is restored at most once. Ambiguous duplicate copies and modified
calls are converted without borrowing another occurrence's provenance, usage or
outcome. This is intentionally stricter than upstream's assistant text/call-ID
fallback. A summary or newly created provider record retains its explicit tool
calls but receives no invented metadata.

Matching uses structural identity and exact serialized field equality, not
semantic similarity, outcome wording or model-name interpretation. Every restored
record is cloned so old provider arrays cannot mutate the new store. Persistence,
branch snapshots and replay already clone whole records and retain the new field.

### Validation

Tests cover actual per-call cancellation plus an unaffected sibling, successful
Error-prefixed content, failure diagnostics, typed cancellation precedence,
synthetic failure, legacy absence, JSON/branch replay, small-window compaction,
next-request call/result pairing, unique copies, additive follow-up metadata,
duplicate occurrence ambiguity, altered call arguments, misaligned projections
and source mutation after retention.

Compaction selection/quality remains its Jev owner. Structural retention must not
infer outcome, usage, model or provenance from wording or similarity.

## Nullable context-window authority

### Observations, estimates and floors

- Custom provider files can omit their context window. Invalid stated numbers still fail validation.
- Numeric `getContextWindowForModel` remains a compatibility budget API. `getKnownContextWindowForModel` is genuinely nullable and is the only ceiling used by automatic compaction/percentage awareness in the adapted consumers.
- Own-provider catalog entries require an exact provider ID or a pre-existing explicit alias. A model ID either matches exactly or is confirmed by the existing `ModelIdentityResolver`; no vendor-prefix stripping, date stems, case folding or provider-name squashing is restored. Pending, rejected and weak readings do not authorize a match. The registry is invalidated after a background reading settles.
- Consensus is intentionally stricter than upstream: figures for one exact catalog model ID across other providers get one vote per provider, majority wins and ties choose smaller. This remains an estimate with `origin.kind = consensus`; it never becomes a known endpoint ceiling. Multiple syntactically different IDs are not combined by a heuristic. Family rows still come only from existing Jev family readings and remain guesses.
- Accepted input is a lower bound, not a maximum. `contextWindowAcceptedFloor` retains it independently of a larger raw display estimate, so a smaller resolved OpenRouter ceiling cannot reappear after restart. Registry reconciliation compares against the effective resolved budget. Once measured, floors increase monotonically even under a still-supported larger ceiling, preventing a later rejection below already-accepted input from becoming known. Unlike upstream's legacy observed-limit reconciliation, a larger success removes a contradicted observed ceiling and persists an accepted floor. A rejection below that floor cannot restore known capacity; a later supported ceiling at least that large can. The override file stays version 2 and old optional sections remain compatible. User-set caps remain separate deliberate constraints, with `user_override` origin.
- Existing OpenRouter model identity and trusted-source policy is retained, with the narrow requirement that a stated OpenRouter ceiling meet an accepted floor. Catalog estimates cannot override that policy or be falsely labeled provider evidence.
- Picker output retains both the budget number and nullable known window plus origin. A numeric fallback that differs from an invalid raw figure is not labeled OpenRouter.

### Consumers

- Agent runner and its split run-context type: unknown/estimate windows cannot trim history or supply percentage awareness. Existing Jev tier selection, audience and cancellation are untouched.
- Context preflight/post-turn: known ceiling thresholds only; provider-issued warnings retain explicit recovery; threshold-driven small-window compaction skips when nothing lies outside its kept messages. A genuine provider warning uses structured recovery even for a short known-small-window history. Awaited system-prompt and abort propagation remains in place.
- Session manager factory and independent manager: unknown uses the pre-existing numeric contract's `0` sentinel. Nonfinite/nonpositive automatic windows are rejected before any threshold arithmetic, state transition, event or mutation. Manual/provider-too-long recovery still runs. Resume repair uses an internal unbounded comparison when capacity is unknown, preserving token-based history; that internal value is neither persisted nor emitted.
- Model-picker enrichment and its data-provider/index dependency contracts carry the nullable observation and detailed origin. The historical numeric field is explicitly documented as potentially estimated.

### Validation

Focused tests cover actual registry/provider loading, known/invalid/fallback values, persisted rejection→success→restart→later rejection sequences, OpenRouter floor bounds, explicit caps, consensus estimates, exact/deferred/denied identities, catalog refresh, source labels, actual agent-loop history preservation, nullable picker shape, real independent manager no-op/events behavior, live model changes, explicit recovery, and unbounded resume repair. Existing compaction async-prompt/cancellation, runner steering/retries, audience and identity suites are retained.

Keep full build/types, canonical generated APIs and normal gates distinct from
focused source fixtures.

## Background process completion

Each list row projects the existing authoritative `BackgroundProcess.done`
boolean. `bg_list` serializes the same rows. Consumers can distinguish running
work from any settled exit, including a signal or timeout, without parsing the
display-only `status` string. An elapsed timeout with `kill_on_timeout: false`
is not completion. Completion is authoritative process state, without a judgment or heuristic.

The change does not import the upstream lifecycle implementation. Jev retains
its admission-signal checks, shared close ownership, process-group
termination and bounded output drain. An exited group leader still reports
`done: false` until the owned descendant cleanup and output collection settle.
Explicit stop still removes the tracked row immediately; no stopped-record
retention behavior is changed.

### Validation

The focused suite exercises actual processes through both `list()` and
`bg_list`: live work, normal zero/nonzero exit with final stdout/stderr, signal
termination, watchdog termination, and a timeout deliberately allowed to keep
running. A real owned descendant acknowledges TERM and holds the inherited
pipes until explicitly released, proving the leader's exit alone does not
report completion. A controlled child-handle fixture independently holds each
output stream open after exit, proving both streams drain before completion.
All real jobs are closed in `finally`; the controlled handle never signals a
host PID. Credential readings use the existing offline fixtures.

Negative controls remove only the `done` projection and must fail the live-to-exit
case. Preserve process-group, close, timeout and admission-cancellation coverage,
fleet fixture completion fields and checked declarations. API generation must
preserve all unrelated public entries; a narrow additive-field check cannot
substitute for whole-workspace build/types or final composed API equality.

## Legacy return-context migration

The public `loadedReturnContext` helper accepts legacy object records, removes their
own `openPanels` field, and filters only the exact generated line prefix
`Open panels: `, including its space. Case variants, quoted or embedded words,
the user's last prompt, the assistant reply and assisted narrative are left
unchanged. Unknown legacy fields and partial records are preserved. This is
not a new general summary validator or semantic text classifier.

New summary construction ignores any legacy pane hints at runtime. Local
SessionManager save/load/list/getMeta/rename and recovery read/write paths all
apply the migration. The real host fork/copy boundary is load followed by save;
SessionManager has no separate fork method. Durable persistence also uses the same manager. The existing load-last API
returns messages only, so its shape is unchanged; its stored metadata is
verified through the manager rather than silently expanding that API.

### Preservation boundaries

- Pending approvals still use the host's structured count, or the existing
  `engine.runtime.pending-approval` reading when that count is absent
- Session schema version two, contract records, sticky explicit user-save
  retention, atomic writes and recovery scope/liveness are unchanged
- Ordinary reads do not rewrite old files; the migration appears in returned
  metadata and the next intentional save, rename, fork-copy or recovery write
- The older wire schema may still accept optional `openPanels` for read
  compatibility; it cannot make the local migration retain or emit that field
- TUI panel adapter/control routes remain a separate compatibility surface

### Validation

Focused tests exercise the public export, malformed outer values, partial
legacy records, exact-prefix negative controls, input immutability and
idempotence. Real disk roundtrips cover save/reload/list/getMeta, load-to-fork,
rename, durable persist/load-last and recovery load/copy/write. They preserve
tool outcomes, follow-up markers, version-two contract data, unknown metadata,
user-save retention and untouched sibling files. A synthetic reading proves
the existing pending-approval battery remains authoritative rather than a
restored keyword fallback. Adjacent session/schema/retention/recovery and
runtime-reading tests, normal build/type/API gates remain required.

## Tier-prompt audience and cancellation

### Public audience API

`getTierPromptSupplement(tier, options?)` accepts audience `agent` or
`conversation`. Omitted audience preserves the existing agent behavior. The
free-tier conversation text keeps the upstream tool-call and parallel-work
guidance without the unattended-agent instruction or mandatory JSON completion
block. Standard, premium and subscription guidance is unchanged.

`readTierPromptSupplement(modelFacts, tiers, site?, options?)` adds a compatible
fourth options argument containing the audience and optional AbortSignal. The
model facts, site and same signal are forwarded to the existing Jev tier reader;
the selected tier and existing unsettled-tier policy still decide the guidance.
No context-window thresholds or model-name heuristics are restored.

### Caller cancellation

A cancelled caller receives the existing fixed JudgmentError with kind
`aborted`, without the caller's private abort reason or a nested cause. Checks
before reading and after awaiting prevent cached or late readings from escaping
as a prompt. A caller-owned wait also rejects promptly when a shared reader
ignores that caller's signal. It removes its abort listener on every terminal
path and handles the underlying promise's eventual rejection.

The helper does not rewrite ModelTierStore's cache, coalescing, or underlying
request ownership. It forwards the signal under that store's existing contract;
the separate wait does not cancel another caller's shared promise. Tests cover a
later caller cancelling while the first caller still receives its prompt.

### Validation

Focused tests cover default-agent compatibility, exact upstream conversation
guidance, unsettled-tier behavior, facts/site/signal identity, pre-cancellation,
cached and deferred results, two callers sharing a read, late rejection,
listener cleanup, reader failure, and private abort-reason containment. Existing
tier tests remain in the compatibility run.

The providers barrel exports audience/options types. Tier still comes from the
existing `routing.model-tier` reading; audience selection and signal state are
structural. Product selection of conversation audience and awaited
`getSystemPrompt(signal)` belong to their actual callers.

## Theme and glyph presentation

The canonical presentation catalog contains eleven bundled palettes, reference
and variant resolution, color arithmetic, terminal-system palette generation
and the existing tone-table bridge. Legacy exports remain available. Palette
keys, explicit modes, format checks and numerical color/contrast arithmetic are
structural presentation choices; they do not classify user language.

Optional derived colors accept transparent operands without passing them to hex
arithmetic. System-palette contrast is best effort for arbitrary terminal colors;
bundled palettes retain their declared contrast floors. Validate resolved
palettes/contrast, reference errors, system fallback, tone-table compatibility,
transparent derivation and an actual browser-target consumer bundle.

The registry indexes canonical names, matching the pinned upstream source.
Hosts map a saved `vaporwave` alias to `goodvibes-neon` before calling
`getBundledTheme`. `system` is generated from a host-supplied terminal palette,
not a static bundled entry. Hosts own palette probing, appearance mode, and
painting.

Catalog `DEFAULT_THEME_NAME` does not itself install a persisted configuration
default. Theme probing, appearance and painting remain host-owned. Notification
preferences may only be presented as enforced privacy when the actual producers
consume them and validate omission of names, reasons, commands and paths.

### Read-only glyph selection

`runtime/operations` exposes `TREE_GLYPHS_CONFIG_KEY`,
`TreeGlyphSetName` and `readTreeGlyphSet(configGet, unicodeCapable)`.
It reads the exact key once on each call, uses the same closed enum/default,
catches old or malformed getters and contains asynchronous rejections without
accepting an eventual style. The terminal capability always wins.

This installs no ConfigKey, schema entry, persisted default, setting control or
write path. Host adapters retain their generic string-key config read seam;
terminal capability probing, glyph tables and rendering remain host-owned.
The reader is purely structural presentation selection, with no text judgment.

### Validation

The regression composes the public reader with the exact pinned upstream
renderer module stored as a test-only fixture (no product-code duplication).
It verifies real rounded/square/ASCII corner rendering, all valid and malformed
values, live changes, throwing/old getters, and real ConfigManager disk reloads
without writing through the reader. An owned, bounded Bun subprocess proves
rejecting promises, late failures and throwing then accessors cannot escape;
resolved async styles remain invalid.

A getter that throws a rejecting Promise is contained too, with unchanged
rounded/forced-ASCII fallback. The real child-process proof covers both returned
and thrown asynchronous values without logging or retaining their failures.

The closed style set is `rounded | square | ascii`, defaulting to rounded, with
host Unicode refusal always forcing ASCII. Preserve checked declaration/API
composition and actual current whole-source gates; generated ordering changes
or unchecked emission cannot substitute for checked declaration equality.

## Model-family and failure-reader ownership

Family classification has one engine provider owner, shared by runtime UI and server projections, with Agent, TUI and WebUI consuming settled family facts. Missing or unsettled readings remain unknown. Closing a picker drops its completion rather than cancelling another consumer's shared work. No family reading grants permission to select a model, change settings or execute an action.

### Ownership boundaries

- A captured reader belongs to the installed port, its bound composition/source incarnation and its optional caller lifetime. Replacing or removing the installation, rebinding its owner, retiring its source or cancelling its caller interrupts even a non-aborting underlying reader. Late resolution and rejection are consumed.
- Every composition-owned config mutation intent, including ABA, no-op and failed setting mutations and bulk saves, rotates a value-free owner revision. Secret mutation intent and settlement expose only generation/pending state; pending writes cannot admit an old credential. Existing alias/tier-aware credential snapshots are preserved.
- Cache keys are opaque installation/binding/source identities plus exact model evidence. Credential names, paths, values and hashes do not enter family caches, judgment facts or new diagnostics. Environment credential equality is checked only inside a private source-observation closure.
- The scoped port fences each attempt, asynchronous admission, log retention, retry callback, result publication and battery attachment. Request-only cancellation continues to fence attachments after a response. Borrowed request/result getters cannot retire ownership and then publish a result. An identical owner-binding callback is idempotent; a replacement callback retires old work even if it returns the same frame identity.
- Shared failure memo lookup first captures the current owner. A cache entry cannot survive config ABA, port removal, replacement or later reinstallation. Failed reads can retry. Explicitly owned failure-reading options retain their existing independent contract.
- Older composition disposal conditionally restores only its own installation. It cannot transiently replace and revoke a newer live composition.

### Validation and limits

Exercise real configuration/credential owners, pending alias writes, A-to-B-to-A
mutations, deferred non-aborting resolution and rejection, queued siblings,
same-port owner rebinding, independent callers, reentrant recording/request/result
boundaries, changing callback getters and late progress callbacks. A retired read
must neither return an old cached family nor publish a decision record. Retain
actual Agent/TUI/WebUI picker/catalog consumer tests and bulk-save provenance.

Unobserved external config/credential file rewrites are outside the local mutation-owner contract. Legacy ports without bound source observers retain installed-port/model-value checking, not an invented config/credential ABA guarantee. Settings execution admission and forensics/compaction publication belong to their separate execution/publication owners. Generated contracts, API extraction and composed-source validation remain required.

## Canonical vector code injection

Vector similarity remains candidate recall and a labeled retrieval diagnostic.
It does not decide whether recalled code is injected. The existing registered
`engine.state.code-search` owner reads each query/chunk pair. Settled no is
removed, settled yes competes with memory using probability ×190, and the
existing owner-configured floor and shared token budget remain in force.
Missing rank capability or an unavailable, malformed, unsettled, canceled or
retired reading never falls back to vector confidence.

The reader first structurally owns the whole batch. Every semantic source
field and the entire source-file text pass the privacy boundary before line
selection, clipping, budget checks, or port capture. Local timestamps, hashes,
and vector distances are provenance only and never enter the request. The
reader captures the installed/source authority through `captureJudgmentPort`,
validates answer and model attribution, and retains no cross-operation cache.
Source guards run before requests, hosted retries, and result consumption.
Both main-session and agent callers retain the returned per-reading assertion
through provider dispatch, retry and cached continuation use.

Captured sources use the already-authorized generation snapshots, never live
filesystem reopening through the generic adapter. Their existing generation,
policy, cancellation, and operation-budget checks remain active, and their
provider-retry assertion also validates the retained reading authority. The
live adapter requires a per-invocation current read policy and cancellation
signal, supplied by the main-session or ordinary agent permission owner. It
checks root, ancestor directories, files, file hashes, and store/provider
lifecycle before source transmission and retained-result use. Its callbacks
and reading authority are never stored on the shared CodeIndexStore.

Validate contradictory vector-versus-semantic answers: an irrelevant 0.99-vector
chunk is refused while a relevant 0.01-vector chunk may be admitted. Keep
shared-budget ordering, no fallback, privacy beyond clipping, malformed/unsettled
answers, unavailable ports, cancellation, source retirement, installation ABA,
generation changes and actual captured-vector injection. Synthetic judgments
establish control behavior rather than genuine classification accuracy.

Main sessions (including TUI) pass their PermissionManager
read-access check and active turn signal. Ordinary agents pass the existing
original-owner read filter and run signal. Contract-authorized agents retain
the captured-source adapter. External embedders that supply a plain store
without current read policy fail closed; manual search is unchanged.

## Requested models and proof provenance

`packages/engine/scripts/contract-proof.ts` reports behavioral assertions
separately from serving-model identity. Exit zero means its behavioral assertions
held. Requested session settings and stored per-unit routes, including best-of-N
attempts, do not prove which model served a response. Missing routes are printed
as `(none recorded)`, never inferred from the session setting.

Every model line and final result states that effective serving identity is
`UNOBSERVED` while provider-returned identity is absent from proof evidence.
`CONTRACT_PROOF_SESSION_MODEL` changes the request, not that evidence boundary.
Catalog entries, aliases, redirects and changing the requested model string
cannot qualify a particular response.

An end-to-end provenance implementation must carry actual provider-returned model
identity and response correlation, such as Gemini `modelVersion` and `responseId`,
through calls, retries, fallback, streams,
session subprocesses and persisted proof evidence. Missing metadata remains
unobserved; one observed response does not qualify every call in a multi-model
run. These are evidence requirements, not a claim that the present proof retains
those fields.

`packages/engine/test/contract-proof-model.test.ts` validates actual formatter
output for deprecated/supported names, aliases, custom overrides, missing routes,
control characters and both behavioral outcomes. Use the owned Bun runner or
Node 24 `node --test` TypeScript support. Formatter tests require no credentials
and do not constitute a live model proof.
