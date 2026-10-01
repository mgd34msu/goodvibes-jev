# First WebUI battery readers

These are server-only definitions and readers for the first three THE-30 registrations. They do not provide an HTTP endpoint, principal/ref store, source permission, route admission, retention permission, provider configuration or browser integration.

`webui-specs.ts` exports `daemonRefusalBattery`, `statusToneBattery`, `commandRankBattery` and `WEBUI_BATTERY_QUESTIONS`. All are version 1. Questions, item names, criteria and decision sites are fixed. Fixtures are synthetic calibration inputs; offline replay verifies the harness, not real-model calibration or accuracy.

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

1. Non-recording, server-configured port with a bounded route, no retries/fallbacks unless every outbound attempt is budgeted
2. `withWebuiAnswerBoundary(port, { returnedModels? })`
3. `withDecisionLog(validatedPort, admittedLog)`
4. Service scoped port enforcing registration/question identity and the aggregate budget
5. Reader

If the service owns equivalent validation and metadata scrubbing, it may use the exported validator there rather than wrapping a recording port. The helper rejects a port with a recorder because an outer wrapper would be too late to stop raw answer/failure retention. Strict outputs reject unknown fields/options/items, nonfinite or out-of-range probabilities, unnormalized distributions, and non-maximal choices. The provider's confidence is preserved separately from the selected option's probability, as the [TypeSafe confidence contract](https://docs.typesafe.ai/confidence) requires. Failure messages, causes and provider request IDs are removed before logging. Valid numeric lineage and its local logical request UUID are retained. Requested and actual model provenance remain distinct: the server may declare a calibrated alias-to-version mapping in `returnedModels`; absent a declaration only exact identity is accepted. Never populate that mapping from browser/provider input.

The foundation recording wrapper stores an unsalted state hash. This helper does not make a private, low-entropy query hash anonymous and does not replace a retention policy. Hold private input when the configured log cannot meet its policy. Neither this reader nor the answer boundary can undo an already-retained hash or response.

## Budgets and cancellation

Errors and status use at most one logical call. Errors select all unresolved eligible items together; `method_unknown` requires HTTP 404 even with `METHOD_NOT_FOUND`. Status selects only the registered vocabulary item. Palette reads all candidates (maximum 64) with at most four active calls. Its result represents each candidate once and uses the actual acted-yes probability, sorted descending with input order for ties. One unsettled candidate holds the whole result.

Abort prevents new palette calls and late results cannot produce a ready result. Active cancellation depends on the injected port honoring the signal. The service owns the total deadline, actual outbound-attempt accounting, provider cancellation, source `assertCurrent()` checks and request/registry/revision echo validation. Reader bounds and concurrency do not authorize unbounded provider retries. Buzz's service descriptors and real production caller/source paths still need wiring; these modules alone do not constitute endpoint completion.
