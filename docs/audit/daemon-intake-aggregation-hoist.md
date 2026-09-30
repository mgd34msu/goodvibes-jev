# Inbox mirror aggregation

This slice hoists daemon inbox/aggregator.ts from the pinned daemon source
443e5ee4d6cda0d36d57e2886398d0836074a4a9 into the host intake subpath. It reuses the
engine GatewayVerbError rather than adding another HandlerError class. Future
product handler plumbing must preserve that existing code/status refusal shape.

The read remains a mirror read, never a remote fetch. It retains newest-first
ordering, stable ID tie breaks, bounded limit normalization, provider/since
filtering, totals over the filtered feed, opaque nextCursor page positions,
separate freshness watermark, and every known/requested provider's status.
Standby status remains pending. Explicitly unconfigured providers are named;
unavailable providers whose configuration is true or unknown report error and
make the answer partial. Consumer type assertions connect the public input and
output to the authoritative generated channels.inbox.list contract maps.

The implementation retains prior behavior after an outage: already stored
history is still returned, accompanied by the error/partial status. The original
header incorrectly implied every failed provider contributed no items; that
claim was true only for providers with no previous mirror. The comments and an
explicit history-then-outage test now state what the code actually does.
lastSyncAt remains the last completed attempt, successful or not, as the shared
catalog schema defines; it is not renamed into a success timestamp.

Tests exercise the real cursor store/poller and pure aggregation/query layer,
including provider attribution, tied timestamps, cursor/watermark distinction,
known and unknown configuration, outage with preserved history, standby reads,
malformed cursors and wire mapping. These are synthetic fixture providers. The
original full catalog-composition aggregator suite remains pending until the
inbox registration and provider layer is ported; this slice does not claim to
replace that integration coverage or finish the product inbox.

The 13 focused read-layer cases pass, including concurrent provider persistence
across restart. The combined guarded remote/inbox/storage run passes 260 tests
across 24 files (680 assertions). Build and public consumer type checks pass;
API surface artifacts are regenerated. Full catalog/provider integration is
still excluded from this claim.
