# Daemon handler assembly

Pinned source: daemon `443e5ee4d6cda0d36d57e2886398d0836074a4a9`, `src/daemon/handlers/{context,contracts,index}.ts`.

These three product modules now use declared public engine imports. Catalog, remote and payment contracts come from their actual declarations; this port defines no gateway descriptor or replacement protocol type. The context keeps host-owned paths, credentials, configuration and logging. Every provider remains required.

The registration order is routing, inbox, drafts, payments, remote. `registerDaemonHandlers` is now async: each created surface is owned before its readiness is awaited, routing initialization finishes before inbox construction, and the aggregate is returned only after every surface is ready. Product root callers must await this factory. The returned payment inbox, remote service and dispatch adapter are the original objects supplied by their actual owners.

`close` awaits reverse cleanup. A failed startup closes the failing acquired surface and every older owner before rejecting. Cleanup continues after failures and preserves both the original startup failure and cleanup failures. Legacy `unregister` initiates the same observed close. A provider that rejects before returning a resource remains responsible for its own partial construction; the aggregate can own only returned handles.

Seven integration tests use actual routing, cursor/poller/aggregation, encrypted-draft registration, product payment composition and remote registry/manager implementations. They exercise gateway reads, no return while readiness is pending, no premature construction of later surfaces, failed final readiness, same-catalog retry, constructor and routing-readiness failure, full cleanup despite an error, exact shared handles and rejection of active payment veto windows on shutdown. Providers and credential values are synthetic; files belong to the guarded runner's temporary directory and no external service is called.

This factory is a boot prerequisite, not a complete daemon. The partial runtime root will require an explicit inbox factory while built-in providers and triage are restored. The first loopback boot will be a fixture-configured graph using real registrars. It does not replace original built-in-provider, semantic, full-product parity or combined integration acceptance.
