# Inbound email

The daemon composes an inbound-mail supervisor for the configured email account.
Its source can use IMAP or Gmail, with persisted cursors, received-message records,
and verification expectations. Arrival is untrusted input; the watcher cannot
start an agent or a session merely because a message arrived.

The composition in `sdk/src/platform/daemon/facade-inbound-mail.ts` reads
`surfaces.email.inbound.*` settings and stores its state through the daemon's
user-path resolver. `facade-builtin-channels.ts` supplies the adopted Gmail reader
and includes inbound email in the runtime's health reporting. An enabled mailbox
that cannot be composed is reported as unavailable.

Capability checks distinguish a readable mailbox from a connection that exists
but cannot supply the required content. A verification expectation can fail with
`capability-lost` or expire without a matching message; these outcomes are reported.

The [complete design and implementation history](decisions/2026-07-27-inbound-email-design.md)
preserves the authority model, protocol decisions, test plan, reproduced defects,
and their dated dispositions. Its historical findings are not a claim that every
listed defect remains present or that all have been resolved. The
[recorded inbound-mail review](decisions/2026-07-27-inbound-email-medium-findings.md)
retains the supporting review evidence and corrections.
