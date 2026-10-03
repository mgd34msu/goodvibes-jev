# Agent memory credential containment: bounded public-contract adoption

## Baseline and scope

Audited against main `6b8f84e7434420d1736459db34a74813088a6e9a`.
`products/agent/src/agent/memory-safety.ts` is a synchronous refusal predicate,
used directly by memory entry points and indirectly through PersonaRegistry's
shared assertion by local record stores. It is not a journal redactor.

The original four guards miss concrete issuer formats that the engine already
owns, including GitLab, Slack, AWS and GitHub fine-grained tokens. The engine's
`redactIssuerCredentials` is not an equivalent predicate: despite its name it
also masks registered profile values. Interpreting every changed output as a
credential would reject legitimate local personal memory. Marker-string
inspection would invent an undocumented classification protocol.

## Implemented boundary

A pure `containsIssuerCredential(text): boolean` export on the existing public
`@goodvibes-jev/engine/sdk/platform/utils` subpath shares the engine's canonical
issuer-format patterns. It consults neither profile/identity readers nor any
judgment provider. Agent adds this predicate before the existing four guards.
Existing refusal wording, synchronous APIs and reject-before-write semantics
remain unchanged. No bootstrap mutation or new background work is needed: the
existing caller graph imports the predicate directly.

This is additive issuer containment, not complete semantic migration. Existing
PEM, short `sk-`, broader GitHub and assignment guards remain. Their known false
positives and their protection must not be silently dropped. Ambiguous `key-`
and `Bearer` candidates are not newly refused; ordinary documentation, secret
references, registered personal details and paths remain valid memory.

## Why not the at-rest judgment reader

`readAtRestCredentialSpans` is an internal engine journal helper, not an
export on the current public runtime barrel/export map. It currently:

- sends candidate plaintext and nearby context in judgment state;
- has no caller AbortSignal/deadline parameter;
- remembers decisions process-wide, keyed by a hash of candidate value rather
  than its context or the persistence action;
- addresses journal candidate masking, not every memory field or assignment.

Calling it here would expose potentially real credentials to the model, change
synchronous persistence into unbounded asynchronous work and potentially reuse
an unrelated journal allowance for a new durable memory write. The unchanged
synchronous protection remains available when no judgment provider is installed.
There is no new asynchronous operation to cancel or race with persistence.

## Account preflight before taint judgment

The accounts tool previously evaluated the outward-effect/taint policy before
calling the registry's credential validation. A tainted turn could therefore
send a protected account field to a judgment provider before the eventual
persistence refusal. The tool now captures its five record inputs once and
screens them with the shared memory-safety predicate before policy evaluation.
This includes `serviceDomain`, which also appears in the policy description.
The same captured values then feed policy and persistence. No issuer pattern is
duplicated and no owner-profile value is classified as a credential.

The preflight is a refusal only. Benign account records still invoke and obey
the existing outward-effect policy, and the registry retains its independent
write-time validation. A real bootstrap-composed registry test retains
untrusted page content and checks 45 protected-value/field combinations: zero
judgment requests, static non-secret errors and no account record. Benign
controls exercise both policy refusal and allowance. Removing just the
preflight produces four judgment requests on the first synthetic secret case,
which the negative control detects before any persistence result is mistaken
for privacy protection.

## Required semantic follow-on contract

Before replacing the compatibility guards, design and test a memory-appropriate
screening port with:

1. Protected inputs: established issuer formats handled locally first; no raw
   credential candidates or unsanitized neighboring content sent to a model.
   Specify exactly what structural/context evidence may cross the boundary.
2. Per-operation cancellation and a bounded deadline/work budget. Cancellation,
   unavailable provider, malformed response and uncertainty must never authorize
   persistence; cancellation must prevent the caller's subsequent write.
3. Decisions bound to the exact field set, context and operation. No journal's
   process-wide value-only allowance may be reused to authorize memory writes.
4. An explicit safe fallback and reviewed confidence rule for ambiguous spans,
   including benign prose, profile values and valid secret-store references.
5. Atomic validation-before-write across create/update/import/editor/tool entry
   points, with real composition tests and no check/write gap introduced by an
   await. Address caller APIs deliberately rather than silently returning a
   Promise where a synchronous predicate is expected.

The stale inventory reference `engine.redaction.credential` is not an existing
public implementation contract. This change does not claim that reading is
implemented or that THE-63 semantic migration is complete.

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

Validation performed on this branch:

- 20 engine tests: public predicate and existing at-rest redaction suite.
- 171 Agent tests across 19 memory, persona, registry, CLI and onboarding files.
- Negative control: removing Agent's public predicate call fails four new
  persistence/composition regressions; the benign-memory regression still passes.
- Engine declaration build, engine test/script typecheck and Agent
  production/test typechecks passed.
- Compiled JavaScript public-subpath import smoke passed under Node.
- Official subpath API regeneration adds only the predicate's five-line entry;
  the subpath API check passes.
- Product workspace check, credential-scope check and `git diff --check` passed.

These are scoped checks, not a full product/engine test suite or release gate.
No model requests or real credentials are needed.

## Composition repair after reciprocal review

The first draft's valid-record preflight was too late for malformed tool calls:
parameter auto-repair runs before a tool's execute wrapper. Account and local
registry registration now install a registry-entry guard that snapshots the
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

Five actual bootstrap regressions cover malformed account and memory arguments
(including nested spare input), protected source text/origin, and cancellation
while a provider is paused. All five fail with the previous production source
and pass with the repair. Additional shared-engine tests cover already-aborted,
late provider completion, queued work, recorder suppression and active-signal
allow/refuse/uncertain behavior. These repairs do not replace semantic credential
screening or expand the original claim beyond protected-format containment.
