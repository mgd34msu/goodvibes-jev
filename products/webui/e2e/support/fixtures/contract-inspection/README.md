# Real contract inspection response captures

These ten JSON files are the complete GET/LIST response values exported by
`packages/engine/test/contract/inspection-schema.test.ts`. They are not the
hand-authored `contract-fixture.ts` mocks. The capture checkout baseline was
`96764055a25c2ab292aa772107013befe7972bc5` (`96764055`), with the accompanying
closed-inspection-schema prerequisite changes applied. They were captured on
2026-10-05. The original three pairs were copied unchanged from
`.tmp/contract-inspection-fixtures/`; the two partial-report pairs were copied
unchanged from `.tmp/contract-inspection-partial-fixtures/`.

## Exact capture command

Run from the monorepo root with the supported Bun version on PATH:

```sh
GOODVIBES_TEST_CONTRACT_INSPECTION_FIXTURE_DIR=$PWD/.tmp/contract-inspection-fixtures bun packages/engine/scripts/test.ts test/contract/inspection-schema.test.ts
```

The partial-report extension was captured with the same test after adding its
real parser/runner regressions, using this exact command:

```sh
GOODVIBES_TEST_CONTRACT_INSPECTION_FIXTURE_DIR=$PWD/.tmp/contract-inspection-partial-fixtures bun packages/engine/scripts/test.ts test/contract/inspection-schema.test.ts
```

Only the four `partial-*.json` outputs from that run were added. The original six
artifacts were not replaced by the second run's newly assigned IDs/timestamps.

The guarded engine runner owns test isolation and cleanup. The `GOODVIBES_TEST_`
prefix intentionally survives its environment isolation. Do not bypass the runner
with a raw engine `bun test`, or update these fixtures by simplifying a failing
response until it validates.

## What the capture proves

The engine test starts the actual contract runner, obtains its operator service,
registers the real contract gateway methods, invokes `DaemonControlPlaneHelper`,
and dispatches the actual daemon REST GET and LIST paths. The minimal test route
handler delegates to the real gateway helper and creates the `Response.json`
response. The exporter calls `response.json()`, compares the entire resulting
value to the runner record serialized through JSON, validates the complete
canonical output schema, then writes that value with two-space JSON formatting.
The files are exact copies of those exported artifacts; formatting is exporter
formatting, not a claim to preserve whitespace of the original HTTP body.

No field, timestamp, ID, path, decision, report, digest, or Unicode/whitespace in
a recorded string has been scrubbed or normalized. Temp paths identify the
isolated test workspace; they are provenance strings, not live locations to open.
The fixture does not claim use of a live model or network service: model answers
and executor output are scripted in the runner harness. Transport retry state is
produced by the actual shared judgment port's retry machinery after its injected
fetch returns HTTP 503, not by constructing a waiting record.

- `ordinary-completed-worktree`: the ordinary runner reaches `passed` in worktree
  isolation, with a real captured input snapshot, checks, output, answer, and the
  runner-parsed engineer `lastReport` retained on its unit.
- `native-durable-deferred-worktree`: durable start reaches plan-level semantic
  `defer`, with original native goal/criteria, decision history and pending receipt,
  judgment IDs, evidence references, binding, persisted launch claim, admission
  receipt, worktree placement, and captured input snapshot.
- `native-backoff-shared`: the real shared judgment port is in its 60,000 ms
  backoff after an unavailable HTTP 503 attempt. Progress remains `deciding`;
  decision history/pending are empty. No semantic defer is synthesized.

- `partial-engineer-report-worktree`: the real parser accepts and retains a
  partial engineer report without optional context/decision/issue arrays. Its
  28,018-character summary survives in `lastReport` although the saved `lastOutput`
  is capped at 12,036 characters. File claims remain verified; no fields are
  invented to make the report conform.
- `partial-researcher-report-worktree`: the real parser retains recognized
  cross-archetype file claims on a partial generic researcher report. The closed
  schema permits these known optional fields and still rejects wrong types and
  unrecognized fields.

Every LIST capture used `includeTerminal=true` and contains precisely the same
record as its paired GET. The browser helper overlays only `/api/contracts` read
routes on the existing hermetic mock daemon. It returns the captured raw JSON
strings unchanged. Ordinary passed records are absent for `includeTerminal=false`
via an empty list; the stored capture itself is never filtered or reconstructed.
Contract write routes are rejected and every attempted write is recorded.

## Consumer checks

`native-contract-records.ts` validates the complete canonical GET/LIST schemas
and the production hook's generated inspection schema before its single narrowing
cast to the generated `ContractRecord`. There are no hand-maintained wire types.

`src/views/work/ContractInspectionWire.test.tsx` passes the exact stored JSON bytes
through `Response`, the real `sdk.operator.contracts` facade, `useContracts`, and
`ContractDetail`. It checks full-value preservation (including `lastReport`, which
has no separate parsed-report UI), ordinary output/answer/capture, original native
text, defer receipts, admission, and real retry waiting. It also refreshes with
explicit malformed variants, requires rejection instead of stale rendered
proof, then restores the original bytes through Retry.

`e2e/native-contract-inspection.e2e.ts` exercises the production app for all five
captures in both existing phone (390×844) and desktop (1280×800) projects. It
opens the actual disclosures, verifies exact original source text and recorded
facts, separates retry waiting from semantic defer, checks read-only controls and
GET-only traffic, exercises strict Refresh/Retry recovery, checks horizontal
overflow, and attaches overview/evidence/provenance screenshots named by project.

Run the consumer tests using the guarded product runner:

```sh
bun packages/engine/scripts/test.ts --cwd ../../products/webui --isolate src/views/work/ContractInspectionWire.test.tsx e2e/support/native-contract-records.test.ts
```

Run the browser proof from `products/webui` on a browser-capable runner:

```sh
bunx playwright test e2e/native-contract-inspection.e2e.ts --project=phone --project=desktop --workers=1
```

The local executor's prior Chromium launch failed with `EPERM`; this change does
not claim a local browser pass or generated screenshots. CI must execute the
browser test and collect its attachments. A TypeScript check or Playwright test
listing is not browser evidence.

## SHA-256 of the unchanged capture files

```text
c5cea047c4fa733aa1f30b83ea82d7a62eb860d55f7aa7c9722909807162d0fd  native-backoff-shared-get.json
a8a52db1b9d3094ee857563f14d6a684acb2eda1562c027e82b9249b8679bfeb  native-backoff-shared-list.json
88f6169818e59d1bcfbbead696d13a0f527456d9a53738d17b1c71db82561b71  native-durable-deferred-worktree-get.json
eb244725245514d5c54c16329c834523ff35fc47da09b7665730af6db8041d01  native-durable-deferred-worktree-list.json
905125d5f732b8649b160196b012e54503479b09f4d58ff1be3241221bbfc81e  ordinary-completed-worktree-get.json
7fc11e99500e76a3ecee467f6d9dcc85f2073c3102f0f8d656b2b01829cda34a  ordinary-completed-worktree-list.json
7f7afce9a4c9206a7d8c524b03b3c315f478b839e8dd128fbd58fcd0a1cdc36c  partial-engineer-report-worktree-get.json
d8ff84bf92e43ea56b92b34c4e69c0640c8713b5d31eaa00e9e9166c47509373  partial-engineer-report-worktree-list.json
85b245bc9b94a9fd1d265b48dd4a85637959529e1a6ab835be6a77a239c61af5  partial-researcher-report-worktree-get.json
3d0a05927cab3408dc9a819c664eea2ed5f06653f0826cf6ef0e8aac3354d90b  partial-researcher-report-worktree-list.json
```
