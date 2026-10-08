# Daemon cluster inbox registration proof

Restores the behavioral obligations of
`goodvibes-daemon@254699bf5d834cdca41436211ada1ae32bf89258`
`src/test/runtime/cluster-inbox-gating.test.ts` (blob
`88a6b5b56011cbde10556d4eb03195b353b5c505`) in
`products/daemon/src/test/runtime/cluster-inbox-gating.test.ts`.

## Boundary and evidence

The test constructs the shipping `createDaemonHandlerComposition`, which passes
its own per-account `inboxPollerGate` registration to the explicit inbox factory.
That factory calls the canonical `registerInboxSurface` with synthetic adapters.
It does not replace the coordinator, polling controls, registrar, cursor store,
handler catalog, group membership, or election implementation. The real product
cluster pair uses `MemoryClusterBus` and `FakeClusterClock`; group creation and
joining use synthetic in-memory key material and owned temporary state roots.
No external provider, network socket, credential store or user account is used.

The original seven cases are consolidated into these assertions:

- An ungated canonical registration seeds immediately; close is awaited.
- Constructing a coordinator and registering an account gate starts nothing and
  writes no state. The gate retains the exact inbox surface and digest identity.
- The actual handler graph does not poll before election. A standby serves rows
  persisted before election through the real `channels.inbox.list` handler.
- Real enrolled elections start each account separately. Spreading the common
  account preserves the exclusive account, and retiring the common registrar
  returns leadership without stopping the exclusive account. A subsequent real
  cadence poll proves the unaffected account continues consumption.
- Actual wire datagrams and reported holdings contain surface digests, never
  the synthetic account names.

Additional lifecycle assertions complete the initial election seed, then hold a
subsequent cadence fetch open, close its
registration, and verify cancellation without early close, resignation or
successor consumption. After release, the fetch drains before resignation and
the successor's poll. Reopening the predecessor's exact store proves neither
its stale row nor its timestamp cursor was committed. A synthetic UID adapter's
expired account fence likewise prevents its proposed checkpoint from committing.
All registrations and cluster owners close, and fake-clock timers reach zero.

## Scope retained

This is registration/test accounting only. No production source changes, cluster
settings changes, provider factory changes or security changes are included.
Production Slack and email inbox factories still refuse clustered operation;
their refusal regressions are included in the focused checks. Synthetic adapter
results do not establish cross-node provider cursor/storage ownership, live
Slack/email parity, protected-reader calibration, or complete daemon migration.
The existing full service-graph/DaemonServer composition remains outside this
bounded test restoration; this suite exercises its actual handler registration
boundary rather than claiming a new server or live-provider acceptance proof.

The original source pin and historical inventory are preserved. Only the current
mapping for this original test closes after independent review; all broader
criteria remain unchanged.

## Verification

Independent review checked the pinned source, actual registration boundary,
second-poll drain ordering, account separation, currentness fence and the exact
one-row accounting delta. No remaining review blockers were found.

Checks on the restored slice:

- Daemon source/test typecheck and daemon build: passed.
- Restored registration suite: 5 tests passed.
- Registration, cluster composition/gate/holdings, and production Slack/email
  inbox regression suites together: 54 tests passed.
- Canonical engine registration, poller lifecycle, UID poller, cluster ownership
  and handoff suites: 73 tests passed.
- Product workspace inspection and matrix: passed, four products present.
- Product workspace accounting contract: 23 tests passed. An initial run hit
  the matrix child process's 10-second timeout during concurrent compilation;
  the serialized rerun passed without changing code or timeout thresholds.
- Whitespace/diff check: passed.

Full CI, live providers and publication are deliberately not part of this local
qualification. The broader migration remains partial.
