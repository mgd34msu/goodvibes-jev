# Protected local source screening prerequisite

This is a bounded THE-123 dependency for content-bearing intake previews and
later source consumers. THE-123 and THE-18 remain open. It does not establish
complete research-reference screening, default daemon inbox composition, or
live semantic privacy accuracy. Those live proofs remain under THE-35.

## Explicit configuration and trust

`sdk/platform/security` exposes `createProtectedSourceOwner`. A trusted product
composition root supplies all of the following together:

- A source-owner ID, authority revision, revocation signal and synchronous live
  `assertCurrent` callback. These are not parsed from source text or model output.
- An explicit `ephemeral-no-log` retention capability covering both local
  services. The host must establish the services' behavior; a string option or
  loopback address is not evidence that a service does not retain or forward data.
- An immutable literal-loopback proposal endpoint and model, and an immutable
  literal-loopback System One endpoint pinned to `jev-1.13.0`. Only literal
  `127.0.0.1` or `[::1]` with an explicit port is accepted, without userinfo,
  query, fragment, DNS hostname, or configurable path. The only permitted paths
  are `/v1/chat/completions` and `/v1/systemone`, respectively.
- A bounded per-attempt timeout and optional value-free retry-progress callback.

There is no environment discovery, global setting, hosted fallback, credential
creation, persisted configuration, or automatic adoption by the daemon. The
proposal endpoint speaks the non-streaming chat-completions JSON protocol. It
receives no tools or credential. System One uses the existing canonical client
and retry owner with a fixed public local placeholder, not a stored API key.
Services requiring private credentials are not provisioned by this slice.

Dispatch uses an owned, fixed-origin HTTP/1.1 `Client` from the explicitly
pinned `undici/index.js` package entry. Bare `undici` resolves to Bun's
compatibility shim and is deliberately not used. Each client's standard net/TLS
connector reaches only the captured literal-loopback origin, with no global
dispatcher, native fetch, proxy agent, caller connector, redirect, or hosted
fallback. Header bytes and decoded response bytes are bounded; existing deadline,
authority, cancellation and drainage rules still apply. Client sockets are
retired by the owning transport's close. TLS certificate verification is
explicitly required, even when the surrounding process has a TLS-disable
environment flag. No custom CA, credential, or persistent TLS setting is created.

Any configured HTTP/HTTPS/ALL proxy environment variable, including case
variants, keeps admission held. `NO_PROXY` does not grant an exception. The
transport rechecks at each dispatch and canonical retry boundary; it never
rewrites the process environment. This presence check is not the routing proof:
Bun 1.3.14 can retain a native proxy after every environment entry is deleted.
Owned synthetic counterexamples prove native fetch still reaches that proxy,
while the fixed-origin client reaches only the local target, both before owner
creation and between attempts. Proxy-mutating fixtures run in isolated owned
children, preserving the parent suite's native routing state. These are runtime
containment proofs, not live service identity or privacy-calibration evidence.

The capability authorizes only the specified local processing. The host must
establish local service identity, local execution without forwarding, revocation
and no-retention behavior; unknown service provenance must keep the route held.
A passing structural scan, generated span, typed receipt or HTTP response cannot
establish those properties or authorize another destination or external action.

## Capture, proposal, verification and projection

The owner rejects proxies, accessors, malformed arrays and non-string parts
before invoking the shared `snapshotJudgmentInput` boundary. The complete actual
source is checked before content bounds, hashing or model access. Known declared
credential/card material and canonical issuer credentials are refused. This is a
structural floor, not a generic secret detector and not permission to send
arbitrary text to a hosted redactor. At most eight parts and 40,000 total UTF-16
code units are admitted; oversized inputs are refused rather than clipped.

Original strings are immutable and private to opaque process-local handles.
The local generator proposes at most 100 exact ranges with the exact source
revision. The owner validates only declared fields, safe integer offsets,
source-part identity/order, positive in-bounds ranges, no overlap and no split
surrogate pairs. It never accepts generated replacement text. Repeated text
retains independent positions. The exact owner-generated revision is validated
as protocol provenance, not reinterpreted as arbitrary raw card material.

The named, versioned Jev battery judges complete sensitive-material coverage and
precision of the selected ranges against every full original part. Both readings
must settle positively at the declared band before release. Malformed,
unavailable, cancelled, stale or uncertain work yields no projection. A wrong
model response is operational unavailability, not a semantic answer. Transport
outages stay under the canonical System One retry owner and its cancellation and
progress contract. There is no human approval fallback or regex-semantic backup.

Releasing and recapturing identical parts does not reset an unsettled reading.
The owner retains at most 1,024 unsettled revision digests without raw text, with
no eviction that could turn an old hold into repeated sampling. Capacity
exhaustion holds new work before a request. At most 128 original handles are
retained at once. Only one attempt per exact revision is admitted at once; a
different handle for an in-flight revision receives a nonsemantic busy hold.
Potential held-revision slots are reserved before requests, so concurrent
completions cannot exceed the bound. The refusal fingerprint survives handle
release in memory until `owner.close()`; a new process/owner ends this local
scope. A later unsettled attempt also prevents new projection through an older
positive receipt for the identical revision. No automatic semantic repair or
human approval loop is invented here.

Only a genuine settled receipt minted by this owner can project the matching
current source. Projection consists solely of original slices and the fixed
`[redacted]` marker. Forged, foreign, released and revoked receipts fail. Source
and route mutation during asynchronous work cannot alter the captured attempt.
These are deterministic guarantees, not proof of a model's semantic accuracy.

## Lifetime and retention

No raw source or raw judgment state is placed in the general decision log,
telemetry, diagnostics, disk store or a retained request history. Original parts
and accepted projections remain private in-memory values. Each source operation
owns its own transport, so release does not wait for unrelated sources. Release
and close stop admission and await logical calls plus underlying request/body
cleanup, including work that outlives a caller-facing cancellation race. Repeated
close shares one completion boundary. JavaScript strings cannot be reliably
zeroized; this is bounded lifetime ownership, not a memory-erasure guarantee.

Once the authorized caller obtains a projection, later revocation cannot erase
that copy. Callers retain downstream authority and effect boundaries. This API
supplies no publication, transmission, persistence, execution or citation authority.

## Declared research URL query roles

The same explicitly configured owner also exposes a separate bounded route:
`captureResearchReference`, `screenResearchReference` and
`projectResearchReference`. The input is one complete, independently framed URL
cell. It is not an inferred range in prose. The full original faces the same
structural/issuer-credential floor and size bounds before parsing or model use.
The original stays private to its opaque `ProtectedResearchReference` handle.

The owner uses WHATWG `URLSearchParams` only to derive at most 100 distinct
decoded query-parameter names. It preflights every decoded name before any
request. Each semantic request is exactly `{ parameter: name }` under the
registered, versioned `engine.security.research-reference-parameter-role`
battery, pinned to `jev-1.13.0`. It contains no URL, hostname, path, fragment,
parameter value, surrounding source text or value-derived digest. This route
never calls the proposal model. It reuses the existing owner-created System One
port, retry ownership, fixed-origin direct client, authority checks and cleanup.

A confident credential-role reading omits the complete original reference.
Only confident ordinary readings for every name preserve the exact captured
URL. Projection returns a typed `{ status: 'omitted' }` or
`{ status: 'preserved', url }`. It never removes individual parameters, rebuilds
a query, changes encoding, loses duplicate values, removes an anchor, or treats
a changed resource as equivalent. Complete declared malformed/control-bearing
URL cells and userinfo references are omitted without a model request (unless
the shared input floor already refuses their material). No prose is joined.

The opaque `ResearchReferenceScreeningReceipt` is deliberately distinct from
`SourceScreeningReceipt`. Both the type surface and runtime reject cross-mode
handles and receipts. Query-role clearance is **not** complete content-privacy
clearance: path contents, fragments, the meaning of parameter values, and
server-specific query delimiters are not semantically screened here. For
example, fragment text can contain a credential while the URL has no query
names; zero query names entails zero role requests, not a privacy judgment.
All downstream source-privacy, retrieval, display and outward-effect authority
still belongs to the consumer. This capability must not be used as a safe-URL
predicate, generic redactor or publication approval.

At most 1,024 role digests and typed outcomes are retained per owner, including
reserved in-flight slots; names and values are not retained in that cache.
An unsettled name remains held across changed URL values, other source handles,
and alternate percent-encoded spellings. Concurrent distinct references using
the same in-flight name get a value-free busy hold. Capacity exhaustion holds
before another request. There is no cache eviction or lucky-answer resampling.
Wrong-model responses and transport failures remain operational unavailability.
Release/close still await owned calls and transport cleanup; close clears the
role cache. Existing source-handle and unsettled-revision bounds are shared.

This is a further THE-123 prerequisite, not completed consumer adoption.
The [owned tool-input projection prerequisite](protected-tool-input-projection.md)
adds an explicit framed-reference adapter and earlier registered-tool ingress;
it does not turn this query-role receipt into full source-privacy clearance.
Unbound control-split reference boundaries cannot be inferred from URL parsing:
the same newline can divide an interrupted URL or separate a complete URL from
ordinary prose. The [Agent report adopter](research-report-protected-adoption.md) now uses
full-source screening alongside these name-only receipts across its editor,
prompt, registered ingress and artifact paths. It preserves source IDs and
claim bindings, covers report text and aliases, awaits complete preparation,
and rejects stale or cancelled work. Both unbound-reference controls run with
synthetic verified spans; whitespace is never treated as URL provenance. Synthetic name-role responses do not qualify a live model or
establish the configured local services' identity/no-retention behavior.

## Inbox mapper adoption

`sdk/platform/intake` exposes `createProtectedInboxMapper(owner)`, compatible with
the existing private Slack and Discord mapper ports. Descriptor-only capture
rejects proxies, getters and extra input fields. Both the complete raw subject
and body and their canonical deterministic display candidates are screened in one
owned operation before display clipping. Provider sender/channel identifiers
remain bounded local protocol fields and never enter either model request. The
identical characters in subject/body still face the unchanged privacy floor.

The returned sender is the canonical digest, with 200/500-character subject/body
limits that do not split surrogate pairs. The mapper returns null for held or
cancelled work, preserving whole-poll withholding and the unchanged cursor. It
never substitutes empty or raw content. Original handles are released afterward;
no unauthenticated raw-message retrieval endpoint is installed. Display values
remain plain text; consumers retain their normal safe text-rendering boundaries.

This does not select credentials, complete Slack account/cursor ownership,
supply Discord's missing complete DM catalog, touch legacy IMAP, or install a
default provider set. The original `mapping.ts` disposition remains partial.
No native settlement-security certification is claimed.

## Verification boundary

Tests use synthetic text and actual owned loopback proposal/System One servers.
The System One server scripts typed readings; no live model calibration or real
private source is involved. Coverage includes exact projection and preservation,
source mutation, foreign/forged receipts, strict ranges, generated references,
shared retry recovery, revocation/cancellation, capacity and uncertainty stability,
and the real Slack adapter → registrar → SQLite mirror → wire inbox path.
Transport tests cover exact routes, redirects, byte bounds, cleanup and proxy refusal.

The local services' identity/no-retention capability and genuine Jev calibration
need explicit live proof under THE-35. THE-123's name-only declared-URL role
capability now has synthetic containment tests, including raw-value absence and
distinct receipt scopes. Agent report consumers now have explicit fail-closed adoption and active
synthetic unbound-reference controls; live screening deployment remains open. No release or deployment is implied.
