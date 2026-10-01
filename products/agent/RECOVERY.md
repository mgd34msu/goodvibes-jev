# Agent source recovery

This is an incomplete workspace reconstruction from goodvibes-agent
`f05fe636c120baa469037efe7d7391c3d9503635` (tree
`7f5575e17a8f52f638b145830f9a4fc4e4bf650f`, 1,650 tracked files).
It is private and is not ready for product publication or interactive use.

The source references the monorepo's public engine, terminal-shell, toolchain
and daemon packages. The root workspace lock is authoritative. The upstream
standalone scripts, release records and lock remain retained source material;
they are not an accepted Jev release or installation contract. Standalone
release and publication scripts are not exposed by this workspace's manifest.

The source and package launchers support help, version, completion and parser
errors through the original parser and help renderer before loading the
interactive graph. The interactive implementation remains in `src/interactive.ts`.
This early command boundary does not establish interactive runtime compatibility.
The obsolete unused clipboard export is removed, and the store now uses the
public engine factories. Full bundling stops at the retired WRFC construction in
`src/runtime/services.ts`. Further runtime and semantic migration remains unfinished.

Fresh local evidence for the ordinary adapter checkpoint: 269 CLI, renderer,
profile and store tests, with 2,659 assertions. This includes source/package launcher subprocesses and theme,
diff, markdown-width and terminal-size behavior. The corrected source diagnostic has 108 errors, down from 146 at initial
materialization. The ordinary rendering/configuration fixes remove their own
diagnostics and consume the SDK source declarations. Full product compilation,
interactive startup, binary packaging and end-to-end acceptance have not passed.

No captured-input authority proposal or unpublished shared engine overlay is
part of this source recovery. The engine base is published main
`9363f44d186e152f5c829aa106d5645ce3ed02a0`.

## Published service graph checkpoint

The Agent now consumes the client runtime's actual contract runner, operator and
intake services, judgment and session snapshot. Both orchestrator dependency
rewires retain the manager, contract hooks, foreground permission manager and
all approval-derived handlers. The obsolete WRFC engine construction is gone.
The client runtime owns live preset events; the Agent consumes those canonical
store events and preserves its typed turn-budget and compaction notices.

The actual Agent graph constructs and disposes offline, and a live preset change
updates its store and produces one UI notice. A services-only bundle succeeds.
The combined ordinary suite passes 281 tests and 2,723 assertions across 23 files.
The latest source diagnostic has 89 errors, before the subsequent asynchronous
memory command caller fixes. It reports no errors in the changed service graph.

Interactive/main bundling remains blocked by notification exports absent from
published main (buildApprovalNotification, describeToolTarget, resolveTurnName).
No held notification implementation is copied. The canonical Agent-specific
contract-event presentation helper is also not published yet. Full prompt memory
ranking, wider command/view migration, product types, binary and end-to-end
acceptance remain incomplete. The registered tier reader is now awaited with
operation-signal caching; that change alone is not complete prompt parity.

## Contract view and fleet checkpoint

The lane graph reads public contract views and recorded tool outcomes. It renders
owner questions/replies, attempt/check details and commit notes, keeps legacy
outcomes unknown, and marks failed application as a display warning while the
contract lifecycle remains passed. Restored owners remain visible without a
live Agent record. Agent-specific fold restoration and header calls are retained.
The fleet CLI uses the runner's real attempt controls and qualified IDs.
Its one-shot calls explicitly skip background model-data refreshes.

The combined ordinary suite passes 311 tests and 2,830 assertions across 26 files.
This includes real offline fleet CLI calls, the actual service graph, and the
contract view behavior. A prior run's external-I/O guard failure is preserved;
that run was not a pass. Current source/type rechecking is queued separately.
