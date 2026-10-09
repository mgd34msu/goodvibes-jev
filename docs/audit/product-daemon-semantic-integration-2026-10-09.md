# Product, daemon and WebUI semantic integration, 2026-10-09

This is a bounded integration receipt. Migration, live-provider calibration,
browser acceptance, publication and the separate model/config/card-owner work
remain incomplete. No live credential or provider was used for these checks.

## Integrated source

The base is `f5763d4d514f6904c3b8111b8aacc9e88e4ef4da`, the corrected
PR230 product batch. Its predecessor `5b31af7e` and published PR230 head
`a3dc8416` have identical tree `edc29b9334bdc3a4746b257690c5044a52d83c54`.

The following frozen contributions are composed together:

- WebUI canonical semantic callers and read-only discovery: `2694395857cff78d874b8406346325c6f6188891`.
- Compiled hosted-session protocol/lifecycle proof: `eebbd37b4e930163a1ffc8bec81561eccf0002fe`.
- Daemon startup maintenance: `9ba9be529c914a563b37cbf37aeee44aec923c10`.
- Canonical token path/inode alias protection: `0580067f9e3688c660cf567775f8000df841cb13`.
- TUI shared metrics leaf and cycle removal: `bcfed08e1b3cb828f0d52356b4ff65e365f131e7`.
- Daemon updater/control readings and shared failure capture: `440cff938313101171470f426dc968b34753ddd7`.
- ACP permissions, actual remote-command callers and hosted intake: `117d40448ec6e850d42df4522249eb238cdcab42`.

The only authored-source merge conflict was daemon CLI dispatch. Its resolution
keeps both the WebUI's read-only machine discovery path and structural
configuration diagnostics for serving. Published-PR230-based leaves were applied
as their own changes, avoiding reintroduction of their older base snapshots.
The compiled proof retains the already corrected owned-PID shutdown verification.

A full compiler pass exposed one test declaration error in the alias-protection
leaf: a mocked `realpathSync` also needs its typed `native` member. Commit
`4aa4f3e1` preserves that member on the throwing mock without changing runtime
code or weakening the negative-path assertion.

API artifacts were regenerated from the combined emitted declarations in
`2305ab78`. Compared with the corrected base, no exported names, public class
members or required interface member names disappeared. `validateDynamic` is
retained. The SDK report covers 177 subpaths and 10,565 exports; terminal-shell
covers four subpaths and 212 exports. Semantic caller changes and new optional
ownership/lifetime parameters are intentional; this is not a claim of unchanged
behavioral semantics.

The source-preservation comparison verifies 10,120 untouched base entries by
blob and mode, with no base-path removal, unexpected change or mode change.
Explicitly composed entries are the CLI union, regenerated API reports, the
startup follow-up's test/document updates and the typed mock correction.

## Local qualification and source attribution

The runtime union before the test/report-only corrections is
`0aaa247b15b8b3ef54bc29e12ea394f6fa061604`, tree
`4ee732be54f0a07e640dbd5b71e97fb937c16819`.

| Check | Result | Tested source |
| --- | --- | --- |
| Engine production build | Passed | `0aaa247b` |
| Affected engine daemon/ACP/hosted/browser/pairing suites | 1,993 tests, 133 files, 8,670 assertions | `0aaa247b` |
| Emitted daemon build and complete daemon suite | 1,077 tests, 96 files, 12,364 assertions | `0aaa247b` |
| WebUI complete source and memory-review fixture suite | 2,923 tests, 221 files, 13,028 assertions | `d8b0a2b7`; all WebUI files remain byte-identical afterward |
| WebUI production build | Passed, large-chunk advisory only | `0aaa247b` |
| WebUI script suite | 116 tests, 10 files, 361 assertions | `0aaa247b` |
| WebUI packaging, separately isolated | Six tests, one file, 11 assertions | `0aaa247b` |
| TUI metrics/turn/remote/pairing regressions | 179 tests, nine files, 1,235 assertions | `0aaa247b` |
| Token-pruning correction regressions | 28 tests, three files, 125 assertions | Working tree byte-identical to `4aa4f3e1` |
| Corrected engine test type project | Passed | `4aa4f3e1` |
| API extraction, regenerated subpath check | Passed | Runtime source `4aa4f3e1`, generated surface committed as `2305ab78` |
| Final source/contract/API/architecture gates | Passed | `2305ab78` |

The original full root type run on `0aaa247b` is retained as a **failed** run:
its solution stage reported exactly the mock declaration diagnostic above.
Its standalone type-test project and all nine product configuration projects
passed. After the test-only correction, the affected engine test project passed;
the already passing product projects were not redundantly recompiled.

The final source gates cover credential classification, product inspection,
judgment fixture/call coverage, zero-any, version/error/internal-ID checks,
temporary-file architecture, platform-console rules, exports, contracts,
contract freshness, generated docs, browser compatibility, package metadata,
subpath API equality and TUI architecture. TUI's unchanged checker reports zero
cycles across 629 non-test files and six boundary rules. API Extractor's bundled
TypeScript/dependency/ambient-declaration warnings and metadata's missing live
README-reading advisories were non-failing. No live reading was manufactured to
silence an advisory.

These are category-specific receipts. Earlier contributor checks overlap them
and must not be added to their counts. A scoped unchanged-source comparison does
not establish an exhaustive dependency closure or a new literal exact-head run.

## Compiled daemon acceptance

The Linux-x64 artifact built at `0aaa247b` passed the isolated verifier at
`4aa4f3e1`. The sole intervening change was the test mock; later changes are
regenerated API reporting and this receipt. Runtime and verifier sources remain
identical. All five relocated payload hashes were checked before and after
execution; the app payload SHA256 is
`cb3baf7dc79a290945f245dd5a88225eccd1f61c1109b4f993ebe1b0edd61657`.

The unchanged production binary ran without checkout or `node_modules` access.
It exercised canonical identity/help, refused service activation, config writes,
argument/stdin send, production inbox startup/shutdown, hosted streaming,
authentication refusal, detach/attach, cancellation, terminal failure, persisted
assistant history after restart, and shutdown while a stream was pending.
It made four model requests and produced two streamed deltas. Its 948 synthetic
judgment requests had 479 distinct identities; none occurred more than twice
across the two boots. Payload bytes stayed unchanged.

This is synthetic HTTP protocol, packaging and lifecycle evidence. It is not
live Jev semantic calibration or permission to activate a live account.

## Explicitly open or excluded

- The separate engine/model/config snapshot `17ba5413` is not integrated.
- The canonical card-owner replacement and daemon ingress per-retry policy/
  lifetime binding are not included. The current preflight and post-read policy
  checks remain; this batch does not claim the missing per-retry/log/result fence.
- Production browser assertions still need a supported hosted browser. Chromium
  launch failed with `socket(): Operation not permitted` before assertions in
  this executor, including the earlier approved retry. This is not a browser pass.
- Actual provider calibration, broader parity, supported-platform/service
  acceptance, full release validation and hosted CI for this new union remain
  separate. Full `validate`, all-workspace runtime tests and all-target release
  packaging were not run by this integration pass.
- This work was committed locally only. No branch push, PR, merge, deployment or
  publication was performed by this integration task.
