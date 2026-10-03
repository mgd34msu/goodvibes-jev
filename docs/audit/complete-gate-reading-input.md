# Complete gate reading input (THE-117)

The gate previously shortened each string to 4,000 characters before asking Jev, then cached the catastrophic verdict under the complete shell command. The exec-time AST guard could consequently reuse a verdict for a prefix as if Jev had read the whole command. `readToolCall` also reread borrowed command arguments after asynchronous readings, allowing a changed command to receive the original command's verdict.

## Repair

- Keep complete strings in the gate's owned JSON projection, including nested arguments. Freeze the projection and reading state.
- Preserve the existing whole-input privacy inspection and typed input-size/depth/node limits. Unsupported input is refused before a request; it is never shortened into an apparently acceptable action.
- Capture options, cancellation signal and command association once. Publish a single-command cache entry only for the immutable command actually sent to Jev, after checking cancellation. A batch verdict still does not become per-command entries.
- Preserve the exec-time guard and its recorded verdict semantics. No test executes a shell payload or calls a live provider.

## Evidence

`packages/engine/test/gate-input-binding.test.ts` covers long-string suffixes in every gate battery and an uncached exec-time reading, real AST-guard refusal, the short-command cache control, argument/options mutation while requests settle, batch isolation, late cancellation, input bounds, and credential refusal. `gate.test.ts` now requires complete, immutable string content rather than truncation.

Before the repair, a synthetic negative-control run passed its short-command control and failed three regressions: the suffix was absent from requests, a changed command inherited the original verdict, and the actually judged command lost its cache association. The payloads were fixtures only.

This is the bounded gate-reading repair. The existing global cache is still keyed by command text; it is not a complete action/authority/scope receipt. Autonomous outcome selection, live authority revalidation, full-context receipt binding and atomic execution claims belong to THE-116/THE-118 and their consumers. This change neither makes the legacy permission flow autonomous nor converts uncertainty into approval.
