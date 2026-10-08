# Selected-config HTTPS trust for daemon commands

THE-18 remains **In Progress**. This increment restores the outbound HTTPS
configuration used by the `status` and `update` command HTTP readers. It does
not add a model-service dependency or change system trust.

## Original acceptance and bounded caller mapping

Pinned source: `mgd34msu/goodvibes-daemon` at
`254699bf5d834cdca41436211ada1ae32bf89258`, `src/daemon/cli.ts`, blob
`5e8e7aff5a82fbdc604d3a0d637078a35497e058`. Its configuration construction and
`GlobalNetworkTransportInstaller.install(config)` precede status/update dispatch
(lines 376–382 and 439–445). The current daemon facade installs that transport
only when a server starts; one-shot commands do not start a server.

`products/daemon/src/cli/run.ts` now passes an explicit `fetchImpl` through the
existing `RemoteCommandDeps` seam for status/update. It uses the canonical
`createNetworkFetch` and the command's selected `ConfigManager`. Existing
bundled/custom trust modes, relative CA resolution, token/target selection,
HTTP documents, exit statuses and local update receipts are unchanged.
`update --check` still reports that there is no early-update verb; it does not
perform an update or invent a new operation.

The relative CA root remains `ConfigManager.getControlPlaneConfigDir()`, rather
than the working directory or selected daemon identity directory. No new flag,
configuration key, certificate store or global fetch installation is introduced.

## Request ownership

A real baseline probe showed that installing another home's global transport
could make a strict bundled command accept that home's private CA. Merely adding
the scoped caller fixed the missing custom-CA positive case but retained this
cross-owner acceptance: the inner global wrapper reapplied its own policy.

The shared helper now carries its explicit reader in an asynchronous context for
the fetch invocation. Product-global wrappers in that call chain read the
explicit scope. The ambient fetch function and middleware remain intact; the
implementation never unwraps them or mutates the installed manager. Asynchronous
middleware and nested work inside that invocation inherit the selected scope;
independent concurrent calls and later unscoped calls retain their own policy.
Caller-provided TLS fields retain their existing precedence. Strict bundled
requests still use Bun's ordinary default trust instead of a synthesized CA set.

The scope is private to the canonical outbound transport module shared by the
public runtime/transport exports. No public API is added. This is HTTPS fetch
ownership; WebSocket, proxy and unrelated transport policy are not changed.

## Functional proof

Owned loopback HTTPS tests exercise the actual emitted CLI with generated test
certificates and synthetic operator tokens. A valid selected custom CA or
bundled-plus-custom CA succeeds; missing, wrong and bundled-only trust refuse
without disabling certificate verification. Status retrieves its actual HTTP
identity, health, channel and cluster documents. Its separate WSS query remains
reported as unavailable by the fixture. Update reads the synthetic local receipt
without consuming it or requesting a service/update mutation.

Tests cover relative CA paths with incorrect default/cwd/daemon-home decoys,
correct decoys that cannot rescue an incorrect selected CA, unchanged settings
and token bytes, sequential calls, barrier-held concurrent calls, and a prior
global owner whose trust still works after strict scoped calls reject it.
Shared-helper tests preserve middleware guard execution even when it reconstructs
`Request`, explicit per-request TLS, failure cleanup, overlapping scopes and an
unrelated manager change during a held request. These helper cases use a fake
transport and make no network requests.

The original CLI omission and the narrower shared-helper defect are preserved
as separate failing baseline observations. The complete owned HTTPS matrix and
shared-helper regressions pass after the repair. Full build/types/CI qualification
is recorded on the PR rather than inferred from those focused results.

Only this status/update HTTP caller omission is retired. Default inbox serving,
WSS trust, other global-transport callers, service/adoption and complete native
hosting/release parity remain open. All providers, credentials and HTTPS servers
used here are owned synthetic fixtures; no live endpoint or account was used.
