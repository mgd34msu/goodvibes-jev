# Explicit Agent pairing

`goodvibes-agent setup pair` previews migration of the selected host's existing
legacy shared operator credential into a named per-device Agent credential.
`--name <name>` selects the device label (default `GoodVibes Agent`). Preview is
read-only. It displays the exact host, label, administrative scope and current
environment-override posture.

`goodvibes-agent setup pair --apply` performs the same fresh preview, then asks
for an exact one-time phrase on an interactive terminal. `--yes`, scripted stdin
and JSON apply cannot bypass that prompt. The phrase is bound in memory to the
host, effective source credential, Agent home, name and observed local pairing
state. Before mutation, the source must still be verified by `auth.current` as
an admin legacy shared-token principal with `write:control-plane` or `*`.
Changed selection, credentials, local state, revocation or cancellation aborts
before the migration request.

Inside the interactive Agent, `/setup pair` remains read-only. The owner can type
`/setup pair --apply` (optionally `--name "Device name"`) to preview the selected
host and administrative scope, then enter the displayed fresh exact phrase.
Only direct terminal command input opens that operation. Model/harness calls,
including `confirm:true`, nested commands, `--yes` and inline phrases cannot
create or replace a credential. No confirmation answer enters normal chat,
input history or model submission. The disclosure and phrase remain in the
display-only transcript; PageUp/PageDown and the mouse wheel can review them
without giving up the operation.

The interactive shell owns cancellation from the beginning of preview through
verification. Escape, Ctrl-C and Ctrl-D cancel even after the answer is submitted;
terminal EOF/close, SIGTERM and shell exit dispose the operation. A typed slash
command replaces it and invalidates its old answer and callbacks. Starting a
new line prompt or modal cancels it; a pending permission/recovery prompt cannot
consume its confirmation. When another surface takes focus or replaces the
visible draft, the abandoned pairing line is drained through Enter/Escape
before that surface can accept an answer. Cancellation suppresses late preview and success
messages. The durable pairing state remains authoritative: an unknown migration
outcome remains unknown, and a stored credential survives interrupted verification.
Run `/setup pair` or `goodvibes-agent setup status` to inspect/reverify rather than
retrying or revoking. Pairing success does not establish provider, workspace,
Jev or execution readiness.

In the standalone command, Enter or an incorrect phrase cancels with exit code 2.
From the confirmation
prompt onward, Ctrl-C and terminal EOF (Ctrl-D) interrupt with exit code 130,
including while awaiting a request or verification reply. Process SIGINT and
SIGTERM also interrupt the earlier preview with exit code 130. Before the
migration request there is no new credential. Once a request may have reached
the daemon, interruption preserves the durable unknown-outcome marker; after
the returned secret is stored, interruption preserves that secret for a fresh
`setup status` check. Closing the command's own terminal reader after successful
completion does not turn success into cancellation.

The action creates persistent **administrative operator access**. It is not a
restricted read-only or ledger-only token. The current daemon migration method
uses its migration-specific mint path, does not revoke the shared token, and
does not replace a same-name record at the ordinary new-device cap. Agent calls
only `pairing.tokens.migrate`, never `create`, `delete` or `revokeShared`.

## Storage and uncertain outcomes

Credentials are stored under the selected Agent home in
`.goodvibes/agent/connected-host-pairings/pairings.json`. The dedicated directory
is 0700 and the file is 0600. Entries are bound to a canonical HTTP(S) origin;
userinfo, paths, query and fragment components are refused. No host aliases are
inferred. The daemon-global `.goodvibes/daemon/operator-tokens.json` is not
changed. Secret values and remote/parser errors are never returned by the
pairing command or preview.

A cross-process-locked, durable unknown-outcome marker is written before the
single migration request. The request has no automatic retry and rejects
redirects. A lost, rejected, malformed, overlarge or interrupted response leaves
that marker in place, including after a process restart. It blocks automatic
reminting. The host's token list may need operator review; the server does not
provide idempotent recovery of the one-time secret. This increment deliberately
provides no implicit reset/revoke/replace operation.

A valid returned secret is durably saved before live verification. This avoids
losing the only copy when verification is interrupted. The final check verifies
the expected newly minted principal. Changed configuration or failed verification
is reported as stored but unverified and never causes another mint.

## Effective credentials and scope

Agent's outgoing host connections resolve credentials in this order:
1. `GOODVIBES_CONNECTED_HOST_TOKEN`
2. `GOODVIBES_DAEMON_TOKEN`
3. Agent-owned pairing for the exact selected origin
4. Existing daemon-global shared-token file, only when no host pairing exists

Corrupt/unavailable or unresolved host-bound storage fails closed instead of
falling back. Symlinked or insecure home/store ancestry is refused, even when a
legacy token is readable; the command does not silently adopt or repair those paths. Environment overrides keep their existing precedence and are never
changed. A newly stored credential shadowed by an environment token is disclosed;
remove or update that override deliberately before expecting native readiness.
Companion QR/manual export is a separate existing bootstrap route, not an export
of the Agent-owned credential.

A verified pair establishes native intake identity only. Provider, workspace,
Jev availability and execution remain separate checks. This is a bounded THE-105
increment; it does not retire the legacy planning workflow or establish hosted,
inbound or derived-continuation authority. Development tests use synthetic
loopback endpoints and scratch homes only.

## Compiled terminal qualification

`src/test/e2e/setup-pair-terminal.e2e.test.ts` runs the native compiled Agent in
a real POSIX PTY against an owned loopback daemon. It types the displayed exact
phrase rather than injecting terminal answers. The suite covers positive
pairing, Enter/incorrect-answer cancellation, Ctrl-C/EOF and process-signal
interruptions, post-storage verification, restart readiness, a killed process
and a daemon-committed migration whose reply is withheld until client timeout.
Unknown outcomes stay blocked after restart, without falling back to the shared
token or minting another credential. Secret redaction, private store modes and
the unchanged legacy token file are checked. No real accounts or providers are
used, and this does not establish hosted/WebUI or cross-platform release parity.

After building the engine and `bun run --cwd products/agent build:binary`, run:

```sh
bun packages/engine/scripts/test.ts --cwd ../../products/agent src/test/e2e/setup-pair-terminal.e2e.test.ts
```

The compiled interactive suite `src/test/e2e/setup-pair-interactive.e2e.test.ts`
drives the actual composer through a POSIX PTY against an owned daemon and
scratch home. It covers the owner phrase, read-only preview, cancellation and
replacement before/after confirmation, interrupted verification, restart without
remint, environment precedence, secret redaction and unchanged legacy storage.
Controller and actual harness-runner tests additionally cover stale responses,
missing shell ownership and nested/model refusal. This is Agent acceptance only;
TUI credential unification, hosted/WebUI and cross-platform parity remain separate.
