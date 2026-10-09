# WebUI semantic caller integration, 2026-10-09

This is an integrated source and synthetic-runtime follow-on to the
[f0d7d07 source-accounting checkpoint](webui-source-accounting.md). That
checkpoint's 666 original-path mappings, 62 semantic dispositions, 209 retained
PORT test files, seven authorized DROP rationales, and historical receipts are
preserved as historical facts. They are not new runtime or calibration proof.
The overall WebUI migration remains partial.

## Implemented together

- PWA installation fallback now consumes `webui.pwa.install-platform`. Native
  standalone state, `appinstalled`, and captured `beforeinstallprompt` remain
  authoritative. Uncertain/unavailable readings do not manufacture instructions.
- Untagged or unsupported fenced code uses `webui.code.language`. Browser
  requests contain canonical session/message identity, exact fence offsets and
  a full-message digest, not code. The daemon screens the complete original
  canonical message before hashing or extracting a block. Unsupported sources,
  partial/streaming messages and expired readings remain escaped plaintext.
  Declared registered highlight.js grammars/aliases remain mechanical.
- Credential highlighting reuses the engine's exact provider key declarations.
  Only unknown/custom stored names reach `webui.credentials.provider-key`;
  canonical inventory and admin authorization are rechecked. No credential
  value is available to the reader. Azure/OpenAI substring alignment is removed.
- Settings reuse canonical `SECRET_BEARING_CONFIG_PATHS`; unknown config rows
  start masked, including numeric and object values. The source-owned
  `webui.config.credential-key` adapter reuses `config.credential-key@2` with
  canonical key names/descriptions only. Only current, explicit acted negatives
  can clear an unknown row; held/error/malformed/late responses cannot. Declared
  secrets remain masked, including malformed objects beneath a declared secret
  path. Configuration incarnation and client/query lifetimes revoke pending
  decisions. This interpretation grants no config read/write permission.
- Vite discovery uses the daemon's versioned `--help --json` capability catalog
  and only its declared read-only status JSON invocation. Machine status does
  not initialize settings, migrate files, start a runtime, or acquire
  credentials. Existing settings/terminal fallbacks remain bounded and reject
  malformed, oversized and hung output instead of parsing help prose.
- Memory-review fixtures take explicit canonical `needs_review` probabilities
  and retain every candidate until ranking/limiting. Missing/invalid readings
  fail the fixture closed, including candidates beyond the requested limit.
  Prompt recall-floor policy remains unchanged.

## Boundaries and remaining ownership

The common browser service still owns source grants, principal/method identity,
route revision, cancellation, input screening, evidence logging, closed output
validation and provider budgets. New language/platform choices have complete
registered calibration fixture vocabulary, not fabricated live calibration
results. No live Jev request or real credential/card processing was performed.

This batch does not claim shared model-family/provider-alias or speech-seam
completion; those remain with their existing owners. It does not replace daemon
runtime/serving ownership or resolve legacy Fleet display equivalence. P01–P11,
F01–F05, genuine semantic calibration and final-main acceptance remain separate.

## Local qualification

All tests use synthetic source data/ports, not live credentials or Jev calls.

- Browser judgment engine/runtime suite: 306 passed across 17 files.
- Affected daemon CLI/status/composition suite: 50 passed across three files.
- Complete WebUI `src` plus memory-review fixture suite: 2,923 passed across
  221 files, using the owned runner with isolation.
- WebUI scripts excluding packaging: 116 passed across ten files.
- Exact packaging test: six passed on this source and six passed on unchanged
  `f0d7d07` baseline through the same owned isolated runner. Its source and test
  files are byte-identical. One earlier combined all-tests invocation stalled
  there and was stopped by the unchanged 181-second observed/180-second
  configured stall ceiling. This is a historical inconclusive combined-run
  failure, not a demonstrated packaging defect or capability blocker. Hosted
  full-job CI remains the final aggregate receipt.
- Forced engine solution/test/type-test checks and WebUI source/scripts/e2e
  projects passed; final source changes passed incremental engine/test, WebUI
  source and daemon typechecks. Coverage includes 678 WebUI TypeScript files.
- Production WebUI build, changed-file lint (zero errors; 13 warnings), contract
  artifacts, generated API documentation, judgment fixture coverage, zero-any,
  and credential-scope checks passed. API and subpath reports were refreshed.

## Browser qualification limit

The production WebUI build succeeded, and
`products/webui/e2e/semantic-browser-callers.e2e.ts` contains six meaningful
production-browser assertions (provider names/highlighting, stale provider
selection, native installation-state precedence, and memory review transport).
Chromium could not launch in this executor, before any assertion ran:

    FATAL:chrome/browser/process_singleton_posix.cc:297
    Check failed: . socket() failed: Operation not permitted (1)

The approved escalated execution encountered the same restriction. This is not
a browser pass. The scenarios must run on the exact integrated commit in a
supported CI browser environment. Synthetic ports and React DOM tests do not
substitute for this result or for live semantic calibration.
