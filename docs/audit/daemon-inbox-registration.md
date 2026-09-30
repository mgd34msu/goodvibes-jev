# Daemon inbox registration boundary

Pinned source: daemon `443e5ee4d6cda0d36d57e2886398d0836074a4a9`, `src/daemon/handlers/inbox/index.ts`.

The mechanical registration now lives in `sdk/platform/intake` as `registerInboxSurface`. It binds the engine's existing `channels.inbox.list` descriptor to the actual cursor store, poller and mirror aggregator. Adapter membership is required explicitly and copied at construction. The product remains responsible for supplying every configured or unavailable provider; there is no empty default that could hide missing provider composition.

This is a partial extraction of the original module. Built-in Slack, Discord and email factory construction, semantic mapping, triage and product composition remain pending. The original inventory entry is deliberately not marked migrated by this change. Storing and displaying a preview locally does not authorize sending that preview to a hosted judgment endpoint.

## Readiness and ownership

Await `ready` before exposing the graph. It includes store initialization and the initial ungated seed; storage/setup failures reject rather than returning a fabricated empty feed. A gated surface is readable after storage initialization and does not fetch until its host grants polling ownership. Each gate receives awaitable `start` and `stop` controls and may return its own awaitable unregister callback. Await stop before transferring leadership. A returned leader resumes its provider generation before fetching a fresh seed; interval ticks coalesce with an in-flight seed.

Await `close` before replacing the surface. It stops admission, restores the canonical descriptor for reuse, aborts polling, retires host gates in reverse order, drains accepted work, and then closes storage. Repeated and reentrant close calls share one promise. Stale controls cannot restart polling; repeated old teardown cannot erase a replacement. All cleanup is attempted and failures remain observable through the aggregate promise. Legacy `unregister` starts that same close with fixed-value failure diagnostics. A gate returning the surface's own close promise is refused; arbitrary asynchronous promise cycles are not claimed to be detected.

## Verification

Twelve registrar tests cover actual persisted fixture items and provider evidence, required membership, gated cold readiness, leadership return, stop-before-start races, ignored-signal drain, failed startup, same-catalog restart, reentrant close, complete cleanup despite failure, and preservation of failed-call versus failed-cleanup semantics. The leadership-return regression initially skipped the fresh poll while the provider remained paused and now passes after resuming the generation first. The registrar plus six existing intake suites pass 73 tests and 202 assertions. All fixtures use owned temporary files and synthetic providers; no external account or provider is contacted.

Product assembly, real built-in adapters, full daemon startup/shutdown and combined integration remain separate acceptance gates.
