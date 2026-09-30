# Daemon draft-sync host hoist

Pinned source: daemon `443e5ee4d6cda0d36d57e2886398d0836074a4a9`, `src/daemon/handlers/drafts/{draft-store,register,index}.ts` and the matching original tests.

## Preserved behavior

The host mirror retains `.goodvibes/tui/operator/drafts.sqlite`, schema, caller-supplied modification timestamps, full-snapshot optional-field clearing, first creation metadata and send-pipeline metadata. Body and webhook are encrypted through the existing daemon cipher port. Wire records contain a 12-character SHA-256 body digest, never the body; webhook presence is always redacted. The four canonical `channels.drafts.*` descriptors, access metadata, confirmation AND explicit-user-request checks, input bounds and refusal wording remain intact. No new semantic guess or model call is introduced.

The existing payments registration/confirmation helper is moved without policy changes to `control-plane/host-handlers.ts`, exported through the existing public control-plane barrel. Its old payments path re-exports the same functions and error alias. The original daemon `handlers/register.ts`, `handlers/errors.ts` and matching small contract test are narrowly reclassified from PORT to HOIST because both payments and drafts share these rules; other product handler modules are not reclassified. `GatewayVerbError` remains the canonical error implementation already used by payments, retaining code/status/message rather than adding another class.

## Reproduced defects and owned lifetime

Four regressions fail against the imported store: closing SQLite while encryption is pending, initialization reopening after close, mutable input changing digest/metadata after body encryption started, and concurrent same-ID snapshots both claiming creation. The store now owns each admitted input snapshot and queues upserts in call order. Its awaitable close stops admission and drains initialization, encryption and persistence before releasing SQLite. Direct callers must await mutations before using synchronous read/delete methods; the store does not invent automatic persistence for an un-saved direct upsert.

The registrar keeps its callable legacy teardown and adds `close(): Promise<void>`. It stops handlers immediately, drains complete accepted handlers through persistence, and closes only a store it constructed. Mutating handlers are serialized so a later delete cannot be undone by an earlier save still encrypting. Failed initialization can retry. A separately reproduced restart case removed canonical descriptors; first close now restores those descriptors handler-less, and repeated old teardown cannot erase replacement handlers. A replacement must wait for the old close to complete. Cleanup failures remain observable to awaiters and produce value-free diagnostics for legacy callers.

## Evidence and remaining gates

Original store/registration assertions are retained with import, owned-temp and awaited-cleanup adaptations. Added tests cover delayed encryption, initialization and close, input capture, same-ID ordering, failed encryption isolation, accepted-save persistence, borrowed ownership, descriptor reuse, retry, save/delete ordering and cleanup failure reporting. Fake ciphers, memory-only fixture key stores and owned temporary files are used; no user credentials or live channels are accessed.

This hoist is a prerequisite for the real product handler composition. Full daemon boot/shutdown, original whole-product parity, source-delta reconciliation, combined branch integration and live judgment proof remain separate pending gates.
