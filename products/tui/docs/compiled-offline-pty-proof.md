# Portable compiled strict-offline PTY proof

This is the source handoff of PR #73's successful compiled first-turn proof.
It drives a **verified, already-built Linux x64 artifact**, without tmux, a GUI,
a rebuild, or a live model/judgment service. Use it to establish the same baseline
before extending PR #83 coverage; it does not itself exercise ledger commands.

## Inputs and dependencies

- A checkout containing this harness and its existing workspace dependencies
  from `bun.lock`. No dependency or lockfile change is needed. Bun's source
  conditions resolve the existing engine/judgment workspace modules.
- Linux x64 and **Bun 1.3.14** on `PATH`.
- `python3` on `PATH`, with only its standard library (including POSIX `pty`,
  `fcntl`, `termios`). No pip dependencies, tmux or desktop session.
- An extracted, trusted TUI CI artifact directory containing
  `dist/ci-artifact.json`, `dist/goodvibes-linux-x64`, and
  `dist/lib/sqlite-vec-linux-x64/vec0.so`. Preserve executable/file modes.
- Independently verified expected source commit, source tree, PR head commit,
  and binary SHA256. Obtain these from the selected build/review receipts;
  copying expected values from an untrusted download's manifest is not a
  provenance check. Verification establishes agreement with these supplied
  expectations, not the origin's authenticity.

The three executable harness files are
`scripts/compiled-offline-pty/{verify.ts,drive.py,replay.py}`.
`verify.ts` is a repository-level integration tool because it deliberately uses
both products’ fixtures. The TUI test TypeScript project explicitly includes
`../../scripts/compiled-offline-pty/**/*.ts`; the product-boundary checker and
existing fixtures are unchanged. Python is checked separately below.

## Run from the repository root

Choose an artifact root and a **new, nonexistent evidence directory whose
parent already exists**. Relative paths are resolved from the current directory.
Never place evidence over the artifact or an earlier proof.

```sh
bun scripts/compiled-offline-pty/verify.ts \
  --artifact-root ./restored/products/tui \
  --evidence ./.tmp/offline-pty-run-1 \
  --source-commit "$EXPECTED_SOURCE_COMMIT" \
  --source-tree "$EXPECTED_SOURCE_TREE" \
  --head-commit "$EXPECTED_HEAD_COMMIT" \
  --binary-sha256 "$EXPECTED_BINARY_SHA256"
```

Create the parent with `mkdir -p .tmp` if using this example. In shared
qualification environments, hold that environment's canonical
`engine-heavy.lock` around the command and yield to an existing qualification.
No lock filename outside the local checkout is assumed by this package.

The original hosted PR #73 baseline was:

```sh
EXPECTED_SOURCE_COMMIT=9ebb3989021461e08a4b5e47602726f230d06255
EXPECTED_SOURCE_TREE=659aa3c7c8a79e0a88af7b340cdf3b871044fb41
EXPECTED_HEAD_COMMIT=bb07b6ac190918dc1d3e5008fd68e8ac18cfc18e
EXPECTED_BINARY_SHA256=133275697221cef2d22e2402ed92736c0b2c1bba8f14c2a67384121ffc2529f3
```

Those values describe that original artifact only. Its source tree equals main
`1a507fda5f1742ba97b08ddfb87dec3414028053`'s tree, but its source commit is the
hosted checkout above. Do not relabel it as main or a PR #83 artifact. For a new
PR #83 binary, supply that build's exact source/tree/head/hash and retain its
build receipt; this harness source can differ from the source of the tested
binary. No runtime artifact is checked into this package.

## What must pass

Before executing the artifact, the existing `verifyTuiCiArtifact` checks both
payload files, modes, sizes and hashes against the explicit expected
source/tree/head. The additional expected binary SHA256 must also match. The unchanged
`scanArtifactForEagerNamespaceReads` must return no findings before execution.

The unchanged TUI metadata seeders and Agent strict judgment fixture run in an
isolated owned home. The fixture accepts only exact captured synthetic judgments;
known background probes remain rejected. Dummy fixture keys are not credentials.
The existing parent network guard and compiled Bun preload remain strict,
including caught violations. The air-gapped wake-download policy comes from the
existing `isolatedEnv`; there is no broad network allowance or retry bypass.
This is application-level guard evidence, not an OS network-namespace sandbox.

The Python driver opens a 40-row, 120-column PTY, sends the exact fixture prompt
at 10 seconds, sends `/quit` at 25 seconds, and requires normal exit before the
45-second deadline. A forced termination never counts as a pass. Receipt
preload PID and executable must equal the launched compiled process. The gate
also requires exactly one model request; exactly the four expected accepted
judgment kinds (identity, turn, route, tier); no unexpected judgment or network
violation; empty stderr; and the exact reply `The marmot answer is forty-two.` in reconstructed
visible cells. Unknown screen commands fail instead of silently approximating
the screen. Raw ANSI stripping alone is insufficient because the renderer
positions spaces using cursor movements.

## Evidence and ownership

The command exits zero only when the combined `screen-verification.json` passes.
Other receipts include `provenance.json`, `result.json`, `terminal-exit.json`,
`preload-receipt.json`, raw terminal bytes, reconstructed screen, stderr, and the
compiled network-violation log. The binary is hashed again after execution.

All scratch is under the newly created evidence directory's `scratch/`; normal
completion and exceptions remove only that owned subdirectory. No anonymous
system temporary directories are created. If forcibly killed, the explicitly
selected evidence directory owns any remaining scratch, which the operator can
inspect/remove. Existing evidence directories are refused, never overwritten.
Fixture/result receipts may contain machine paths and synthetic request bodies;
keep generated evidence local or review/redact it before sharing. Publish only
source/docs through the feature branch, never private machine paths or runtime
output. Original proof evidence stays immutable.

Recheck already captured evidence without relaunching the artifact:

```sh
python3 scripts/compiled-offline-pty/replay.py ./.tmp/offline-pty-run-1
```

## Focused checks

```sh
python3 scripts/compiled-offline-pty/test_proof.py
python3 -m py_compile scripts/compiled-offline-pty/*.py
bun run --cwd products/tui typecheck:test
bun run --cwd products/tui architecture:check
bun run products:check
bun run architecture:check
bun run credential-scope:check
```

The Python tests exercise cursor-positioned spaces, erased replies, unknown
screen mutations, same-PID/executable proof, guards, judgment drift, request
counts, empty stderr, normal exit, timing, dimensions, and changed
binary/provenance failure.
Cancellation also verifies the driver reaps its owned compiled process.
They use owned `.tmp/` scratch and clean each test. A successful replay test is
not a compiled-runtime pass: run the full command on the selected artifact.
