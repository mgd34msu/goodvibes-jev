# Bounded daemon command executable and explicit serving launcher

THE-18 remains **In Progress**. This increment supplies a real command dispatcher
and composes an explicitly supplied inbox into the existing owned daemon host.
It does not supply a default provider factory or claim native release parity.

## Source disposition and callers

Reviewed source: `mgd34msu/goodvibes-daemon` at
`254699bf5d834cdca41436211ada1ae32bf89258`, `src/daemon/cli.ts`, blob
`5e8e7aff5a82fbdc604d3a0d637078a35497e058`. The original inventory disposition
is PORT. The following bounded adaptation is deliberately not a completed
migration mapping for that whole file:

- `products/daemon/src/cli/entrypoint.ts` is the side-effectful Bun process entry,
  imported by the checked-in package bin `bin/goodvibes-daemon`; `cli/index.ts`
  remains import-inert.
- `cli/run.ts` adapts command/help/error dispatch and awaits the already-ported
  asynchronous config adapter. Existing one-shot adapters keep their own actual
  HTTP/WebSocket, service, receipt and settings behavior. No second runtime is
  constructed for a one-shot command.
- `cli/configuration.ts` resolves the canonical tree/identity homes, daemon tier
  and historical `tui` surface. Flags override a copied environment instead of
  changing the parent process environment or cwd. Provisioning resolves only
  ownership, without opening/migrating unrelated settings.
- `cli/serve.ts` applies runtime-only overrides and wires real config, event bus,
  store and explicit inbox into `createDaemonHost` via `runDaemonProcess`. Those
  existing owners retain restart fences, startup rollback, boot drainage,
  signal admission and the 15-second terminal deadline. Host capability opt-ins
  remain explicit in the launcher's runtime options. No lifecycle implementation
  is copied from the historical unawaited shutdown.
- Service activation needs both the caller's explicit runtime composition and
  installed executable path. Overridden tree/identity homes refuse because the
  current service builder cannot preserve them. The selected ConfigManager is
  passed through. The uncomposed package refuses before service work.
  Standalone `send` now has a separate lazy composition; see
  `docs/audit/daemon-standalone-send.md` for its bounded contract.

The package remains private with its original version. Build emits the actual
script/shebang and declarations. Package files include source and dist to honor
both existing Bun and ESM export conditions. This is Bun-script packaging;
installer/native binary, release, service adoption and update-artifact parity
are separate acceptance work. No release or deployment is performed.

## Why default serve remains blocked

The canonical schema has no inbox-disabled setting. `registerInboxSurface`
requires explicit membership for every configured/unavailable provider and
must not silently substitute an empty set. Slack/Discord adapters are private
prerequisites requiring a trusted preview mapper; Discord also requires a
complete account-bound DM catalog, for which no production implementation is
currently established. Email adapter composition is absent. This increment
neither changes these privacy/availability boundaries nor adds a made-up
"disabled" setting to conceal them. Legacy IMAP work is untouched.

Broader upstream CLI behavior is still unmapped: default intake/triage,
automatic service/update lifecycle, LAN/provider discovery, remaining pairing
startup work, global transport configuration, and release/native
packaging. The strict migration gate and six deferred upstream acceptance items
remain open. The changed README does not supersede that ledger.

Shared selected-home companion-token bootstrap is now adapted in the admitted
CLI startup path; see [its bounded source/caller audit](daemon-companion-token-bootstrap.md).
This does not complete the remaining pairing display, cleanup or adoption work.

## Verification and live-proof boundary

The emitted entrypoint tests exercise help/version/completion and argument
refusals before acquiring configuration, correct nonzero default-serve/service
activation refusal, and awaited config receipts persisted across separate
processes in the selected identity tier. A guarded fixture launcher imports
the emitted dispatcher, supplies a synthetic provider to the real registrar,
and runs actual loopback HTTP status/inbox through the real host. SIGINT and
SIGTERM during an admitted held poll cannot exit successfully before that poll
settles; the listener is closed afterward and runtime endpoint overrides are
not persisted. Synthetic identity, metadata and provider seams are explicit.

There are no live account/provider/credential/mail/payment/inference/remote-host
calls, actual host-service changes, installation, release or deployment tests.
Full original daemon acceptance and live proof are not established here.

## Dispatcher corrections found during independent review

Offline probes reproduced and the final path repairs ignored feature-override
refusals, explicit-provider precedence for qualified model flags, doubled OSC-52
escape output, provisioning help accidentally reaching the download adapter,
and migration into the default identity instead of the selected daemon tier.
Service activation with overridden homes is explicitly refused before any
service inspection/mutation, rather than generating a unit that relaunches
another tree or identity. Existing service mutation policy is unchanged.

The Bun lock's daemon workspace bin metadata now matches the package manifest.
Frozen installation links the binary in the actual Agent and TUI consumer
workspaces; the root is not a daemon dependency consumer. The emitted CLI tests
assert the manifest, lock, shebang and resolved consumer links, and execute
those actual bin links. A checked-in executable launcher exists before dist is
built: Bun does not create bin links for a missing dist target during a fresh
frozen install. A disposable dependency-free workspace proves frozen install
before emission, then invokes that same launcher against its emitted fixture. Tarball smoke
checks use the existing built workspace dependencies, not a registry release.

Service commands and strict wake provisioning preserve their original stdout
receipts even when an absent/stopped/degraded result has a nonzero exit code.
In particular, `service-status --json` remains consumable from stdout for both
exit 3 (installed but stopped) and exit 4 (not installed); the exit status does
not silently reroute that ordinary state document to stderr. Dispatcher-level
fixtures cover this without invoking any real service or download.
