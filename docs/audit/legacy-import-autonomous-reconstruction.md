# Autonomous import reconstruction checkpoint

This is a new reconstruction after the October 3 executor replacement, not a claim that the lost intermediate source was recovered byte for byte. The original checkpoint started from public main `874ebe17` and published import core `6235459f`. The October 4 local integration composes the PR94 conformance/publication repair `12c86e60` on main `2cd57620`, the protected read/recovery checkpoint `fc9d0d38`, and exact-command journal mutation repair `6e318359`. Publication and the final remote base remain separately coordinated.

## Restored and tested

- One canonical workspace/project journal path for Agent and TUI, with realpath alias convergence and fail-closed detection of an earlier Agent journal.
- Complete immutable import command and request identity, private SQLite files, immediate cross-process transactions, EXTRA synchronization and containing-directory/ancestor fsync ordering. Tests cover process interruption, not hardware power-loss guarantees.
- Pending, unknown, accepted, rejected and cancelled recovery states. Unknown requests retain exact command identity; cancellation after dispatch cannot imply rollback. A late accepted receipt wins over later rejection. Every result variant is structurally validated.
- Journal dispatch, cancellation and result recording require the caller's exact captured command. Each compares the complete validated command inside the same immediate SQLite transaction that updates the slot. A stale admission, cancellation or rejected result cannot mutate a later replacement under the same endpoint/project/principal. The check does not itself grant semantic authority.
- Actual shared `JevDecision` provenance stored alongside the exact command and authenticated selection. Structural receipt parsing does not grant execution permission. Old journals retain empty provenance rather than gaining invented decisions.
- Host preparation uses existing admin, `read:work-ledger` and `read:knowledge` authority. Both product command entry points allow preview/status without a keyboard gesture or human-confirmation claims. Complete pagination is mandatory; malformed cursors, duplicate source IDs and the 5000-source discovery cap fail closed. Revocation is checked again before displaying protected read results.
- Product clients pin the existing endpoint, credential and authenticated principal. Credentials are neither minted nor persisted in the journal. Source history remains historical and unverified.

Focused tests are `legacy-import-recovery-reconstruction.test.ts`, `legacy-import-request-binding.test.ts`, `legacy-import-read-reconstruction.test.ts`, and `work-ledger-import-transport.test.ts`. They exercise synthetic data and actual product/host route code, with no live user import.

## Remaining production dependency

The products expose only preview/status in this checkpoint. Mutation submission, autonomous reconsideration and exact dispatched recovery are not yet composed to a semantic evaluator. The inherited core route is the published PR94 behavior; it still needs the host-owned autonomous admission integration before this workflow can be called complete.

Required shared seams are the real recorded Jev evaluator, one availability retry owner, registered versioned continuation/condition execution, and live authority/scope generation retrieval. The host must independently capture command/source/authority/scope revisions, validate actual recorded judgment lineage, persist exact decision provenance, and recheck revocation/currentness at atomic dispatch. A parsed `act` receipt, a model-supplied flag, or equal principal/scope strings after revocation and restoration cannot substitute for these checks.

Native ledger types/service and daemon composition are coordinated with the separate native execution reconstruction. No competing judgment schema, retry loop, human-confirmation fallback or fabricated act evaluator is supplied here. Independent review and full native autonomous execution acceptance remain outstanding.

## Original checkpoint validation (October 4)

Fresh engine build, engine test types, Agent test types, TUI test types and public consumer types pass. The actual Agent/TUI route tests now live in their product test projects instead of importing product implementations into the engine composite project. JSON test fixtures use explicit NodeNext import attributes. Seventeen focused tests pass with 84 assertions.

Public API extraction and subpath checks pass after adding the import subpath baseline. The only unrelated SDK surface change is literal ordering in the existing `ownerReply` union; membership is unchanged. TUI's bundled contract artifact reflects preparation's dedicated read scope.

Fresh Linux artifacts pass the unchanged standard version/artifact smoke checks, including eager namespace initialization scanning. Agent SHA-256: `a31d4fa5524df2371a12460d152ffd143885391bec9f3c310c11d86385d47182`. TUI SHA-256: `2ebbab568d8f30a78f7397a06b4f0010859980b540ebb9e91badfbf2f30f38bd`. Importing the compiled shared module under Node succeeds; journal construction without Bun fails explicitly before creating storage.

The isolated compiled PTY probe found and fixed a reconstruction defect: a single JSON output line clipped the actual status in Agent. Shared output now prints readable status/binding/preview lines. The final rebuilt Agent and TUI each authenticated twice against the exact synthetic local host, rendered `/work-import status synthetic-project` successfully, and exited naturally with code 0. The host granted only admin plus `read:work-ledger` and `read:knowledge`; mutation routes were refused. Each surface created one private 0600 journal with zero saved commands; the pre-existing synthetic token remained unchanged. There were zero import requests and zero external network violations. This proves compiled protected read entry points, not autonomous import or native execution. Earlier fixture attempts and their raw terminal evidence are retained separately. No live import or real credential was used.

## Composed integration proof (October 4)

The repaired PR94 base and exact-command journal repair compose without source conflicts. The independent negative control removes only the new in-transaction command comparison: all five request-binding regressions fail. Restoring it makes all five pass, including a separate restarted process. The wider import/ledger/Agent/daemon suite passes 194 tests; the journal, protected-read, real-SDK and cursor-pagination suite passes 71 tests. The two actual Agent/TUI command-entry tests, 31 required-field/import conformance tests and 109 operator SDK/catalog/OpenAPI/schema tests also pass. These overlapping suites are reported separately rather than summed.

A stronger compiled preview probe exposed a real contract mismatch that the earlier injected-client tests did not cover: `knowledge.sources.list` advertised pagination but its output schema accepted only the legacy `{ sources }` envelope. The shared contract now validates either the legacy result or the existing `{ items, hasMore, nextCursor? }` cursor result. Source-record validation stays enabled. The generated client types, API baseline, OpenAPI, operator reference and TUI contract artifact were regenerated. The real operator-SDK HTTP regression proves full discovery and preparation, legacy compatibility, rejection of malformed pages and post-page revocation. No client disables response validation to make the probe pass.

Rebuilt Linux Agent and TUI binaries each pass all three isolated PTY scenarios:

- `status` authenticates twice and renders the empty durable recovery state.
- `preview` authenticates eight times, consumes two source pages and makes exactly one preparation request before rendering the complete manifest.
- Revoking `read:knowledge` while the first source page is returned stops the workflow after four authentication reads and one source page, before any preparation request.

Every scenario exits naturally with code 0, preserves the pre-existing synthetic credential byte for byte and leaves one owner-only 0600 journal containing zero saved commands. There are zero import requests and zero external-network violations. The local synthetic host rejects unrelated product startup requests; no real credential, user source or live provider is involved. Both unchanged standard artifact/version smoke checks, including eager namespace initialization scanning, pass. Verified Agent SHA-256: `564c6e75132751b845cf450af57ec96b4e503a8c436afac2a8079dac25862fcd`. TUI SHA-256: `58e4c32080497eb5dd9e58be19a52c78a9362cd058423557fe368efa85c8977c`.

This acceptance covers durable exact-command storage and protected compiled read routes. It does not establish autonomous import dispatch, a production Jev evaluator, shared availability retry, native runner wiring or power-loss durability. Those remaining host-owned dependencies above are unchanged.
