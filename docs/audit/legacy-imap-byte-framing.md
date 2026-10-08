# Legacy email IMAP literal framing

THE-49 repairs the richer email client/session used by daemon inbox reads and
inbound polling. The newer intake client already had original-byte framing;
its repair did not cover this reachable older path.

## Ownership and caller mapping

The daemon's `runtime/mail-composition.ts` provides `nodeEmailTransport` through
`withSurfaceEmailConfig`. Its service graph reaches the email inbox routes and
`EmailService`, which constructs the richer `email/ImapClient`. The inbound
watcher's `email/inbound/connection.ts` also constructs that client. Both use
one persistent `ImapSession` for the lifetime of their connection.

Previously that session enabled UTF-8 socket decoding before counting literal
bytes, then folded each literal into its announcing syntax string. Replacement
characters for non-UTF-8 octets and partial multibyte peeks changed byte counts;
quote-, whitespace- and NIL-leading literal content could be read as syntax.

The session now receives bytes and reuses the intake reader's byte framer,
extracted into `email/imap-wire-frames.ts`. It isolates the declared octets
before text decoding, retains literal kind separately from syntax, and keeps
partial frames until complete. Oversized or invalid literal lengths fail the
connection. Only syntax outside a literal can complete a tagged command.

The internal `commandFrames` path reaches envelope batches, previews, full
message headers/parts/fallback, the body-capability probe and LIST folder
selection. FETCH readers reuse the canonical framed parser, including UID
identity after the payload. BODYSTRUCTURE literals become escaped quoted
values for the existing S-expression reader; marker discovery is confined to
actual FETCH syntax, outside quoted/literal values and other server prose.
LIST uses the complete literal folder name instead of treating it as an atom.

Public client results and existing string command/IDLE listener shapes remain
unchanged. String parser inputs remain supported for scripted callers. The
historically lenient multiline-quoted section reader is used only after a
failed canonical parse with no literal values present, so that compatibility
path never flattens a transport literal back into syntax. Socket framing does
not infer message charset; existing text decoding behavior remains unchanged.

## Synthetic verification

An in-memory byte transport drives the actual legacy client and session. It
models sockets that decode only if explicitly requested. On the unmodified
main baseline, nine of fifteen selected actual-client cases fail. Regressions
cover quote/NIL/whitespace-leading text, zero and multiple literals, non-UTF-8
bytes, partial multibyte peeks, arbitrary byte splits, trailing UID, forged
FETCH/completion text, full reads, body-capability truth, and quoted structure
filenames. They also cover timeout/cancellation, literal bounds, buffered
notifications, synchronous subscriber reentrancy and early completions.

The existing email/inbound protocol suites, including cursor-attribution
properties and IDLE lifecycle cases, are rerun alongside the newer intake
framing cases. Build, type, API and exact-head CI results belong to the PR's
verification record. This document does not imply those gates passed before
that record exists.

No live mailbox, account, credential, provider endpoint, outbound message,
release or deployment is part of this proof. All new transport tests are
in-memory; existing protocol tests use owned synthetic fixtures.
