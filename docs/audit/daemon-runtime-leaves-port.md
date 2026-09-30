# Daemon runtime leaf composition

Pinned daemon source: `443e5ee4d6cda0d36d57e2886398d0836074a4a9`.

Six product modules retain their original PORT dispositions and runtime
behavior, consuming public engine exports rather than package internals:

- device posture composition and gateway registration
- trigger composition with a live config reader and the existing process host
- fleet needs-input event/presence wiring
- memory-pressure channel notice wiring
- live checkpoint-registration reading
- checkpoint manager and gateway composition

The exact original-to-product paths are in migration.json. No production
handler, daemon entry or provider has been stubbed to make this slice pass.

## Fixture acceptance

- The device adapter installs the seven real gateway handlers and reads
  changed owner policy at call time. Construction does not create its state
  directory, start housekeeping or call a device/approval transport.
- The trigger adapter honors a live enable flag and the historical scoped
  store. A condition definition is stored but never polled or executed;
  fixture host effects throw if unexpectedly called.
- Fleet wiring attaches the canonical snapshot bridge and reads session
  surface freshness from the current record rather than caching presence.
- The five original memory-pressure component cases are retained: configured
  delivery, local-only reporting, unrelated event filtering, failed delivery
  and unsubscribe. Delivery is an in-memory fake, not an outgoing webhook.
- Checkpoint reads retain the legacy read-only fallback and shared-path
  precedence. Malformed/wrong-version stores confer no eligibility. Only the
  explicit boolean grant covers a workspace; worktree inheritance requires
  the supplied git relationship. Every read observes the current store.
- Real checkpoint manager fixtures exercise ineligible automatic/manual
  refusal, registration changes, actual scoped snapshots, session attribution,
  existing-checkpoint reads after unregistering and the owner's explicit
  guarded-workspace setting. Git state is created only inside the runner-owned
  fixture workspace, never in a user project.

Fifteen focused cases pass (53 assertions). The original full device,
fleet-push and notification suites still need the real services/server fixture.
In particular, the original notification source-wiring assertions remain
unmapped instead of being weakened to accept an absent services.ts. The new
component test is explicitly named separately from that complete source suite.

## Remaining boot work

These modules are dependencies of the original daemon fixture, not proof that
the daemon is bootable. Workspace-trust approval outcome provenance, the handler
and inbox graph, payment/knowledge composition, services/types, hosted session
composition and the actual loopback fixture remain. Shutdown readiness of
asynchronously started services must be owned at the complete composition root.
No real device access, grant provisioning, webhook, external probe or provider
call is part of this verification.
