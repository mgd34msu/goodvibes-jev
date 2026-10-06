# Native intake setup readiness

Setup status is a read-only observation, never an authority grant. Agent uses the
same selected-host resolver and effective token precedence as native intake:
GOODVIBES_CONNECTED_HOST_TOKEN, GOODVIBES_DAEMON_TOKEN, then the existing daemon
operator token file. A fresh `control.auth.current` response must identify an
authenticated admin token principal other than `shared-token`, with
`read:work-ledger` and `write:work-ledger` (or `*`). The coarse `authMode` is not
pairing evidence. Intake and setup share this predicate.

The request is bounded to 1.5 seconds. Disabled connected-host dialing performs
neither the auth request nor setup's TCP service probes. After the response, the
selected host and effective credential are resolved again; any final change
invalidates that observation. No success is cached or restored from setup
receipts, checkpoints, or onboarding markers. Errors are fixed descriptions;
remote error bodies and credential-file parser diagnostics are never displayed.

The synchronous workspace snapshot cannot perform this live check and labels
host/auth readiness unverified. Historical setup receipts remain available as
history and durable evidence, but cannot promote those rows to ready or bypass
an unresolved critical closeout check. Asynchronous setup status can report
current readiness only after its live verification.

Provider/model selection, workspace configuration, Jev availability, execution
scope (`write:fleet`), and a successful assistant turn remain separate checks.
A ready auth row does not prove any of them. Execution still revalidates its own
host-issued authority; setup output never authorizes execution.

This increment does not create or migrate paired credentials, modify a real
daemon, change credential storage ownership, retire the legacy planning flow,
or complete THE-105. Explicit fresh-device pairing and host-bound Agent storage
remain separate work. Tests use synthetic loopback or injected transports and
scratch configuration only.
