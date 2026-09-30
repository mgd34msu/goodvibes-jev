# Daemon config adapters and credential prerequisite

Source: `mgd34msu/goodvibes-daemon` at
`443e5ee4d6cda0d36d57e2886398d0836074a4a9`.

The six original `src/config/*.ts` files are ported into the partial daemon
product. They preserve the historical `tui` storage root, daemon-owned config
migration, explicit checkpoint settings and registration enum, exact schema
key guard, secret-backed write scopes and literal-reference wrapper. Imports
use declared engine config/utils subpaths. There is no runtime startup yet.

The inventory's `src/daemon/handlers/credentials.ts` HOIST now lives in engine
`config/daemon-credential-store.ts`, exported through config. Its secret-store
input is the structural get/set subset, allowing the original product subclass
without an engine-to-product import. Config-key derivation delegates to the
existing canonical `daemonSecretKeyFor`; original replication-drift tests
still pin the product helper against that same platform rule.

## Draft-key preservation correction

The pinned draft cipher replaced an existing malformed key during encryption,
and generated a new key on decryption when none existed. Both are reproduced
with an in-memory dummy store (one original valid-key case passes, two new
preservation assertions fail). The port preserves malformed material and
refuses it. Decrypt cannot create a key; explicit encryption can create one
when no key exists. Error messages contain no key material or draft text.

One cipher instance shares its pending key operation. Failed reads/writes are
not permanently cached: retry rereads the store, including when a failed write
actually persisted. Existing AES-256-GCM layout, authentication and fresh IVs
are unchanged. No cross-process first-key creation guarantee is introduced;
final composition must establish single ownership or atomic creation before
competing creators use one persistent key namespace.

## Fixtures and preserved acceptance

The three original config/schema/replication test files retain their assertions,
including real local encrypted-store reads, daemon-tier default/clear behavior,
reference/bare-name lookup and cross-surface resolution. Only dummy strings
are written to owned temporary homes. Their fixture helper uses the guarded
runner's per-run temp parent; it refuses raw unguarded invocation. The original
product test-runner/scaffolding files are still explicitly unmapped, rather
than claimed as ported by this fixture adapter.

New tests cover checkpoint primitive/bounds validation and explicit owner
choices, migration receipts/idempotence/failure preservation, and literal
secret wrappers. External secret resolution is intercepted in the wrapper
fixture; no provider CLI is run. Ten in-memory cipher lifecycle tests cover
invalid/missing keys, normal authenticated round-trip, concurrent creation,
authenticated corruption and rereading after an uncertain write.

No real configured credential directory, persistent account access, host
security setting, external provider or production service is exercised. This
slice does not satisfy final daemon/product parity or migration completion.

## Verification checkpoint

- 138 product tests across nine files, 1972 assertions
- 140 related engine cipher/config-migration/credential-scope/product-contract
  tests across five files, 489 assertions
- Full engine/product build, whole-tree three-stage typecheck, product source
  and test checks, and a compiled Node public credential/cipher round-trip
- Four additive config exports recorded in the SDK subpath contract, now 9825
- Strict completion still refuses unmapped modules/evidence and three products

The initial product typecheck caught a fixture's unknown-block cast and stale
compiled declarations for the new export. The fixture cast was corrected and
a full dependency build regenerated declarations before the passing checks.
