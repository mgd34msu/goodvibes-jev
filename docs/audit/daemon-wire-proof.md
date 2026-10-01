# Configured daemon wire proof

`products/daemon/src/test/daemon/daemon-wire.test.ts` adapts the actual wire
tests added in upstream daemon `254699bf5d834cdca41436211ada1ae32bf89258`,
source blob `0589790ff8eb38e3d61800422fabd522a7b8fd4b`. The five cases preserve
the source's behavioral assertions and add a check that the explicitly chosen
model receives a streaming request on its expected chat endpoint.

The fixture runs the product's real runtime graph and DaemonServer. Clients
use HTTP, SSE and raw/WebSocket connections rather than invoking handlers in
process. It establishes:

- Wrong and missing bearer tokens refuse WebSocket upgrade with 401; the
  valid fixture token upgrades and receives the ready event.
- A second SSE connection resumes from Last-Event-ID, receives two session
  events created while disconnected exactly once and in order, and redelivers
  none of the first connection's event IDs. Assertions wait for the first
  heartbeat following ready and synchronous replay, the actual replay boundary.
- A hosted session calls the selected loopback model with streaming enabled,
  completes its reply, survives detach, and reattaches with both the original
  user text and the unique scripted assistant reply in saved history.

Only external inputs are fixtures: fresh benchmark metadata, suppressed live
discovery, an explicit empty inbox adapter set, a loopback OpenAI-compatible
server and product-local deterministic Jev readings for the two intake/core batteries.
The fixture uses only public engine and judgment/testing entrypoints; unknown
batteries or questions refuse instead of receiving a generic answer. The model
server rejects unexpected endpoints. Readings are installed after workspace
floor creation and restored before that floor is retired. The actual provider
adapter, turn loop, contract intake, hosted-session store, gateway and server
remain in the exercised path.

Waits observe ready frames, replayed events, provider requests and stored
message counts under deadlines. No fixed delay is treated as evidence that
a turn completed. Teardown drains the fixture before closing its model server
and restores the discovery observation.

This proves the configured graph with fixture inputs. The production default
inbox/triage composition, actual daemon executable, compiled binary and live
provider proof remain separate migration gaps. The original baseline inventory
does not contain this newly added upstream test, so no old source pin or
baseline mapping is silently changed.
