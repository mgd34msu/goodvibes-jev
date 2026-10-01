# Ordinary Agent adapter checkpoint 87bdf8a: UNMERGEABLE evidence

This versioned checkpoint preserves the 13-file ordinary Agent adapter delta as backup data. Do not merge it as implementation or apply it to main. Its evidence commit adds only this directory; runtime source and the earlier checkpoint artifacts are unchanged.

Local source commit `87bdf8a98a4d136bb0188337b940b53dcf9566ad`, tree `8ef56085dc5808e3545c8ac48aa4ad59c994da6e`, follows source commit `4336fd37e8c2052ffb7233fd0ae9b0fab8d5ec46`, tree `ee3ced1a7d0325dc445abe867b18c44693093435`. All 13 changed paths are inside `products/agent/`.

The exact later checkpoint passed 269 focused tests / 2,659 assertions across 18 ordinary CLI/render/configuration/store/profile files. Its source typecheck still failed with 108 diagnostics, and its bundle failed on removed interactive runtime exports. Interactive use, binary packaging, end-to-end behavior, full CI, and full migration acceptance remain unverified. Its normal credential-only hook and a fresh check of identical SDK scanner inputs passed across 2,633 SDK files; this is not complete Agent product credential coverage.

Those test counts belong only to this checkpoint. The earlier checkpoint remains separately preserved with 58 tests / 461 assertions and 146 type diagnostics. Neither checkpoint establishes a working product or release.

## Reconstruct the later tree

First follow the initial ordinary Agent reconstruction at evidence commit `00e028a01ee5b9aa90a53c7dd2ec1f666c69c430`, under `docs/review/recovery/agent/`. That script reconstructs the earlier tree from the two pinned public repository commits. Keep its resulting disposable index. No unpublished local commit is required.

Then, from the same disposable repository:

```sh
sha256sum adapter.patch
recovery_index=/absolute/path/to/the-prior-agent-recovery.index
GIT_INDEX_FILE="$recovery_index" git write-tree
GIT_INDEX_FILE="$recovery_index" git apply --cached --check --binary adapter.patch
GIT_INDEX_FILE="$recovery_index" git apply --cached --binary adapter.patch
GIT_INDEX_FILE="$recovery_index" git write-tree
```

Stop if the first tree is not `ee3ced1a7d0325dc445abe867b18c44693093435`. The final tree must be exactly `8ef56085dc5808e3545c8ac48aa4ad59c994da6e`. Patch SHA-256 is `6a680e0a832b1661ef0b1dcfbab04530f274a481059f642a862b203fd9f569d3`. Both patch checks and exact reconstruction were verified before publication. `manifest.json` records all postimage hashes, proof receipts and remaining gates. Cleanup remains with the designated owner.
