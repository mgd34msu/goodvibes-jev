# Contract proof: requested models are not serving-model evidence

As of 2026-10-10, `packages/engine/scripts/contract-proof.ts` reports behavioral
contract assertions separately from model-identity qualification. Exit zero
means the behavioral assertions held; model-identity qualification remains
**UNOBSERVED**. It does not certify Gemini 3.5, Gemini 3.6, or any exact serving
model, and it must not be cited as unchanged-model acceptance evidence.

## Evidence boundary

- The session's `provider.model` setting is a requested model. The proof prints
  it at setup and again for a session-mode transcript.
- Each stored unit route (including best-of-N attempts) is a requested route.
  Missing routes are printed as `(none recorded)`, never inferred from the
  session configuration.
- Every model line explicitly states that the effective serving model is
  UNOBSERVED because the proof evidence does not retain a provider response
  identity. The result repeats this limitation even when all assertions pass.
- `CONTRACT_PROOF_SESSION_MODEL` overrides and the existing default are
  unchanged. This reporting fix does not change routing, discovery, family
  screening, credentials, or provider behavior.

Google's [October 8 release notes](https://ai.google.dev/gemini-api/docs/changelog)
state that requests for `gemini-3.5-flash` redirect to `gemini-3.6-flash`.
That documented policy is not a response-level observation for a particular
proof run. Changing a requested model string would not by itself close this
evidence gap.

## Unresolved requirement: end-to-end response provenance

The [GenerateContent response contract](https://ai.google.dev/api/generate-content#GenerateContentResponse)
provides `modelVersion` and `responseId`. On base
`a389db03e2ff604644df09fa2d83694379f1998b`, the Gemini SSE adapter does not retain
these fields; `ChatResponse` and the contract tree have no serving-model
identity, and the LLM telemetry model label is request-derived.

A separate coordinated runtime change is still required to carry actual
provider-returned identity and response correlation through calls, retries,
fallbacks, streamed responses, session subprocesses, and persisted proof
evidence. Missing metadata must remain unobserved; requested routes, static
catalog entries, and public redirect documentation cannot substitute for it.
One observed response must not qualify all calls in a multi-model run.

## Deterministic checks

`packages/engine/test/contract-proof-model.test.ts` exercises the actual report
formatters with deprecated names, supported names, aliases, custom overrides,
missing routes, control characters, and both behavioral outcomes. It needs no
provider credentials or calls. Run it with the repository's Bun test runner,
or independently with Node 24's `node --test` TypeScript support.

These are reporting tests, not a live proof or a full repository validation.
