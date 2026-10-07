# TUI workstream-start native intake

## Scope

New owner-terminal `/workstream start <request>` submissions now enter the same
`NativeConversationIntakeControls` and native execution flow as ordinary input.
This closes one THE-105 owner-entrypoint gap. It does not complete THE-105 or
retire historical contracts, legacy planning, or other migration gates.

## Source and authority contract

- Both normal command-mode Enter and the desynchronized slash fallback retain the
  original terminal line before trim, tokenization, or expansion.
- The registry's private one-dispatch WeakMap stores the original line alongside
  the command identity. Public context properties are not authority.
- Command syntax is leading whitespace, `/workstream`, intervening whitespace,
  `start`, and one whitespace separator. A CRLF pair is one separator. The
  complete remaining request is unchanged, including extra leading/trailing
  whitespace, duplicate text, combining characters, emoji and line breaks.
- `captureNativeConversationInput` declares file/context references and folded
  paste/image markers. Derived expansion cannot become owner source.
- Generic execution and copied contexts lose the capability; model contexts
  cannot receive it. A private asynchronous dispatch scope also prevents a nested
  handler from reminting it through the reserved terminal entrypoint, even after
  copying the context. The mark expires after dispatch completes.
- The command does not reconstruct a request from argument tokens or invent
  authority from `invokedByModel: false`. Empty input is rejected locally.

## Native routing and recovery

The command uses `routeNativeConversationInput`; no second evaluator or routing
policy is introduced. Jev's native result remains decisive. A work result uses
the existing durable execution-intent and exact native-target path. Only a
permit-bearing, freshly claimed turn result may enter ordinary dispatch.

Missing intake/dispatch bindings fail closed before submission. Existing controls
retain their source/journal bounds, verified principal, host/workspace identity,
single-flight admission, compare-and-swap publication, uncertain-write recovery,
cancellation and late-result fences. The command never falls back to
`contractOperator.start`, an unpermitted ordinary turn, or an alternative runner.

Native intake recovery remains `/work intake-status`, `intake-retry`,
`intake-resume` and `intake-cancel`. Native execution controls remain `/work`.
Historical `/workstream list`, `status`, `cancel` and `reply` preserve their
existing session-scoped legacy IDs and semantics. They do not control new native
work.

## Regression evidence

`workstream-native-intake.test.ts` drives actual terminal handlers through the
registry into native intake controls. It covers both entrypaths, exact text,
source references, native work execution, source-less/model/forged/nested calls,
missing bindings, duplicate pending input, cancellation/late admission, host
replacement, principal-isolated recovery, uncertain capture/journal publication,
and intentionally repeated input. Existing historical command tests retain
list/status/cancel/reply assertions. Shared native intake fixtures keep the
existing recovery suite unchanged.

Independent review identified a nested copied-context remint path; the private
asynchronous dispatch scope and regression test close it. Re-review found no
remaining issue in this bounded change. Live providers, credentials, permissions,
retention, Jev semantics and settlement behavior were not changed or exercised.

The existing compiled-terminal artifact-provenance CI lane also exercises the
actual `/workstream start` command in `host-pair-interactive.e2e.test.ts`. An
isolated real daemon verifies paired authority and captures the exact command
request. The proxy loses only the successful capture acknowledgement; the TUI
reports uncertainty, retains the original journal and refuses a replacement.
A separate unpaired-host case refuses without capture. Both fixtures assert zero
legacy model requests and no unexpected mutations or external network access.
The production binary is not given a test-only command or routing branch.
