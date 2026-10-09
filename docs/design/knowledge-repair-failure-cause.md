# Knowledge repair failure cause

## Scope and original authority

This closes the remaining knowledge self-improvement failure-cause site in the
original THE-13 engine inventory, not THE-19 consolidation, THE-21 ranking, or
THE-35 calibration. The checked baseline is JEV main `4907f783`.

The original inventory is `docs/inventory/engine.md:1709,1985`. Its decision
row describes “isBudgetError classifies whether a caught repair error is budget
or time exhaustion (defer and retry in 6 hours) rather than a real failure” and
asks for the failure-transience reading pattern. We reuse that structural-first,
owned-reading pattern, rather than `readFailureTransience` itself: its unknown
fallback is intentionally retryable and cannot authorize this budget-specific
classification. The choice reading additionally retains truthful request-timeout
versus run-budget provenance while preserving the old confirmed-timeout behavior.

At that baseline, `sdk/src/platform/knowledge/semantic/self-improvement.ts:374`
called `isBudgetError` (line 617). A regex for timeout, timed out, budget,
deadline, or exceeded decided whether a thrown repair failure became a
`deferred` gap and `blocked` retryable task instead of a `failed` task. The real
`KnowledgeSemanticService` invokes that runner for both the whole-store space
loop and scoped runs (`semantic/service.ts:434,455`). Neither caller is replaced.

There are two distinct retry authorities:

- A confirmed timeout/budget disposition sets the task/result retry timestamp
  six hours ahead and uses the existing blocked/deferred path.
- Independently, `markGapRepairAttempt` already assigns a six-hour gap cooldown
  to failed attempts. That generic failed-gap cooldown is unchanged. This patch
  does not claim that a negative or unknown cause eliminates all retries.

## Replacement

1. Capture the installed composition port and model before the repair yields.
   No provider, account, key, endpoint, setting, or caller retry loop is added.
2. Structural facts remain code. The owned timer has an explicit error class;
   typed error categories, HTTP statuses, recognized errno and canonical SDK
   timeout codes settle their respective causes before wording. Typed knowledge
   judgment holds cannot be turned into budget exhaustion by their messages.
   An unknown code is not positive evidence; arbitrary Error names are not
   trusted timeout facts. Cancellation alone is not timeout.
3. Only unresolved free text reaches the registered canonical
   `engine.knowledge.repair-failure-cause` battery. It reuses shared bounded
   failure-state projection and the installed judgment runtime. Complete wording
   passes the existing sensitive-input check before projection.
4. Its typed choices are `request_timeout`, `run_budget`, `other`, and `unknown`.
   Only an actionable timeout or current-work-budget reading authorizes the
   existing deferred disposition. Account spending, context length, quota,
   ordinary network failures, and merely mentioned or negated words do not.
5. Missing, failed, uncertain, malformed, or time-budget-unavailable readings
   preserve the fact that repair execution failed. They do not invent a budget
   cause. Trace data retains the classification basis/outcome, shared retry
   count, and decision-log ID when supplied.

Confirmed request timeouts retain the original deferral behavior; their task
message now says request timeout, rather than falsely claiming local run-budget
exhaustion. The existing six-hour constant is untouched.

## Lifetime and bounds

The repair worker has one owned timer which both rejects the wait and aborts a
cooperative worker. The owned rejection is queued before notifying abort
listeners, so a cooperative worker cannot replace the timer's cause with a
misleading generic rejection. Parent cancellation remains parent cancellation.

The classifier uses only the remaining original run time, with no new minimum
extension. Its signal and before-attempt callback flow into the shared runtime;
that runtime owns pending/retry behavior. A Promise race bounds a custom port
that ignores cancellation. Before retries and after the response, the reader
checks the captured composition/model and the existing gap/task lifecycle guard.
A snapshot of the failed nonterminal task also fences a newer attempt of the
same task ID during classification. The owner rechecks before applying the
disposition. A late reading cannot
resurrect a deleted gap, overwrite a closed task, or apply after cancellation.

Existing run-limit floors, source promotion, task state helpers, and failed-gap
cooldown remain owned by their current modules. There is no change to public
service inputs or configuration keys.

## Evidence

Synthetic tests exercise structural causes against contrary wording, semantic
positives and negatives, uncertainty, absent/unavailable/malformed readers,
shared retry callbacks, cancellation, stale composition/model/task/gap state,
recorded decision provenance, both real service call paths, and the existing
five-second minimum run budget. No live providers or secrets are used.

A detached baseline at `4907f783` runs the same four actual-service regression
cases: both scoped/whole-store semantic positive cases and both misleading-word
negative/unknown cases fail. They pass against this implementation. This is
behavioral regression evidence, not measured model accuracy or calibration.

Final local qualification (synthetic only): 43 new failure-cause tests plus 31
existing self-improvement/runtime/repair tests passed in serial runs. The root
`tsc -b`, SDK type-contract project, engine build, and `api:check` passed under a
shared compiler lock with a 3,904 MiB Node heap cap. The committed API/subpath
surface is unchanged. API Extractor retained existing dependency/ambient-type
warnings; these did not fail extraction or introduce an API diff. No unrelated
full suite or live-provider calibration is claimed.
