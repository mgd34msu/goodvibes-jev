# Bounded daemon production integration

Source: `mgd34msu/goodvibes-daemon` at
`254699bf5d834cdca41436211ada1ae32bf89258`, especially
`src/daemon/handlers/inbox/index.ts` and `src/daemon/cli.ts`.
Migration remains partial. No release, service installation or live-account
activation is implied by this implementation.

## Shipped caller and complete membership

The checked-in entrypoint supplies `createProductionDaemonRuntime()` to
`runDaemonCli`, which enters the existing admitted `runConfiguredDaemonCli` and
`createDaemonHost` owner. This is the production entrypoint, not an injected
fixture launcher. Original host choices are retained: external-agent observation,
the canonical host power seam and wake-model boot provisioning. The existing
selected-home auth owner and captured ordinary-Bun resolver remain canonical.

The pinned original registers Slack, Discord and email. The production factory
always represents those three memberships with one canonical composite handler.
For absent credentials/configuration it supplies an explicitly unconfigured,
nonpolling source. It does not manufacture adapter success, a sync timestamp,
a cursor, a store, an account identity or a screened projection. Presence is
established with the local literal credential inspector: unreadable storage,
reference-backed/unsupported material and missing inspection capability refuse
admission, rather than collapsing a nullable lookup failure into absence.

Each read rechecks absence. Config/credential invalidation fences a read across
its generation; an unrelated invalidation may be revalidated by a later read.
A source that becomes configured cannot keep returning an unconfigured snapshot.
Sources close admission, detach subscriptions and drain held read leases before
retirement. Canonical multi-owner acquisition supplies rollback and one inbox
registration. Configured sources without a trusted account owner fail startup.
No old account mirror is exposed merely because its credentials are absent.

## Configured local-service setup boundary

The supported trusted-host constructor is
`createProductionDaemonRuntime({ slack: { account, screening }, email: { account, screening } })`.
It uses the existing real Slack/email source constructors and their account,
cluster, storage and protected-read fences. Omitted members are only admissible
when genuinely unconfigured. No Discord catalog is guessed or synthesized.

The `screening` value is the existing `ProtectedSourceOwnerOptions` contract.
It needs a generation-scoped local authority owner/revision, a live abort signal
and synchronous revocation check, two literal-loopback service endpoints (a
proposal model and compatible `jev-1.13.0` judgment), and established
`ephemeral-no-log` retention for both services. Slack additionally needs the
expected workspace and self account; email needs the expected TLS endpoint,
account and mailbox. A trusted process owner must bind those services and
accounts before constructing the capability. Source text, configuration strings,
a remote Jev URL, endpoint reachability or a recent-channel cache cannot grant it.

A standalone persisted deployment admission/managed-local-service resolver is
still missing implementation. This change does not claim that an existing
hosted judgment configuration establishes service identity, no-log retention or
source permission. Required deployment prerequisites remain operator-approved
source/account scope and an approved compatible local Jev/proposal runtime.
There is no regex mapper, hosted raw-text fallback or live provider activation.

## Transport and persistent key ownership

Status and sessions WSS upgrades use the selected configuration's canonical TLS
policy and relative CA root, without installing a global transport. Cluster HTTP
also uses selected-owned fetch. Existing HTTPS ownership remains intact. The
emitted caller test matrix covers custom, bundled-plus-custom and bundled trust,
wrong/missing CA, selected homes and overlapping/global owners.

Draft first creation uses `SecretsManager.getOrCreateDaemonSecret` under strict
cross-process ownership. Actual secure/plaintext target paths are locked in
stable order, including policy-eligible fallback. Other writes/deletes and legacy
whole-file migration use the same target namespaces; migration re-reads after
acquisition. Policy changes during acquisition refuse. User/project mutations
do not depend on an unrelated daemon directory. Canonical base64 key material is
required; malformed material remains preserved and decrypt never creates a key.
Stores without atomic creation capability may read an existing valid key but
cannot create new cipher material.

## Evidence and remaining acceptance

Checked-in tests exercise production membership/refusal/revocation, emitted
entrypoint startup/shutdown, selected-command HTTPS/WSS, and eight independent
process creators with unrelated daemon writes/shared-user-tier writers and
reopened decryption. The native verifier now also exercises production inbox
startup/shutdown in relocated source-free artifacts. A verifier implementation
is not an execution receipt; final run results belong to the reviewed source
and CI receipts.

Configured standalone account admission, supported Discord membership/history,
compiled synthetic-model streaming/persisted assistant reply, update policy and
authenticated artifacts, service adoption/platform execution, publication and
THE-35 live calibration remain separate open obligations. The original whole
CLI/inbox files and five deferred release/toolchain rows stay incomplete.
