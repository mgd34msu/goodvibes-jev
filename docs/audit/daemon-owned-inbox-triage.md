# Owned inbox triage integration

## Source and bounded restoration

Upstream `mgd34msu/goodvibes-daemon` at
`254699bf5d834cdca41436211ada1ae32bf89258` has
`src/daemon/handlers/triage/integration.ts` (blob
`eb0c756fc6d4fca1c2c616a105bfa983eeb53a14`) and
`src/runtime/daemon-handler-composition.ts` (blob
`9deea66bb926ecc5fcaecc7d895ba6dc7bb4a320`). The integration exposes explicit
`runInboxTriage` and decorates `channels.inbox.list`. The original composition
uses its unregister callback; the poller does not call scoring. This restoration
therefore adds explicit scoring and read enrichment, not automatic poll scoring.
The upstream tagger remains outside this slice.

The host-only intake subpath now exports `createOwnedTriagedInboxSource` and
`registerTriagedInbox`. The former owns one provider/account and can participate
in `registerCompositeInboxSurface`; the latter also binds the existing canonical
inbox method. Both return an explicit `runInboxTriage(query, operation)` API.
No method is added to the gateway catalog. Existing plain inbox registration
continues unchanged unless an explicit enrichment hook is supplied.

The owned API deliberately adapts upstream item-batch scoring to a query over
its admitted mirror. Callers cannot substitute unscreened semantic input. One
call selects at most 100 rows, reports `total`, `hasMore`, and `nextCursor`, and
refuses larger requested limits. It does not silently loop, retry, or score the
rest of a mailbox. A caller may explicitly submit a subsequent cursor. Scoring
calls are serialized per owner; latest receipts follow admitted operation order.

## Authority and exact inputs

A constructor-only `InboxTriageAuthority` attests to a destination-bound port,
provider/account scope, ephemeral no-log retention, a revocation signal, and a
synchronous live proof. The destination name is descriptive, not itself a grant.
The trusted host owns the correctness of that port and grant. No configuration,
message, environment variable, ambient runtime port, or production bootstrap
creates this authority. Missing authority allows clean un-enriched local reads
but refuses scoring with zero judgment calls. Revoked authority refuses the
whole read or score. Account read leases remain independently mandatory.

One deterministic projection maps the protected wire snapshot to canonical
`TriageInput`: provider-scoped ID, provider, protected subject/body preview,
unread, and only adapter-declared `dm` to `direct` or `thread` to `thread`.
Mention/reaction imply no conversation kind. The canonical core's existing
omission-to-`service` normalization is a default, not inferred provider evidence.
Sender, route, credentials and adapter metadata are never transmitted. Canonical
privacy and size validation happen before judgment; no clipping bypasses them.

The existing typed pipeline/battery/store/receipt validators perform all
judgment and evidence interpretation. A guarded port checks authority at the
outbound call and supplies the transport's synchronous attempt guard. An owned
signal combines operation, grant and owner cancellation. The final SQLite
publication fence repeats synchronous account/semantic proof and compares the
exact selected mirror inputs to those scored. Changed rows cannot commit stale
receipts or overwrite current labels. There is no externally injectable store
in the owned API that could ignore the publication fence.

## Read and storage ownership

The canonical registration invokes optional per-source triage enrichment after
aggregation but before asynchronous validation and the final synchronous
all-owner fence. Every source lease remains held throughout. Hooks receive
immutable detached rows for their own provider only and return overlays; the
registration copies only `triageScore`, `triageLabel`, and `triageTags`. Identity,
order, counts, cursors, status and original row fields remain untouched.

Pages up to 500 rows use bounded chunks of 100. Empty reads and dry runs do not
construct a triage store. A missing image yields no evidence. Corrupt or
incompatible optional storage yields a clean un-enriched page and the fixed
`Inbox triage metadata unavailable` diagnostic; no repair, quarantine or content
logging occurs. Input/privacy rejection and account/semantic revocation are not
swallowed as optional storage failures. Held/unavailable latest attempts and
mismatched inputs or model receipts suppress historical labels.

A SHA-256 filename discriminator includes an explicit version domain, provider
and account scope. Its lifetime cross-process ownership lock covers the owned
mirror and triage database. The canonical SQLite store also retains its
process-local same-path queue and atomic rename. Close synchronously fences new
work, aborts semantic work, starts source retirement, drains accepted source
reads/scoring/commits, and closes storage before releasing the lock. Failed
storage retirement retains ownership; uncooperative accepted operations remain
pending rather than being falsely reported drained.

## Proof and limits

`intake-triage-owned.test.ts` exercises real cursor and triage SQLite stores,
exact input changes, missing authority, empty/dry runs, held/unavailable/model
mismatch, corruption, independent accounts, 500-row read chunks, revocation
during judgment/commit/enrichment, and close drainage. The daemon
`owned-triage-http.test.ts` calls the returned scoring API through the real Jev
port against a synthetic loopback endpoint and then reads authenticated daemon
HTTP. It also checks anonymous denial and zero scoring from polling/listing.

This is synthetic composition proof, not live calibration or production
semantic-transmission authorization. It adds no provider tags/writes, background
scoring, retries, new catalog methods, default serve activation, or credentials.
