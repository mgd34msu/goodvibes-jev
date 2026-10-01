# Awaited account safety readings

Tracks [THE-74](https://linear.app/the-artificery/issue/THE-74/await-account-safety-readings-before-registry-disclosure-and-writes).

`AsyncAgentAccountRegistry` is an additive persistence seam for content readers that need asynchronous work. The original `AgentAccountRegistry` and `SecretLikeTextPredicate` remain synchronous for existing consumers, including email/style-reply. Both registries use the same field validation, normalization, id allocation, duplicate handling, count cap, sweep rules and serialization helpers.

The caller must supply `readSecretLikeText`. There is no default reader and no automatic hosted judgment. Only literal `false` or `{ outcome: 'clear' }` clears a field. Literal `true` and `{ outcome: 'secret' }` identify secret content. `held`, `unavailable`, thrown failures and malformed reader results stop the operation. An unresolved stored record cannot become an empty writable store.

Each operation reads and validates one file revision. A process-wide queue serializes operations from instances with the same resolved path. After every awaited content check, the registry checks cancellation, and before disclosure or mutation it compares the current file's bytes and file identity against the captured revision. An intervening legacy synchronous writer, replacement, deletion or content change causes an explicit retry error rather than stale disclosure or lost updates. The final write uses a unique temporary file and atomic rename.

Cancellation races unresponsive readers, reaches the exact reader signal, and cannot publish a late result or poison a later caller. Reader decisions are remembered only within one operation. Queued cancelled callers never start a reading or mutation.

This does not provide a cross-process transaction lock. The revision check detects changes while asynchronous readings are pending; it is not a filesystem compare-and-swap against a concurrent external writer during the final synchronous replacement.

## Source reconciliation

- `docs/inventory/engine.md`, `sdk/src/platform/google/account-registry.ts`: structural rules remain code, with the content decision supplied by the caller
- `docs/inventory/agent.md`, `src/agent/memory-safety.ts`: still requires the broad `engine.redaction.credential` field/token reading and asynchronous caller propagation
- `docs/inventory/agent.md`, `src/tools/agent-accounts-tool.ts`: refers to `engine.runtime.at-rest-credential`, but that existing reader screens only the `sk-`, `key-` and Bearer candidate spans selected by the at-rest writer

Those two credential readers are not interchangeable. The broad memory-safety reading remains an explicit separate implementation gap. This seam does not rename the narrower at-rest reader or claim its coverage, and adds no credential transmission.

## Validation

The focused suite covers awaited lifecycle operations, literal result validation, pending and failed clearance, malformed existing stores, secret records withheld on read, cancellation before disclosure/write, cancellation while queued, same-path concurrent instances, intervening legacy writes, deletion and same-content file replacement. The original synchronous registry regression suite is run alongside it.

Focused validation: 110 tests passed, 204 assertions across the async account registry, the legacy synchronous registry, and unrelated email/style-reply consumers. The normal workspace build passed. The reviewed subpath API delta adds the async class and its four supporting types; the existing class only loses its extracted private id-allocation helper. Full commit-hook validation is recorded with the commit.

## FIFO correction from PR38 review

Review discussion `r4154236177` reproduced a blocking POSIX FIFO open: `openSync(path, 'r')` could wait indefinitely for a writer before the descriptor could be checked. This also affected the stale-file recheck when a regular file was replaced while the safety reader was pending, and kept the event loop from observing cancellation.

The registry now opens with `O_RDONLY | O_NONBLOCK`, then checks the actual descriptor with `fstat` before reading. The existing before/after descriptor identity and whole-file revision comparisons remain intact. No pre-stat race or special-file empty-store fallback was introduced.

Six externally bounded POSIX subprocess scenarios cover initial FIFO list/write, FIFO replacement during pending list/write, cancellation before the replacement recheck, and ordinary-file disclosure. Before the fix, all four FIFO-open scenarios reached the parent’s two-second deadline and were killed/reaped; the controls passed. After the fix, all six pass and leave each FIFO untouched with no temporary write files. The combined async registry, legacy registry and email/style compatibility run passes 116 tests with 260 assertions. Full normal commit gates are required again for this correction.
