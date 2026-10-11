# Troubleshooting

## The daemon will not start

Start with the actual failure on stderr or the platform service journal. The CLI
reports parse refusals synchronously and exits 2; an unknown command never starts
a daemon. Startup and drain failures exit 1. Check the spelling and selected home
before changing configuration.

```sh
goodvibes-daemon --help
goodvibes-daemon service-status --json
journalctl --user -u goodvibes.service -n 100 --no-pager
```

The journal command is for the default Linux systemd user unit. On macOS, inspect
the selected launchd unit and its stdout/stderr paths; `service-status` names the
platform/name/definition. A custom service name/path must be checked as configured.
The shipped partial launcher refuses install/start/restart/migrate unless supplied
an explicitly composed installed executable and canonical, non-overridden homes.
A refusal is not evidence of a failed service installation.

Configured Slack/email sources need explicit account and trusted local screening
owners. Merely filling token settings does not construct that authority. A fresh,
unconfigured inbox may boot; configured missing/unreadable authority refuses with
owned rollback instead of silently becoming an empty inbox. Configured Discord
inbox/DM catalog qualification remains open. See [deployment boundaries](../README.md)
and [production intake contract](../../../docs/contracts/daemon-runtime-ownership.md#production-intake-and-selected-transport).

Malformed settings are not treated as safe defaults. Preserve the file and fix the
reported key/schema/version issue; do not delete safety constraints to force boot.
Provider readiness and source authority are separate: an unavailable model or a
cached provider does not grant protected-source access.

## Logs and lifecycle history

Fatal boot diagnostics do not depend on an activity logger being initialized.
The engine activity logger, when initialized, writes
`<working directory>/.goodvibes/logs/activity.md` and rotates at 10 MiB to
`activity.md.1`. Do not assume a composed process has initialized that sink or that
a service's working directory equals your shell cwd. Inspect stderr/journal first.

The CLI reads local `daemon-lifecycle.json` and `daemon-receipts.json` under
`<home>/.goodvibes/tui/control-plane/`, derived from its selected config directory.
Remote status/update reports this local-only history as unavailable. Reads do not
consume receipts. Historical receipts or an inherited `update.auto` default do
not show that this product's updater is armed. `update --check` is read-only;
release/feed/activation policy remains unresolved.

## Status and authentication

```sh
goodvibes-daemon status --json
goodvibes-daemon status --host daemon.example --port 3421 --token "$TOKEN" --json
```

The token must belong to the target daemon. `/status` and `/api/health` require
bearer authentication; prefer the CLI rather than printing the identity file.
A 401/403 indicates an authentication/authorization refusal, not proof the daemon
is down. Recheck the selected daemon home and any server token override before
re-pairing. Connection refusal means no listener answered at that address; check
its actual bound endpoint and platform service separately.

A configured endpoint is not evidence of a live listener. `status` can report a
successful primary response while naming failed health/channel/session subqueries.
Read those individual diagnostics rather than interpreting exit 0 as all-green.
`status`, `update` and `sessions` use selected outbound TLS settings for HTTPS/WSS,
without changing global trust. Relative CA files resolve from the selected
control-plane config directory. Do not bypass certificate validation to hide a
wrong CA, hostname, origin or transport configuration.

## Pairing link lost or not working

```sh
goodvibes-daemon pair
```

Local pairing reuses the existing shared token; it does not rotate every client's
identity. It explicitly reveals credential-bearing output, so keep it private.
Automatic startup pairing is limited to an interactive terminal or explicitly
trusted local output sink; redirected service logs do not carry the QR/token.
A corrupt identity store may be preserved and replaced with a warning requiring
clients to pair again. Missing bundles/unusable origins produce a notice, not a
fabricated usable QR.

Pass the same effective token and nonzero port override used by the serving process
when necessary. A separate CLI cannot discover another process's ephemeral port.
Remote `pair --host <name>` mints a new per-device token through
`pairing.handoff.create` only with its explicit `-y` confirmation; no confirmation
means no remote mutation. Existing tokens remain intact. See the
[command reference](commands-reference.md#pair).

## Port conflicts and WebUI exposure

Check the bound endpoint, existing process and service before starting another
instance. To persist a custom port on a qualified service deployment:

```sh
goodvibes-daemon config set controlPlane.hostMode custom
goodvibes-daemon config set controlPlane.host 127.0.0.1
goodvibes-daemon config set controlPlane.port 3431
goodvibes-daemon restart-service
```

The final command still requires the service-launcher prerequisites. `--port` and
`--host` are runtime-only on foreground serve and refused on service commands.
Local/network modes choose the bind address but still honor a valid configured
port. Use custom mode for a custom bind host. A stale public URL can trigger a structural
`derived-bind-mismatch` warning. Correct the declared external URL or binding;
do not assume the URL itself changes the listener.

The bundled WebUI uses the control-plane origin, not `web.port`. `webui status`
reports configured serving/exposure, and `webui status --json` reports declared
`web.*` development binding without probing a listener. `webui enable --lan`
explicitly widens network binding; `webui enable --loopback` narrows it. Confirm
this exposure is intended and that the bundle exists before enabling it.

## Installed and running disagree

`service-status` reports separate facts. A definition file can be missing while
systemd/launchd still has a loaded running unit. A manually launched process can
answer on the port without belonging to any managed unit.

```sh
systemctl --user status goodvibes.service
launchctl list | grep goodvibes
```

Use the command matching your OS and configured service name. Do not kill an
unidentified listener. The migration adapter's rule is new-up/healthy-before-old-down
with rollback if the replacement fails; an unowned process is reported, not killed.
Migration requires explicit `-y` and a qualified installed executable. Uninstall
removes the managed definition; systemd enablement symlinks may need the stated
`systemctl --user daemon-reload` follow-up. See [service command details](commands-reference.md#install-service).

## Hosted work stalls, ends or refuses a tool

Check the session id, effective detach policy, attachment renewal and termination
reason with `sessions list --all --json`. Last detach or lease expiry ends a
`kill`-policy session; `survive` is not a promise that work survives process death.
A restarted session can restore bounded history, not its lost in-flight turn.

A Jev or deterministic-boundary refusal is a result to diagnose, not a reason to
wait indefinitely for a human approval UI. Restricted trust, missing source
capability, protected data, required containment, changed config/trust, expired
contract/lease or cancellation can all invalidate action admission. Do not reuse
old permits, answer PTY credential prompts, disable containment or reroute around
protected-source screening. See [hosted authority and lifecycle](hosted-sessions.md).

SIGINT/SIGTERM fence new work and await owned cleanup. The default 15-second drain
deadline reports failure on expiry; a hung or failed drain is not a clean exit.
Retry a failed host with a fresh owner only after the old resources are accounted for.

## Send failed or delivery is uncertain

`send --list` only inspects enabled channels and configured destinations. Check the
required credentials/capability gates, explicit destination and whether more than
one channel qualifies as default. A disabled channel never silently falls back to
another. Use `--` for message text beginning with a dash. Acceptance is not recipient
arrival. An unconfirmed network send may already have reached the provider: inspect
available delivery evidence before intentionally retrying, to avoid duplicates.
