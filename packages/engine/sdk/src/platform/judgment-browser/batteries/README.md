# First WebUI battery readers

These are server-only definitions and readers for the THE-30 registrations. The surrounding `webui-runtime.ts` source owner and daemon `browser-judgment-composition.ts` now install the command/error/mail readers under authenticated host ownership; this reader layer itself grants no access or transmission permission.

`webui-adapters.ts` implements the published `BrowserJudgmentBattery` descriptor contract from PR31. `webuiDaemonRefusalAdapter` and `webuiStatusToneAdapter` resolve existing server references with the fresh `currentPrincipal` callback. `createWebuiCommandRankAdapter(sources)` accepts the `WebuiPaletteSources` authority supplied by daemon composition. It must resolve the query and all requested candidates in request order, retain the identity map locally, and bind query provenance together with candidate access/revisions in `sourceBinding`. Its `assertCurrent()` must recheck current identity, `read:sessions`, lifetime and source revisions after async work. The adapter checks the full returned projection before bounds/port/logging and verifies its query, version and candidate count against the request. No browser text-staging endpoint or private-source permission is created here.

`webui-command-catalog.ts` contains the 27 public builtin descriptors from the pinned WebUI source, without callbacks. `webui-status-catalog.ts` contains exhaustive structural tone mappings for the current companion-session, knowledge-job, knowledge-refinement and provider-account auth enum types. `readWebuiStatusCatalog()` is caller-side; unknown labels stay unsupported. Catalog requests hold at the interpretation endpoint rather than generating model evidence for an authoritative enum. The unresolved status adapter supports genuinely issued text references, but does not presume a current dynamic status issuer. The public `judgment-browser/catalogs` entrypoint re-exports only these pure catalogs and erased types. Its browser graph includes no provider, source resolver, log or SQLite implementation.

The adapters return the actual framework readings on both settled and held projections. An item outcome is never weakened to make a compound usable, and held projections contain no business `value`. Published PR41 `2142bab8` supplies the optional `structuralBasis: { method_unknown: 'http-status-not-404' }` for four genuine refusal readings, and held-only `compoundOutcome: 'escalate'` for conflicting facts. A missing valid HTTP status holds before the port. The service consumes `compoundOutcome` as a minimum for the wire `outcome`; it does not emit a second outcome field. The adapters do not synthesize a fifth reading or alter individual outcomes. Both cases are covered through the actual service and decision log in the focused adapter tests.

The source-level adapter API also exports `WebuiDaemonRefusalRun`, `WebuiStatusToneRun`, `WebuiCommandRankRun` and `WebuiPaletteSources`. The run types contain server-only framework evidence; they are not HTTP result types. The surrounding runtime installs the command/error adapters; dynamic status issuance remains deliberately absent.

`webui-specs.ts` exports `daemonRefusalBattery`, `statusToneBattery`, `commandRankBattery`, `mailReplySubjectBattery` and `WEBUI_BATTERY_QUESTIONS`. All are version 1. Questions, item names, criteria and decision sites are fixed. Fixtures are synthetic calibration inputs; offline replay verifies the harness, not real-model calibration or accuracy.

`webui-readers.ts` exports:

- `readStructuredDaemonRefusal(input)` is the caller-side path before the interpretation endpoint; it returns a structural result without probabilities/decision IDs, or `undefined` when semantic reading remains necessary
- `readDaemonRefusal(port, input, { signal? })` interprets unresolved refusals only; known structural cases return `held(unsupported-input)` without a value, model call or decision-log entry
- `readStatusTone(port, input, { signal? })`
- `readCommandRank(port, input, { signal? })`

The asynchronous readers return `Promise<WebuiReadResult<Value>>`; the optional injected `JudgmentPort` supports an honest `unconfigured` result. Only `ready` contains a business value. An unsettled result preserves `confirm` versus `escalate`, including in a compound ranking. Typed per-item evidence is attached by the foundation to the admitted decision log and is not emitted as an executable choice in a non-ready browser result.

## Resolved server projections

The exact types are in `webui-types.ts`. They are **not browser request schemas**.

- Refusal: `{ methodId, message, status?, code?, category?: 'network' | 'authentication' }`. The selected original failure message must retain complete context. Omit stack, body payloads, headers, URLs and unrelated data
- Status: `{ kind: 'text', vocabulary: 'badge' | 'library-dot', status, domain }`, with domain restricted to provider-auth, session, knowledge-job, candidate or account-auth. Alternatively `{ kind: 'structured', vocabulary, tone }` must come from a server-owned published catalog or an exhaustive closed-enum adapter. An unknown enum value is unsupported, never a neutral fallback
- Palette: `{ query, registryVersion, candidates: [{ title, group?, keywords? }] }`. The resolver authenticates and snapshots every identity/revision first, retaining its identity-to-index map outside the log. The reader cannot validate identity uniqueness because it deliberately never receives session IDs. Identical descriptor text may legitimately represent different commands

The browser-facing resolver must reject unregistered, duplicate, stale, cross-principal or unavailable candidate references before constructing a projection. Resolve all candidates before the first model call. Empty query is handled by the browser's ordinary grouped command list; it must not be represented as a semantic ranking with invented probabilities.

## Before provider and logging

The service must establish source access, source/purpose permission, route clearance **and retention policy before any call, state hash or log**. Private text remains private even if the reader's shape scanner finds no credential/card syntax. There is no `public`, `safe`, consent or route flag here. The reader's complete-input snapshot is an additional guard, not admission authority. The service must also preflight the complete source before its own resolver narrows it.

`webui-answers.ts` exports `validateWebuiAnswers(questions, raw)` for the service's pre-log validation seam, plus `withWebuiAnswerBoundary(nonRecordingPort, options?)`. Correct composition is:

1. Non-recording, server-configured port with a source-bound route and current-authority checks at every shared retry/fallback dispatch
2. `withWebuiAnswerBoundary(port, { returnedModels? })`
3. `withDecisionLog(validatedPort, admittedLog)`
4. Service scoped port enforcing registration/question identity and the aggregate budget
5. Reader

If the service owns equivalent validation and metadata scrubbing, it may use the exported validator there rather than wrapping a recording port. The helper rejects a port with a recorder because an outer wrapper would be too late to stop raw answer/failure retention. Strict outputs reject unknown fields/options/items, nonfinite or out-of-range probabilities, unnormalized distributions, and non-maximal choices. The provider's confidence is preserved separately from the selected option's probability, as the [TypeSafe confidence contract](https://docs.typesafe.ai/confidence) requires. Failure messages, causes and provider request IDs are removed before logging. Valid numeric lineage and its local logical request UUID are retained. Requested and actual model provenance remain distinct: the server may declare a calibrated alias-to-version mapping in `returnedModels`; absent a declaration only exact identity is accepted. Never populate that mapping from browser/provider input.

The foundation recording wrapper stores an unsalted state hash. This helper does not make a private, low-entropy query hash anonymous and does not replace a retention policy. Hold private input when the configured log cannot meet its policy. Neither this reader nor the answer boundary can undo an already-retained hash or response.

## Budgets and cancellation

Errors and status use at most one logical call. Errors select all unresolved eligible items together; `method_unknown` requires HTTP 404 even with `METHOD_NOT_FOUND`. Status selects only the registered vocabulary item. Palette reads all candidates (maximum 64) with at most four active calls. Its result represents each candidate once and uses the actual acted-yes probability, sorted descending with input order for ties. One unsettled candidate holds the whole result.

Abort prevents new palette calls and late results cannot produce a ready result. Active cancellation depends on the injected port honoring the signal. The service owns admission/fan-out bounds, provider cancellation, source `assertCurrent()` checks and request/registry/revision echo validation. The shared port owns transient-availability retry/backoff with no total outage cutoff. Source expiry/revocation and caller/runtime cancellation remain authoritative lifetimes, and every transmission and retention boundary rechecks current authority.

The WebUI palette calls the generated authenticated route through `routedFetch` with an abort signal. Its reader binds the response request ID, versions and registry version, requires every candidate's genuine reading and evidence, and maps acted indices to registered local callbacks. Query changes, registry mutations, session snapshot revisions and close/unmount invalidate pending results; execution rechecks registration. An uncertain/held/unavailable response contains no ranked action rows. Clearing the query explicitly restores the unranked command browser. Known status consumers use catalog IDs; unsupported text is visibly unclassified and makes no provider request. Error interpretation now awaits real server-issued references at the asynchronous HTTP caller boundary. The default daemon owner binds the closed source purposes to its configured Jev route and existing decision-log metadata policy. Actual daemon tests use synthetic loopback inference; they do not establish live-provider calibration.

## Mail reply subjects

`webui.mail.reply-subject` adds one fixed yes/no item. The browser supplies only `subjectRef`; settled output is `{ alreadyReply: boolean }`, never generated subject text. `email.inbox.read` may issue `replySubjectRef` only from a canonical complete read whose account epoch, actual mailbox, positive UIDVALIDITY and returned UID are known. Private exact-result maps carry that provenance without accepting browser or sender claims. Ordinary legacy, incomplete or unavailable reads still render but issue no source.

The lease identifies an immutable observed read, not ongoing remote message existence. It authorizes only subject interpretation through the configured Jev route and existing decision-log metadata policy (including the subject-state hash); it never authorizes sending or another mailbox read. Complete original subject screening precedes retention and model work; clipped, ambiguous, protected or unsupported subjects hold. Raw subject, sender, body, account and mailbox values never enter decision-log fields. Only the complete subject is model state.

Config mutations and credential changes synchronously retire account epochs, including ABA changes. Newer source reads, observed mailbox replacement, expiry and shutdown revoke old leases; shared retries recheck fresh authentication, source, purpose and route at every transmission and retention boundary. The WebUI opens an editable draft while waiting. Typing a subject, closing, selecting another message, starting a newer reply, changing client identity or navigating away cancels its pending interpretation. Unavailable or held readings leave the subject unset for explicit owner editing.

The canonical in-memory IMAP fixtures, authenticated request/response tests and recorded-wire browser replay are synthetic implementation proof. They are not live mailbox/provider verification or THE-35 calibration.
