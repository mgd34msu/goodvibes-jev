# Selected-home companion-token bootstrap

THE-18 remains **In Progress**. This increment restores the shared token used by
an explicitly composed CLI host and its existing clients. Default inbox-provider
composition, remote-cluster behavior, native packaging and live acceptance
remain separate obligations.

## Source and ownership

Pinned daemon source is `mgd34msu/goodvibes-daemon` commit
`254699bf5d834cdca41436211ada1ae32bf89258`, `src/daemon/cli.ts` lines 687–715.
The bounded PORT adaptation lives in `products/daemon/src/cli/serve.ts`:

- Call the existing `getOrCreateCompanionToken('tui', ...)` owner using the
  canonical, already-resolved `daemonHomeDirectory`. The historical surface
  argument and `<daemonHomeDirectory>/operator-tokens.json` identity stay intact.
- An explicit `GOODVIBES_DAEMON_TOKEN` takes precedence over that stored token;
  `GOODVIBES_HTTP_TOKEN` takes precedence over the effective daemon token for the
  optional HTTP listener. Overrides affect this process and do not replace the
  persisted companion identity. Clients using an override must use that same
  override; a different stored token does not authenticate the running server.
- Reuse the existing token record byte-for-byte on restart. Never search another
  daemon home or adopt workspace-scoped token files.
- Keep acquisition inside the process owner's admitted `start` operation.
  Invalid CLI/default-uncomposed serving and shutdown before startup admission
  create no token. Once acquisition is admitted, the persistent identity remains
  even if a later bind/start fails or shutdown is requested.
- Preserve the actual host's signal fences, restart ownership and awaited drain.
  Generic `createDaemonHost` embedding semantics are unchanged.

The adoption helper `resolveDaemonCompanionToken` is not used: it deliberately
persists explicit overrides, which would change this upstream boot contract.
Token pruning, QR/pairing display, public-URL persistence and service adoption
are not implemented by this slice.
The subsequent [functional startup pairing slice](daemon-functional-pairing-startup.md)
adds display using the effective token, with a separate trusted local output
boundary; it does not add pruning, public-URL persistence or service adoption.

## Publication and recovery

The existing engine companion-token owner publishes a complete sibling file
through the shared atomic JSON writer, with mode `0600` and the existing JSON
format. The shared writer rejects short writes before rename in both modes.
Default mode retains its existing file flush, chmod and atomic rename behavior;
this is not a new claim of complete pathname-ancestry durability on every OS.
Pre-publication errors fail startup without replacing an existing complete
record. No separate token persistence or generation implementation is added.

The existing unreadable-store quarantine behavior is retained. The CLI reports
that a new identity was created and paired clients must pair again, and states
whether the previous bytes were preserved. The warning contains neither token
bytes nor the unreadable file's body. Shutdown requested synchronously by that
reporting port prevents graph acquisition. This is not a cross-process token
creation lock: concurrent first boots may still publish distinct complete
records, with the last rename winning.

## Verification boundary

Tests use owned temporary homes, synthetic identity records and loopback hosts.
Admission tests cover signals, explicit shutdown, invalid owner options and
refused CLI paths before acquisition. Emitted dispatcher tests exercise actual
start/status and HTTP/WebSocket authentication with selected-home records,
restart preservation and explicit override precedence. Persistence regressions
exercise publication failure and owner-only file mode.

No real user credential, provider account, remote host, service installation,
security setting, release or deployment is provisioned. Live account/provider
proof and complete original daemon acceptance remain unestablished.
