# TUI-owned host pairing

Native `/work`, native headless intake and legacy work-import commands resolve a captured credential from `.goodvibes/tui/connected-host-credentials/credentials.json` under the selected TUI home. Records are keyed by canonical HTTP(S) origin: scheme, host and port. Another origin does not receive this credential. Paths, user information, queries, fragments and ambiguous input are refused.

No native path reads the Agent's private store, the daemon-global operator token or an environment credential. Missing, unsafe and indeterminate stores fail closed. Resolution is passive: no directory creation, credential generation, adoption, fallback, repair, rotation or revocation. Reading a saved credential does not grant write/admin authority; live read scopes remain sufficient for supported reads. Native submission/intake separately require the live authenticated non-shared token principal, administrative authority and read/write-work-ledger scopes.

## Explicit owner-terminal migration

The existing `goodvibes pair` and `/pair` still create companion/WebUI handoffs. This separate TUI flow is:

1. Run `goodvibes host pair` to inspect the current host. An existing saved credential is live-verified without being replaced.
2. If no TUI credential exists, explicitly select the legacy bootstrap: `goodvibes host pair --bootstrap-shared`. This reads the existing owned mode-0600 `.goodvibes/daemon/operator-tokens.json` file. It never creates or repairs that file. It discloses the bootstrap before making an authenticated read to the selected host.
3. Review the exact origin, device name, persistent administrative authority (including native work and fleet execution), TUI-local storage and the fact that the shared token remains active.
4. Run `goodvibes host pair --bootstrap-shared --apply`. In that owner terminal, enter the new exact `PAIR ...` phrase shown after preview. A previous phrase, `yes`, piped input and `--yes` cannot authorize it.

`--url <exact-origin>` selects an in-memory endpoint for this command only. It does not persist a new endpoint or enable a disabled daemon. `--name <device-name>` supplies a non-secret device label. Command-specific flags follow `host pair`; unsupported options are rejected. No credential is accepted in an argument or printed.

Inside the live TUI, the owner can instead type `/host pair` to inspect the selected host, `/host pair --bootstrap-shared` for the explicit migration preview, or `/host pair --bootstrap-shared --apply` to review and enter a fresh phrase. Interactive `--name <device-name>` accepts one non-whitespace token; use the standalone quoted argument for labels containing spaces. The interactive route uses the configured host and does not accept `--url`.

Only the direct terminal-input dispatch has the private, one-dispatch owner mark. Generic registry calls, model/harness contexts, copied or forged contexts and nested commands cannot apply, even when a generic confirmation callback returns true. Their no-apply route remains passive local inspection and cannot authenticate a bootstrap. `--yes`, inline phrases and other unsupported arguments are rejected. `/pair` retains companion/WebUI meaning. Concealed adoption and replacement remain outside this increment; TUI and Agent credentials stay separate.

The interactive shell owns input from before preview through revalidation, migration, durable save and verification. Escape, Ctrl-C, Ctrl-D, EOF, shutdown and an explicit replacement slash command abort that lifetime. Input queued during preview, including a pasted command plus answer, cannot answer the subsequently displayed fresh phrase. Multiline pasted answers cannot confirm. An opened modal, blocking prompt, concealed input or voice/composer takeover invalidates hidden confirmation immediately. The abandoned line is quarantined through Enter, Escape, Ctrl-C or Ctrl-D before the new prompt can consume input. Late responses cannot restore hidden input ownership or print stale success.

The exact host, device name, complete persistent-administrative scope, TUI-local secret storage and continuing shared-token authority remain in display-only transcript prose. The prose rewraps to current terminal width and is scrollable; resize or transcript rebuild cannot clip it into a one-line notice. Pairing disclosure and the confirmation answer do not enter model history.

The standalone route runs before ordinary startup, onboarding, daemon adoption or model/tool composition. An apply request requires both stdin and stdout to be terminals. The terminal owns input through preview, revalidation, migration, durable save and verification; Ctrl-C, EOF and process termination abort it. Pre-prompt lines and partial typeahead cannot answer the fresh prompt.

## Durability and interruption

Confirmation revalidates the selected origin, TUI home, bootstrap token, current local pairing state and the host's live shared-token `write:control-plane` authority. A private durable `unknown` attempt is published before exactly one migration POST. Independent processes use a strict ownership lock and compare-and-swap; concurrent attempts cannot both mint for the same origin. Requests reject redirects and responses are bounded and validated.

The credential is saved before checking the expected `pairing:<id>` principal. Cancellation before intent creates nothing. Cancellation, timeout, invalid response or restart after intent preserves `unknown`; it never retries minting, resets the record or revokes anything. Cancellation or verification failure after durable save preserves the only secret and reports `paired-unverified`. Rerun `goodvibes host pair` or the live terminal’s `/host pair` to inspect it; missing verification is not permission to remint.

For `unknown`, review the original host's device list with its owner before considering any manual recovery. This CLI exposes no automated reset, replacement or revoke action. Do not delete the recovery marker to make a failed command run again.

The store refuses corrupt/oversized data, unsupported schema, duplicate origins, unsafe ownership/modes, symlink ancestry, symlink files and hard links. It uses atomic durable mode-0600 files inside a mode-0700 private store directory. Existing insecure paths are not silently changed. Current storage qualification is POSIX: on a runtime lacking effective-user ownership verification, pairing fails closed instead of claiming Windows support.

## Validation boundary

Tests use synthetic credentials, scratch homes and owned loopback fixtures only. Store, resolver and transport suites cover origin isolation, no fallback, durability faults, concurrent attempts and credential/home/endpoint replacement. The exact-artifact CI lane runs both standalone and interactive compiled real-terminal tests against the production daemon's migration contract, including fresh confirmation, queued input, restart/cancellation recovery, process termination, and resize disclosure. Credential or endpoint changes invalidate pending readers, discovery, preflights and queued mutation permits.

Successful pairing establishes the expected host credential only. Provider setup, workspace trust, Jev state, native evaluator semantics, admission and execution readiness remain independent checks.
