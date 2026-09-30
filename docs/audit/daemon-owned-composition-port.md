# Daemon owned runtime adapters

Pinned source: `mgd34msu/goodvibes-daemon` at
`443e5ee4d6cda0d36d57e2886398d0836074a4a9`.

Three original runtime adapters now compose real engine dependencies inside
the partial daemon product: credential/identity services, mail dependencies,
and disposal wiring. Full `createRuntimeServices`, handler aggregation and the
daemon entry point remain absent; these are tested prerequisites, not a boot
proof or replacement graph.

## Credential and mail contracts

Credential composition passes the supplied global/workspace homes and optional
daemon-home override to the real product secret manager. It shares that manager
with the step-up verifier and reads pairing metadata only at the injected path.
Tests use dummy values in owned temporary homes; they do not enroll credentials,
mint pairing tokens or change real host security settings.

Mail composition retains the public surface-to-email config/secret adapters,
node transport and neutral sender-claim describer. Tests never call transport.
They verify explicit TLS/STARTTLS settings, distinct missing-configuration and
missing-credential refusals, and the literal `commandAuthority: 'none'` boundary.
No outgoing message, account connection or raw inbox content is used.

## Awaited disposal

The shared existing `createDisposalScope` remains synchronous and unchanged.
A separate `createAsyncDisposalScope` is exported through the same runtime
`disposal` subpath. It runs synchronous callbacks immediately, waits for newer
asynchronous owners before older dependencies, and continues after failures.
`close()` rejects with recorded failures after cleanup; `dispose()` is a safe
compatibility wrapper that logs failures and leaves them observable through
`close()` rather than generating unhandled rejections.

Late registration starts cleanup immediately and never reopens the scope. An
in-progress close includes late work, including further late work it registers.
If registration happens after a close settled, the late cleanup still starts
immediately and a subsequent close drains it. An already-settled promise cannot
cover registrations in the future. Reentrant synchronous disposal is supported;
a callback must not await the close of its own containing scope.

The product adapter now requires `daemonHandlers.close(): Promise<void>` and
registers it last so it drains first. Final handler aggregation must implement
that boundary over actual intake/remote owners, and the eventual runtime root
and shutdown/leadership-transfer callers must await scope close. Merely calling
the compatibility wrapper is not evidence that ownership has transferred.

## Verification

- Twelve engine lifecycle cases cover reverse ordering, idempotence, awaited
  children, failures, late registration, reentrant disposal and diagnostics
- Nineteen selected engine compatibility tests include the unchanged legacy
  disposal/poller contract; 54 assertions
- Ten new product composition tests cover injected ownership and all twenty
  registered cleanup owners; 29 assertions
- All current product tests: 148 tests across eleven files, 2001 assertions
- Public consumer type fixture keeps old synchronous and new awaited contracts
  distinct; full engine/product build and three-stage typecheck pass
- Four additive public exports recorded (9829 SDK exports); compiled Node
  smoke verifies awaited order and the unchanged synchronous scope
- Browser-neutral, architecture, judgment and no-skipped-tests checks pass

All execution uses guarded fixture tests and local dummy stores. Final runtime
boot, live endpoint/privacy proofs, upstream-delta reconciliation and complete
product parity remain pending.
