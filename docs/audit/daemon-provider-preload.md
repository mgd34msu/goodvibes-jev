# Daemon persisted-provider preload and background discovery

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
precedence in the floor as well as the daemon. Background discovery can supply a
new snapshot to later floors; no model fallback mutation or discovery-cache watcher
is added. Rewriting the cache does
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
publication. The separately proven explicit-kill initialization, registration,
and shutdown-parking races are now repaired by the [shared session lifecycle
owner](hosted-session-explicit-kill.md).

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

## Owned background scan

The explicit host also restores the pinned daemon CLI's background `scan()`
caller (lines 632–646). After custom readiness and cache preload, it starts one
owned scan through `sdk/platform/discovery`; listener startup does not wait for
its result. Nonempty results enter the same runtime provider registry used by
the server and later hosted floors, then the canonical persistence helper merges
them into the selected runtime home/surface cache. Empty or rejected scans do not
clear the registry or rewrite the cache. Custom-provider precedence is retained;
selected models, existing floors and cache-removal policy are unchanged.

The controller's close fences result application immediately, including a second
fence between registration and persistence for synchronous shutdown reentry.
It awaits accepted scan and persistence settlement before graph disposal. The
canonical scanner has no cancellation API: shutdown suppresses late application,
but does not abort network probes. Existing process shutdown deadlines remain
responsible for a scan that never settles. Rejected scan, registration or injected
persistence work receives a fixed diagnostic without inspecting the rejected
value. The canonical cache helper retains its own tolerant persistence behavior.

All ordinary host and configured-CLI fixtures inject a synthetic scan, including
emitted CLI subprocesses. Focused proof holds discovery through listener
readiness, observes the real provider-list HTTP route and a later hosted floor,
restarts from the selected cache, preserves custom model precedence/selection,
and drains held scan or persistence before disposal. Provider-list lazy pricing
uses fresh owned empty caches, so this proof makes no external provider calls.
This restores only the bounded source-host handoff; default serving, clustered
inbox polling, compiled service adoption and live LAN acceptance remain separate.
