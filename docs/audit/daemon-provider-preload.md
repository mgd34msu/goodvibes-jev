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
the primary daemon registry. The shared loader supplies fresh structural records, filters invalid entries,
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

The hosted composition awaits each new floor's own tolerant initial custom load
before copying the daemon registry's discovery snapshot or admitting hosted
model selection. Successfully loaded custom providers therefore retain name
precedence in the floor as well as the daemon. No automatic LAN scan, background model
fallback mutation or discovery-cache watcher is added. Rewriting the cache does
not update the running daemon or its existing floors. A later explicit registry
change can affect a new floor; it is not broadcast into existing floors.

The already-supported asynchronous floor-factory contract carries this wait.
The factory owns its acquired client graph until it returns a floor; unexpected
readiness or cache-copy failure disposes that graph and exposes only a fixed
phase error. Once returned, the shared pending-floor owner owns cleanup. Its
separate admission/drain repair is a prerequisite: shutdown must await pending
factories and late disposal without granting a lease or publishing a session.
The product barrier does not change public factory types or duplicate that
shared owner. The client graph keeps its existing synchronous disposal API.
The composed shared create owner also drains registration and initial persistence
before writing shutdown state. Product integration proof holds a real save after
floor readiness and verifies kill/survive shutdown records without late creation
publication. Explicit session-kill lifecycle work remains separate.

Ordinary discovered providers confer no protected-source authority, Jev
authority or hosted-fallback permission. This work performs no service setup,
credential provisioning, legacy IMAP activation, release or account access.
Independent settlement-security review remains separate.

## Synthetic proof

The real host fixture seeds an owned selected-home cache and decoys at other
roots. It observes the selected provider before real `DaemonServer`
construction, creates a hosted session through authenticated loopback HTTP,
and uses that actual floor's provider for one owned synthetic loopback request,
without a test-only readiness wait.
No direct discovery registration seeds this success path. Other cases prove
absent/empty/invalid cache preservation, real custom-load precedence, distinct
homes with the same provider name, shutdown during held initial readiness,
partial-registration failure with held graph close, and base acquisition
failure while real custom loading is held. Controlled concurrent HTTP creates
stay pending during floor custom loading, then admit the custom model and refuse
the colliding cache-only model. Further cases hold shutdown through real floor
initialization and late disposal, and prove a partial cache-copy failure cleans
the acquired floor once before a fresh retry. These are source-level lifecycle and
routing proofs, not live account, model-quality or complete compiled-hosting
proofs.
