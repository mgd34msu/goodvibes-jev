# Typed tool outcomes and retained conversation records

This bounded slice adapts retained-message preservation from upstream SDK
`17eae838461a6529135fe2cad41332d2dc46cb27` onto Jev main
`94fd32636e34314fce4dba1829d9669b02f49453`, with a typed tool-outcome seam for
the TUI renderer. This base includes the independently reviewed PR32 assistant
follow-up metadata and PR33 asynchronous prompt lifecycle, both preserved here.

## Outcome contract

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
This slice does not reinterpret whole-turn exit reasons.

## Retention and provenance

Before the fix, even replacing a conversation with its own provider projection
discarded assistant tool calls, model/provider, reasoning and usage. A retained
tool result could consequently lose the call it answered. `replaceMessagesForLLM`
now restores retained records whole, then invalidates the same cache revision.
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

## Acceptance and ownership

Tests cover actual per-call cancellation plus an unaffected sibling, successful
Error-prefixed content, failure diagnostics, typed cancellation precedence,
synthetic failure, legacy absence, JSON/branch replay, small-window compaction,
next-request call/result pairing, unique copies, additive follow-up metadata,
duplicate occurrence ambiguity, altered call arguments, misaligned projections
and source mutation after retention.

ConversationManager and conversation-utils remain PORT modules: all added
branches use typed execution state and exact structural provenance. Jev
compaction selection and quality readings are unchanged. No async prompt,
system-notice presentation, model-tier, configuration, notification, dependency,
lockfile or semantic-classifier changes belong to this slice.
