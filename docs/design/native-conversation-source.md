# Conversational original-source admission

The explicit UTF-8 file submission path remains supported. This contract captures and admits text; product ingress and execution have their own owners and proof obligations.

## Source authority

The authenticated paired-token owner captures the complete original text before composer trimming, file expansion, model directives, shell-context decoration, or summarization. A new deliberate message has a new durable logical `inputId` and `requestId`, even when its text is identical. Transport retries, restart lookup and failover retain both IDs and the original text. Project, principal, session, source ID, source revision and workspace incarnation come from the host. A correlation ID or conversation turn ID does not establish source authority.

The first format supports one immutable text part named `input`. `unsupportedSources` preserves explicit markers for relevant attachments or missing context that this owner cannot faithfully read. It never silently drops a referenced source. The complete text remains the LedgerWork goal. Generated titles, plans, tests and subordinate criteria do not replace it.

The request is bounded to 20,000 UTF-16 code units of nonblank text, 100 source markers and 262,144 encoded JSON bytes. Validation does not trim, normalize, deduplicate, reorder or truncate it. Existing local privacy checks run before either proposer generation or Jev receives its material.

## Exact requirements

The read-only proposer may return only `{sourceRevision,spans}`. Each span is `{partId:'input',start,end}`. Offsets are zero-based UTF-16 code units, start-inclusive and end-exclusive, matching JavaScript string slicing. The host rejects wrong revisions, extra fields, noninteger/out-of-bounds/empty ranges, overlaps, out-of-order ranges and boundaries that split a surrogate pair. Separate repeated occurrences remain separate spans and may produce identical ordered criteria.

Only the host slices criterion text. A model-authored paraphrase, source ID, actor, root criterion, decision or approval field is never accepted as original authority. Source-level fidelity asks whether each selected slice is an actual requirement in its full context. The completeness battery sees the exact selected and uncovered occurrences, including qualifications, negative requirements and repetitions. It does not use the legacy normalized quote layout, which marks every identical quote occurrence covered.

The host records routing, requirement fidelity, occurrence-aware completeness and a fresh autonomous decision. Uncertain routing never becomes ordinary conversation by fallback. A settled converse/answer also requires a fresh bound act before returning a `turn` projection. A work act binds the exact source, proposal, generation, paired authority and workspace incarnation. Real answered call IDs and their state, questions, answers and context are checked against the existing decision log. The shared Jev transport remains the sole retry owner.

There are at most three proposal attempts, persisted before each call. Registered repair may change only the proposal ranges. The registered source-resolution operation supports the complete captured text and reports absent/unsupported sources as blocked; it cannot synthesize context. A refusal or unresolved-source result is terminal for that immutable input. Repeated resume cannot reroll unchanged evidence until it accepts. A new complete input requires a new capture identity. No approval interview, legacy planning fallback or fabricated admission receipt is used.

## Durable owner and publication

KnowledgeStore schema 6 adds `native_conversation_captures`, uniquely keyed by project/principal/input and separately by project/principal/request. Existing schema-5 authority is validated before migration. Existing LedgerWork source version 1 and source-less historical records remain unchanged. Nothing backfills conversational authority into them. Older schema-5 writers refuse schema 6.

Capture records contain immutable source and owner facts, monotonic generation, retained proposal budget and decisions, cancellation state and an optional ledger association. Extracted LedgerWork source version 2 records exact spans, offset encoding, proposal revision and authentic admission references. The complete original text is the goal; its exact selected slices are the ordered roots.

Publication reuses the ordinary WorkLedger reducer and coordinated SQLite image. One transaction creates the work, claims its first attempt, stores history/request receipt and associates the captured source. Source generation, authority, scope, current proposal and final work act are checked at the publication boundary. An ordinary ledger writer cannot publish unassociated extracted provenance. Cancellation and competing owners use that same durable image.

Jev and model waits hold no pairing, workspace or SQLite owner lock. Cancellation writes its tombstone before aborting local work and joins real proposer/read cleanup. A replacement owner can cancel or advance an interrupted generation; an old provider that ignores abort is fenced before any claim. Post-publication I/O ambiguity stays indeterminate and is reconciled through source lookup. An acknowledged work remains a work, even if its response is lost or cancellation arrives afterward; intake never pretends it prevented existing work.

Each final decision has deterministic recorded attribution for its exact source, generation, proposal and consumed proposal-attempt count. The processing stage is durable before the reading. Resume reconciles that existing log entry and claims the next generation in one owner transaction. A recorded refusal or source-resolution outcome is restored without new readings; partial answered provenance refuses recovery instead of rerolling. Failed or absent final readings may be freshly evaluated. Semantic outcomes and their terminal/repair transitions commit together, so a lost capture acknowledgement cannot erase a refusal.

## Authenticated API

All five methods require current paired admin ownership plus `read:work-ledger` and the existing `write:work-ledger`. Shared bearer tokens and user sessions remain unsupported. No token, grant or setting is created by this feature.

- `workLedger.intake.capture`: `{requestId,inputId,text,unsupportedSources}`
- `workLedger.intake.get`: `{inputId}`
- `workLedger.intake.admit`, `.resume`, `.cancel`: `{inputId,sourceRevision}`

The corresponding POST routes are `/api/work-ledger/intake/<operation>`. Clients cannot supply project, actor, session, source metadata, criteria or proof. Result kinds are `captured`, `processing`, `turn`, `blocked`, `refused`, `cancelled`, and `work`; lookup may also return `not-found`. Every found result identifies the original captured source. Only `work` contains an immutable submission receipt. It is not an execution receipt or verification result.

Capture performs no generation. The first explicit admit owns the initial semantic operation; duplicate deliveries join it or return its recorded state. After interruption/restart, processing reports recovery required, and only explicit resume obtains fresh readings under a new generation. Get never submits, resumes or executes. Refused, blocked and cancelled inputs do not restart.

## Product handoff

Agent/TUI ingress must journal original capture before first POST, bind its journal to authenticated host/workspace/principal, and preserve input identity through queues and failover. `turn` is a genuine recorded routing result; it requires a nonserialized shared admission capability to bypass old intake once. Native-routed turns must not start legacy plans or source-less agent/workflow contracts. Status alone cannot dispatch a model turn.

A local conversation delivery claim must be durable before dispatch. A claimed delivery found after restart is ambiguous until its actual effects are reconciled; source admission does not prove exactly-once model/tool execution. Native `work` uses the existing explicit execution owner and controls. Capturing, replaying or looking up a source never implicitly starts execution.

Hosted ingress additionally needs the canonical broker input identity and currently authenticated native authority propagated through delivery. Current correlation-only propagation is insufficient. Missing referenced context and unsupported attachments remain explicit holds/refusals in this text-only phase.

## Required proofs

Owned synthetic providers test exact whitespace/Unicode/duplicate preservation, malformed proposals and proof injection, real recorded lineage, uncertain/negative readings, bounded repair and terminal refusal, cancellation during provider/Jev waits, revoked/replaced owners, restart/lost acknowledgement, paired-principal isolation, atomic one-work publication, schema migration and write ambiguity. Real daemon tests use the production route and composition. These prove orchestration and lifecycle behavior, not live semantic calibration or arbitrary external-effect reconciliation.
