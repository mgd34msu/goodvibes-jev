# Native work ledger integration provenance

This is new THE-105 read-only integration over the recovered Agent product, not
restoration of the lost unpublished implementation and not whole-product parity.

## Source identity

- Integration base: `1d7d8e301e3f4e1584def485b7b3b03cf7796476`
- Implemented source: `ea3f6e3818616675be86f256afe4444614631cf8`
- Implemented tree: `ac1ad1d1b0fe2ebd6a49f19da48d8761608fb3fa`
- Original inventory revision remains `9e225a349667632bb550e9c270d922b985848eaa`.
- Refreshed upstream revision remains `f05fe636c120baa469037efe7d7391c3d9503635`
  (tree `7f5575e17a8f52f638b145830f9a4fc4e4bf650f`).

The six affected baseline mappings now say `adapted-native-read-only`, preserving
`retained-source` as their previous status. Their source paths, dispositions and
targets are unchanged. This correction does not reclassify any unknown source as
DROP, add invented baseline mappings, or clear the existing 451 unmapped Agent
source obligations. `source-reconciliation.json` remains unchanged. The migration
status remains partial; earlier recovered-union proof does not establish current
native-integration aggregate validation.

New product-owned files are `src/runtime/native-work-ledger.ts`,
`src/runtime/native-work-ledger-host.ts`, `src/renderer/native-work-ledger.ts` and
three native ledger test files under `src/test/runtime` and `src/test/renderer`.
These are new integration artifacts, not upstream source successors asserted by
this metadata correction. Existing `src/interactive.ts` and
`src/renderer/agent-workspace.ts` also changed in the identified implementation;
this note does not manufacture missing baseline mappings for them.

## Verified behavior and limits

`/work` uses passive empty-input `projectPlanning.status` discovery on the selected
authenticated host; `/work <daemon-project-id>` selects explicitly when discovery
is unavailable or its separate `read:knowledge` scope is absent. The public
operator ledger reader enforces the host's project and read permissions. No
surface-local store, path-derived ledger identity, new grant or mutation is used.

The real workspace displays intent, stable work/attempt IDs, criterion revisions,
reported state separately from verification, attention, evidence and durable
history. Paging reaches long detail. Epochs invalidate stale snapshot/history,
discovery and unavailable callbacks. Subscription precedes snapshot; durable
history catches coalesced updates. Closing/reopening and throwing cleanup are
covered. Existing legacy work/approval identities and confirmation paths remain.
Ledger-to-runner admission and stopped PR56 work remain outside this scope.

At the implemented source revision, the canonical guarded focused run passed
70 tests with 795 assertions across:

- `src/test/runtime/native-work-ledger.test.ts`
- `src/test/runtime/native-work-ledger-transport.test.ts`
- `src/test/renderer/native-work-ledger.test.ts`
- `src/test/renderer/agent-workspace.test.ts`

The transport tests use the production SDK against a synthetic authenticated
loopback HTTP contract fixture, not a live provider or a claim of live-product
parity. Entrypoint syntax is covered after correcting import/shebang placement.

Aggregate validation remains incomplete: production typecheck was SIGKILLed with
a bounded 1024 MiB heap and no diagnostics; the full Agent test process was
SIGKILLed after 1,193 passing test lines and zero recorded failures across 105
entered files; package build was SIGKILLed after the syntax correction. Test
typecheck was not run after that resource failure. These are not aggregate passes.
The metadata-only follow-up does not change executable behavior or supersede
these evidence limits.

## Peer-review follow-up

Two reproduced PR84 defects were repaired without changing authority boundaries:

- Ordinary PageUp/PageDown now scroll a visible legacy task/approval result;
  Ctrl+PageUp/PageDown independently navigate native ledger detail. With no result,
  ordinary paging still navigates the ledger. The regression drives terminal
  escape sequences through the real tokenizer, input handler and renderer, and
  reaches the final line of a 60-line legacy result.
- Discovery retains its AbortController locally and checks its epoch, active state
  and abort signal after publishing loading. A synchronous render can revoke the
  real connected-host token or disable dial permission without throwing or
  starting discovery/ledger reads. Both resolver/render regressions failed before
  this repair and pass afterward.

The focused renderer, native model/transport, command-surface and alias checks
remain the evidence boundary. Full type/build/product parity remains unverified;
these peer repairs do not clear the aggregate resource failures recorded above.
