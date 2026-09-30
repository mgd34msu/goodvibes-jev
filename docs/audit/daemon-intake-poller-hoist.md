# Inbound poller ownership and leadership handoff

THE-26 hoists the pinned daemon poller and its four original tests from
`443e5ee4d6cda0d36d57e2886398d0836074a4a9` into the public host intake subpath.
The source revision is the same daemon migration pin; no provider implementation,
route schema, preview redaction or semantic triage is changed in this slice.

## Preserved behavior

Polling remains per-provider at the adapter's cadence, with bounded requested
item count, persisted `since` cursor, dedup/upsert, monotonic watermark and
provider status. Start methods remain synchronous and do not poll immediately.
Manual polling remains available before start. A rejecting adapter still reports
unavailable rather than taking down another provider. Explicit unavailable
result error strings and adapter-reported configuration state are preserved.

## Ownership corrections

The unchanged imported source ran 5 pass and 9 fail across the original and
initial lifecycle tests. Stop cleared timers but returned before a fetch or
persistence operation finished; a late result could mutate the store after
handoff. Manual polls and queued callbacks still ran after permanent stop.
A restart could accept an older generation's response. A cursor-read exception
outside the try block stranded the in-flight flag. Adapter invocation was
incorrectly treated as proof that credentials resolved. Throwing logger/timer
callbacks could escape ignored asynchronous work. Overlapping manual requests
returned before the shared work completed.

The port owns an operation promise and AbortController per provider, and checks
its generation before accepting results or reporting completion. A stopped
fetch's late result never advances items/cursors. If persistence already began,
the stop waits for it rather than abandoning an accepted write. A queued timer
is tied to the generation that created it, including across restart. Stopping
one provider leaves the others running. Public polling entry points also honor
permanent release. Cursor reads are inside the protected operation; settlement
always releases ownership. Logger/timer cleanup failures cannot create an
unhandled stop promise.

`configured` comes only from an explicit adapter result. If an adapter throws
before such a result, configuration remains unknown. If storage fails after a
result, its explicit configuration evidence is retained. This reads structured
facts; it does not replace the false inference with a semantic guess or Jev
fallback.

## Caller contract and limits

- `ProviderPollOptions.signal` is optional and cooperative. Adapters should
  connect it to their fetch/socket lifetime. An adapter that ignores it is still
  awaited; the poller does not pretend an unresolved request has stopped.
- `stopProvider(id)` now returns a Promise. The leadership gate MUST await it
  before announcing handoff. A later explicit start can resume that provider.
- `stop()` closes admission synchronously and returns one non-rejecting promise.
  Legacy callers may ignore it without an unhandled rejection, but shutdown
  MUST await it before closing the cursor store. Neither stop method owns or
  closes the shared store.
- Existing daemon inbox composition is not ported yet. Its `stop` wrapper must
  await stopProvider, and unregister must await stop before closing the store.
  Until then, this is a tested engine seam, not completed product integration.

Twelve lifecycle cases plus the four original tests pass. The selected combined
inbox/storage suite passes 70 tests across seven files (183 assertions), covering
leadership drain, restart, stale timer callbacks, independent provider ownership,
retry after cursor failure, unavailable evidence and synchronous compatibility.
All provider results are synthetic; no live inbox or credentials were accessed.
