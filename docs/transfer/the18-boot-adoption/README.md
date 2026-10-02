# THE-18 explicit production boot adoption

This is a bounded continuation of THE-98 on merged THE-102, not completion of THE-18.
Base commit: `46a3201d54147f993eeda51eb7ab814f867c2f8e` (tree `d836764c759a9c208a6922c6ed4fe282d6c9c8b6`).
Only six daemon source/test files are in the production patch. No engine/API snapshot, executable/default inbox, persisted privacy schema/default, live credential, merge or deployment changes.

## Production behavior

- `createDaemonBootOperations(runtime)` supplies the existing explicit `createBootOperations` option. It folds actual legacy memory, starts the actual provider watcher and awaits terminal `closeWatching`, attaches the existing shared webhook even with zero URLs, acquires real `Notifier.fromConfig`, synchronizes actual service and notification queue facts, and initializes actual daemon plugin registries.
- Shared webhook construction receives a live, fail-closed privacy reader and is owned immediately by the base graph. Notifier receives the same policy behavior. Only an actual literal-false config read permits rich content; this slice installs no setting/schema or default.
- Every acquired boot owner fences admission before the first awaited cleanup. Independent provider and webhook drains remain owned while plugin cleanup is held; handler/base teardown stays outside and after the full boot drain.
- Reentrant provider start registers an additional post-start cleanup obligation rather than memoizing an empty early stop. Arbitrary cleanup rejections become bounded, fixed-message failures without being inspected or retained.
- SDK factories use fail-fast Promise.all internally. The product uses a scoped borrowed view of its concrete ServiceRegistry to track actual inspect/resolveSecret calls and await all siblings before returning either success or failure. It does not mutate the shared registry or change generic SDK lifecycle contracts.
- Configured-service facts augment notification rows without overwriting a real webhook-only Slack/Discord queue as unconfigured. The daemon has no operator notification URL handler in this tree, so no such parity is claimed.

Boot source mapping was checked against goodvibes-daemon `254699bf5d834cdca41436211ada1ae32bf89258:src/runtime/boot-tasks.ts`.

## Verification

`manifest.json` is authoritative for final hashes, tree and exact check outcomes. All test commands use the repository's guarded runner, temp home/workspace, synthetic config/credentials, actual graph/server/plugin/registry methods and intercepted outbound network boundaries.

Focused proofs include actual plugin HTTP, actual memory import and failed legacy source, configured/unconfigured service and webhook-only Slack queue facts, zero-URL bus attachment and later shared-owner delivery, live missing/malformed/throwing/asynchronous privacy reads, late notifier acquisition with no attachment/publication, graph-construction cleanup, held actual plugin call plus provider reload and webhook response-body cancellation in both release orders, actual provider model and event results, reentrant/hostile cleanup failures, and rejected+held credential siblings.

Controls:
- Amended original controller: 0 pass / 3 fail, preserving each original missing admission/late-drain/lost-rejection proof. The original raw-error-identity assertion was deliberately replaced by a bounded error assertion.
- Eager fences removed: only the held-plugin admission assertion fails; reentrant provider proofs still pass.
- Credential sibling drain removed: both notifier and configured-services cases fail the intended assertion that a step cannot report failed while its admitted sibling remains held.
- `no-sibling-drain-unbound-reporter.log` is INVALID as a successful notifier negative-control proof. It records an obsolete test reporter bug. The final `no-sibling-drain.log` has a bound reporter and both cases fail the intended assertion.

Full daemon tests, existing notification/provider/plugin lifecycle suites, normal build, forced full typecheck, API extraction/subpaths, type tests, no-any, architecture, docs and credential-scope gates run without relaxing their scripts. Existing API Extractor third-party declaration warnings and WebUI chunk-size warning are retained. Full aggregate validate/whole-repository test matrix and exact published CI are not claimed by local checks.

## Reconstruction/publication contract

1. Start a clean branch/worktree at manifest base_commit.
2. Verify source.patch SHA-256, then `git apply --index source.patch`.
3. Confirm `git write-tree` equals candidate_tree and all six file byte counts, SHA-256 values and Git blobs match manifest.json.
4. Publish exactly that source tree as a draft only from the authorized environment. Do not include these transfer/evidence documents in the production PR.
5. Rebase only with conflict inspection and fresh applicable checks. Do not reuse these tree claims for a different candidate.

Independent review is recorded in the manifest. Remote publication/CI, executable boot installation, default intake composition, host-setting registration, operator notification verbs, host-service packaging and live proofs remain separate work.
