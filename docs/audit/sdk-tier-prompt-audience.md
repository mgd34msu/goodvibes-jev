# Tier prompt audience and cancellation

This narrow prerequisite adapts the audience-specific guidance introduced in SDK
`14f3eaf19abc9092ab4db9168b28516486a780e1`, as present at reconciliation target
`17eae838461a6529135fe2cad41332d2dc46cb27`, onto Jev base
`ef9baaddbc6abe47eadbfeebe7bd65eead12c3cc` (after the reviewed channel-capability merge).

## Public contract

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

## Cancellation boundary

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

## Proof and ownership

Focused tests cover default-agent compatibility, exact upstream conversation
guidance, unsettled-tier behavior, facts/site/signal identity, pre-cancellation,
cached and deferred results, two callers sharing a read, late rejection,
listener cleanup, reader failure, and private abort-reason containment. Existing
tier tests remain in the compatibility run.

The providers barrel exports the audience and options types. Its inventory
category stays PORT. The tier-prompt module stays JEV because the tier still
comes from the implemented routing.model-tier reading; audience selection and
AbortSignal state are structural branches, not new semantic readings.

This is the SDK prerequisite only. Product selection of the conversation
audience and the awaited getSystemPrompt(signal) lifecycle are owned separately.
No core prompt, follow-up, compaction, notification, context-window, config-schema,
dependency or lockfile changes are included.
