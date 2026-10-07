# Daemon persisted-provider preload

This bounded THE-18 caller restores the persisted-provider load in pinned
`goodvibes-daemon` `254699bf5d834cdca41436211ada1ae32bf89258` CLI startup,
after runtime creation and before `DaemonServer` construction. It depends on
the shared validated cache loader and the owned host/startup diagnostics work.
Default CLI serving and complete compiled-hosting acceptance remain pending.

## Ordering and ownership

The source host owns the runtime graph, then enters a fixed `provider preload`
phase. It awaits `providerRegistry.ready()`, checks its shutdown fence, loads
the cache through the public discovery loader, registers only a nonempty
snapshot, and checks the fence again before constructing any server. The roots
come from `runtime.homeDirectory` and `runtime.surfaceRoot` (currently `tui`),
not the daemon identity tier, workspace or ambient `HOME`.

Readiness means the established tolerant initial custom load has settled. It
does not attest that every custom configuration succeeded. It lets successfully
loaded custom providers retain their existing precedence over cached names in
the primary daemon registry.
The shared loader supplies fresh structural records, filters invalid entries,
preserves functional URL bytes and uses fixed diagnostics; this caller adds no
parsing, route redaction or semantic secret guesses. An absent, empty or wholly
invalid cache does not erase already registered discoveries.

The host awaits admitted preload work during close. Shutdown while readiness is
held prevents later cache registration and server construction. Unexpected
registration failure, including partial mutation, fails startup with the fixed
phase diagnostic and joins owned graph cleanup. No catch-and-serve path or new
registry transaction is introduced. The base graph's existing provider metadata
drain also awaits initial readiness, covering acquisition failure before the
host can receive the graph. Provider watcher ownership is unchanged.

## Hosted scope

The existing hosted composition copies the daemon registry's discovery snapshot
when constructing a workspace floor. No automatic LAN scan, background model
fallback mutation or discovery-cache watcher is added. Rewriting the cache does
not update the running daemon or its existing floors. A later explicit registry
change can affect a new floor; it is not broadcast into existing floors.

Hosted floors start their own asynchronous custom load. Their existing admission
path does not await it before model resolution, so primary readiness does not
establish hosted custom-provider precedence. A held-load probe confirms that a
floor can admit a same-name cached model before the custom provider replaces it.
Repairing that floor acquisition/readiness lifecycle is separate work. The
synthetic route proof here explicitly awaits its captured floor's readiness
before making the ordinary provider request; it does not claim this wait is
already present in hosted admission.

Ordinary discovered providers confer no protected-source authority, Jev
authority or hosted-fallback permission. This work performs no service setup,
credential provisioning, legacy IMAP activation, release or account access.
Independent settlement-security review remains separate.

## Synthetic proof

The real host fixture seeds an owned selected-home cache and decoys at other
roots. It observes the selected provider before real `DaemonServer`
construction, creates a hosted session through authenticated loopback HTTP,
and uses that actual floor's provider for one owned synthetic loopback request.
No direct discovery registration seeds this success path. Other cases prove
absent/empty/invalid cache preservation, real custom-load precedence, distinct
homes with the same provider name, shutdown during held initial readiness,
partial-registration failure with held graph close, and base acquisition
failure while real custom loading is held. These are source-level lifecycle and
routing proofs, not live account, model-quality or complete compiled-hosting
proofs.
