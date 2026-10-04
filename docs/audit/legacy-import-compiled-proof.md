# Repeating the compiled legacy-import read proof

This manual Linux x64 probe exercises the **real compiled Agent and TUI**, their command registration, and the default operator SDK over HTTP. It uses only the checked-in synthetic preparation fixture and a local HTTP server. It does not call a live provider or perform an import.

## Prerequisites and build

Use a Linux x64 executor with Python 3.10+, Bun 1.3.14, Node, and the normal repository build prerequisites. From the repository root, install the locked workspace dependencies and build the binaries from the source under review:

```sh
bun install --frozen-lockfile
export NODE_OPTIONS=--max-old-space-size=4096
bun run build
bun run --cwd products/agent build:binary --target linux-x64
bun run --cwd products/tui build:linux-x64
```

Do not substitute an old downloaded binary when reviewing a changed source tree. In a shared executor, serialize these memory-intensive builds with your existing compiler lock. The Python proof itself starts one binary at a time and does not compile them.

The terminal renderer needs these pinned PyPI packages. A disposable virtual environment keeps them separate from your existing Python setup:

```sh
python3 -m venv /tmp/legacy-import-pty-venv
/tmp/legacy-import-pty-venv/bin/python -m pip install pyte==0.8.2 wcwidth==0.9.1
/tmp/legacy-import-pty-venv/bin/python packages/engine/scripts/legacy-import-compiled-pty.py
```

The runner resolves the repository relative to its own location. `--repo /absolute/repository` can instead select an existing checkout with its freshly built binaries; `--bun /absolute/path/to/bun` selects Bun if it is not on PATH. `--output /new/nonexistent/directory` chooses the artifact destination. The default is a fresh system temporary directory. Existing output directories are refused to prevent stale journals or logs from affecting a rerun.

No host-specific paths, generated logs, or real credentials are checked in. The fixture is generated at run time using `prepareLegacyWorkLedgerMigration` and `products/agent/src/test/fixtures/legacy-ledger/preparation.json` from the selected repository, so the response follows the actual source version being reviewed.

## Assertions

For each product, the runner sends a real terminal command and checks the rendered screen before asking the app to exit with Ctrl-C:

1. `/work-import status synthetic-project`: the no-saved-import message appears; no source page or preparation request occurs.
2. `/work-import preview synthetic-project`: the preview appears after exactly two source pages and one preparation request.
3. Revoked preview: the local host removes `read:knowledge` immediately after the first source page. The rendered authorization error appears, only one source page is read, and preparation is never called.

Every scenario must exit naturally with code 0 without the timeout fallback, authenticate to the synthetic host, make zero calls to the actual import endpoint, preserve the synthetic token bytes, and leave one owner-only `0600` import journal with zero saved commands. Any logged test-network violation fails the probe. A six-scenario success ends with:

```text
PASS: six compiled protected-read scenarios
```

The output contains `prepared.json`, `provenance.json` (selected source HEAD and binary SHA-256 values), `results.log`, and one directory per scenario. Each scenario keeps `terminal.raw`, `screen.txt`, `requests.json`, and `result.json` alongside its isolated synthetic home/workspace. Inspect these files when an assertion fails. A nonzero exit is a failure, even if some earlier scenarios passed. Terminal EOF is allowed a three-second process-cleanup grace period; it is not itself treated as a timeout.

## Safety and evidence boundary

The child products receive a fresh, allowlisted environment, isolated HOME/settings/caches, a dummy local provider, and the literal dummy token `synthetic-host-token`. Real provider keys and user configuration are not inherited. The HTTP server binds only to `127.0.0.1` on an ephemeral port. Unrelated product startup requests are rejected with 503; zero import calls does not mean zero total HTTP POSTs.

The workspace loads the repository's test-network guard through `bunfig.toml`. A clean violation log is supporting test evidence, not an OS network sandbox guarantee. Run in an isolated executor if a hard network boundary is required.

This proves the compiled protected-read route and response/revocation handling. It does not prove native autonomous dispatch, host evaluator/generation wiring, shared retry orchestration, a live migration, or hardware power-loss durability. The synthetic host is intentionally narrow and does not emulate the full production control plane.

## Review checkpoint

This proof was extracted from the six-scenario harness used for PR #105 source `7ff8a6d1e2dc63fd92d7c8d413165af09cea4a69` (tree `ab1cfaa6536c6bf0abb5b8aaf9201cbe2e393420`). The extraction changes only this guide and the manual Python harness. It adds repository-relative paths, fixture generation, fresh-output protection, and explicit provenance/timeout results without changing production code.

The reviewed checkpoint's binary hashes were:

- Agent: `1ed891a6aca8744e3bd6be9bd246a8bb37194779b8f1205ca685353cc8c28d27`
- TUI: `f7435450fba31befaf99d609f8a122f5e60e856226c05e9d2520d75f63621ad9`

Record the hashes from each independent rebuild rather than assuming that a different machine will emit byte-identical binaries.
