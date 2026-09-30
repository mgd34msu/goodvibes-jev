# Daemon runtime helper port

Pinned daemon source: `443e5ee4d6cda0d36d57e2886398d0836074a4a9`.

Four dependency-ready product modules are now present: the runtime barrel,
fleet composition, browser checkout seam holder and conversation rewind port.
Their PORT dispositions are unchanged and exact targets are in migration.json.

## Shared implementation and event migration

The daemon's fleet factory body exactly matches the already-public engine
terminal-shell `createFleetServices` body after TypeScript printing with comments
removed. The product module therefore live-re-exports that real implementation
and type. It does not create another pricing/observation rule copy. Tests pin
identity and use the real archive-aware registry with injected empty managers
and timers; the observed source is mocked before opt-in queries, so no host
process/session inventory or steering operation is used. Current contract-runner
inputs replace legacy WRFC inputs through the shared engine contract.

The original runtime barrel is preserved as live public exports, avoiding
module-scope reads from lazy namespace objects. Its first build caught three
retired type exports: OrchestrationEvent, WorkflowEvent and PermissionEvent.
The engine inventory explicitly maps orchestration/workflows to the contracts
domain (R.8), and permissions to GateEvent. The daemon source search finds those
three names only in this barrel. It now names actual ContractEvent and GateEvent,
without aliases to incompatible old unions. A consumer type fixture pins both
canonical identities and rejects all three retired export names. Other products
must still adapt their own consumers when ported; no global parity is claimed.

## Component behavior

- The browser holder exposes the current injected seam, stops returning it on
  clear, and can accept a later explicitly supplied seam. Tests invoke no browser,
  checkout driver, approval-arm operation or payment operation.
- Conversation rewind preserves recorded message-count boundaries, clamping,
  unavailable-session reporting, actual truncation, reversible snapshots and
  registration/unregistration. Fixtures hold only local in-memory dummy messages.
- The original gateway rewind integration suite remains unmapped until the real
  daemon graph exists; component tests are not a substitute for that proof.

Nine focused cases pass (32 assertions), and the complete current product suite
passes 157 tests across thirteen files with 2033 assertions. Real product build
and source/test typechecks pass after the explicit event-domain adaptation.
Full root commit gates remain required. The four-product strict completion gate
continues to reject the actual remaining modules/evidence and absent products.
