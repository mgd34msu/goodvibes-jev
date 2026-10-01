# Host channel/profile routing

The route store, exact-binding resolver and inbox bridge are hoisted from daemon
443e5ee4d6cda0d36d57e2886398d0836074a4a9 into channels/host-routing and exported
from the existing host channels subpath. The engine GatewayVerbError preserves
the source handler's stable code/status shape without duplicating its class.

Owner choices remain authoritative: exact surface+route binding, then the
surface-only binding, then the explicit `any` binding, or null. No message text,
sender digest, confidence score or model heuristic chooses a profile. The bridge
still returns the owner's profile ID using the existing route-resolver seam; it
does not invent a delivery address. A live-store failure remains a failure,
not proof that no owner binding exists. The old comment claiming the bridge was
an infallible in-memory lookup was corrected; behavior is unchanged.

The persisted channel-routes.sqlite path/schema, composite first-colon parsing,
stable assignment IDs, list/filter order, label semantics and wire projection
are preserved. Original storage and resolver assertions remain, with teardown
awaited and optional fixture fields omitted rather than explicitly undefined.
Only the temporary-directory helper needed by these tests is hoisted; original
handler-registration fixtures and catalog tests await the composition layer.

## Reproduced races

The unchanged imported implementation ran 30 pass and 4 fail. Overlapping
updates made the first caller receive the second assignment's profile; a later
delete made a successful earlier write fail its post-await readback; close
returned before accepted persistence and broke that receipt; and late
initialization reopened a released database.

Mutation receipts are now captured from the actual row before yielding to
persistence. Each caller still receives a persistence failure if its save fails.
The store owns initialization and mutation promises, closes admission immediately,
and waits for them before closing its handle. Close is idempotent and awaitable;
legacy ignored calls are observed, but product shutdown must await completion.
A released instance stays released; use a fresh RouteStore to reopen, as the
original restart tests already do. Failed initialization can retry while open.
Post-release operations retain the typed ROUTING_STORE_UNINITIALIZED refusal.

This does not change the shared SQLite store's process-local save ordering or
claim cross-process write transactions. Tests use isolated temporary databases
and fixture profile IDs, with no user routes or provider traffic.

The public consumer fixture pins the inbox resolver seam and the routing list
item against the authoritative generated channels.routing.list output contract.
The production routing catalog registration and daemon composition remain the
next product integration work; these helpers do not claim a complete UI/route.

Verification: 57 routing/storage tests pass. The combined guarded remote,
inbox, routing and storage suite passes 295 tests across 27 files (755
assertions). SDK declaration build, public consumer types, API extraction,
architecture, line-cap, judgment lint and browser-neutral checks pass. The
normal pre-commit gate also rebuilds and typechecks the complete repository.
