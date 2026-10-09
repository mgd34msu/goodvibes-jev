# Daemon migration evidence reconciliation, October 8

Reviewed target: Jev main `4beb1d5d3454fc074a2a0d570cfc0b5edc7852e1`
(including PR #213). This is an accounting update, not runtime activation.
The source remains `mgd34msu/goodvibes-daemon` at
`254699bf5d834cdca41436211ada1ae32bf89258`; migration status remains **partial**.
The inventory retains 281 files: PORT 184, JEV 3, HOIST 94, DROP 0, and six
decision points. All five upstream deferred rows, their paths and exact blobs
remain unchanged. Original dated audits retain their checkpoint results.

## Implemented, within their evidence boundaries

- Bounded provider/LAN discovery is owned by
  `products/daemon/src/runtime/provider-discovery.ts`, with lifecycle tests in
  `products/daemon/src/test/runtime/provider-discovery.test.ts`. This is not
  evidence that the shipped entrypoint has complete default composition.
- [Functional startup pairing](daemon-functional-pairing-startup.md) renders
  the effective token and actual served origin after admission and settlement;
  token pruning, public-URL persistence and legacy adoption are separate callers.
- [Linux native packaging](daemon-native-packaging.md) compiles the actual
  entrypoint and binds producer/consumer artifacts to exact source and payload
  hashes. This is Linux qualification, not other-platform or release completion.
- [Slack](daemon-slack-inbox-composition.md) and
  [email](daemon-email-inbox-composition.md) have explicit single-node and
  account-eligible clustered owners. [Multi-owner composition](daemon-multiowner-inbox-composition.md)
  binds the canonical composite inbox once, with independent ownership,
  protected-read fences and rollback. Default all-provider bootstrap remains open.
- PR #213 supplies `products/daemon/src/daemon/lifecycle.ts` and
  `products/daemon/src/test/daemon/lifecycle.test.ts`. The two matching upstream
  paths are now mapped. The resolver identifies a binary update artifact; it
  neither authenticates that artifact nor activates updates. The whole
  `src/daemon/cli.ts` and `src/daemon/handlers/inbox/index.ts` remain unmapped.

## October 9 production integration update

The original dated checkpoint above remains historical. The current production
bootstrap and its bounded acceptance are documented in
[the production integration audit](daemon-production-bootstrap.md). Fresh-install
serving now supplies all three built-in memberships; configured local-service
admission and Discord activation remain open. PR215 completed the explicit
owned triage score API and read enrichment, without automatic poll scoring or
provider tags/writes. The historical D obligation below is superseded for that
bounded integration and retained for provenance.

## Remaining acceptance A–G (preserved October 8 checkpoint)

These are bounded existing obligations, not new feature requirements or an
exhaustive claim that every unupdated inventory row lacks implementation.

A. **Shipped bootstrap.** Connect complete intended provider membership and
owned capabilities through the existing entrypoint, serve and host/service
composition. The shipped entrypoint currently supplies no runtime inbox factory;
serve refuses its absence, and multi-owner composition requires explicit nonempty
sources. Do not invent provider selection or empty/disabled defaults to bypass it.

B. **Protected-source trust.** Supply trusted local screening authority with
retention/revocation ownership and expected account provenance. A configured
judgment endpoint alone is not this authority. Existing protected previews do
not grant permission to transmit source content to a hosted model.

C. **Discord membership.** Supply the complete account-bound DM catalog and
initial-history policy required by the existing private adapter. Slack/email
composition does not establish Discord or complete default membership.

D. **Triage integration.** Restore the original owned read-enrichment wrapper
and exposed scoring API around the typed triage core; see
[the triage audit](daemon-inbox-triage-core-hoist.md). The original caller registered
`registerTriagedInbox(...).unregister`, and did not establish automatic post-poll
scoring. Do not invent that activation. Preserve persistence, caller ownership
and protected-source authority when integrating the existing surface.

E. **Lifecycle policy and caller.** The resolver and fail-safe handover exist,
but the host does not supply `updateArtifact`/`hasOverriddenHome`. Resolve the
product update source and policy before wiring activation: the current shared
schema has automatic updates enabled and a legacy repository release URL.
Neither this ledger nor resolver mapping changes those settings or adopts a
release policy.

F. **Remaining startup callers.** Reconcile original token pruning, unattended
legacy-service reconciliation and public-URL persistence in their admitted
startup owner. Existing helper and pairing-renderer proof does not close those
caller obligations or authorize service/network changes.

G. **Compiled hosting and platform/release acceptance.** The actual shipped
binary must stream with a synthetic configured model and explicit Jev setup,
assert a persisted assistant marker and preserve the original session lifecycle.
An injected fixture launcher is not that proof. Linux native qualification is
already present; other target execution and release preparation remain distinct.
Version/changelog ownership and publication decisions remain unresolved. Keep
`.github/workflows/release.yml`, `scripts/hosted-session-proof.ts`,
`scripts/release-prepare.ts`, `src/test/scripts/release-prepare.test.ts` and
`toolchain.config.json` deferred. The toolchain's build/smoke progress does not
close releaseCut, publish or perJobGreen. Live provider/service calibration
(THE-35) and whole-session transport bounds remain separate acceptance.
