# Ordinary TUI checkpoint f526a8c8: UNMERGEABLE evidence

This versioned packet preserves a 42-file ordinary TUI product delta as backup data. Do not merge it as implementation or apply it to main. Its evidence commit adds only this directory; runtime source and earlier checkpoint artifacts remain unchanged.

Source commit `f526a8c824ec523186bfdbae997366778f6c115d`, tree `6d77d255a69a3a4ef1b9e291ae24761eaac21e9c`, follows `25d3865bbc17ceab7388e3d1ac12f8dc34b7069b`, tree `1b06d3c236b6549861a8aa893499edddda87067d`. Every changed path is inside `products/tui/`.

160 changed-component tests / 617 assertions across 15 files and the normal credential-only hook passed. These results belong only to this checkpoint. Source types still failed with 109 reported diagnostic lines; corrected test types still failed with 260 lines. The initial 391-line test diagnostic is preserved too. Main launch, build, binary/PTY/first-turn and complete product acceptance remain open, along with PR52/PR57 dependency reconciliation and remaining JEV/HOIST work. Passing focused adapters do not clear those gates.

The fresh SDK credential-scope check passed across 2,633 files, but does not establish full TUI product credential coverage. The five original passing/failing proof logs are preserved byte-for-byte inside deterministic `proof-logs.tar.gz`; member hashes are in the unchanged `source-manifest.json` and the independent `publication-manifest.json`. The local verification index and dependencies are excluded.

## Exact reconstruction

First reconstruct 25d3865b through the prior evidence chain at `05ae5c5adc481f379396eb28bedb15e913deb1e2`, under `docs/review/recovery/tui/checkpoints/25d3865b/`. Keep that disposable Git index. No unpublished source commit is required.

```sh
gzip -dc source.patch.gz > source.patch
sha256sum source.patch.gz source.patch
recovery_index=/absolute/path/to/the-prior-tui-recovery.index
GIT_INDEX_FILE="$recovery_index" git write-tree
GIT_INDEX_FILE="$recovery_index" git apply --cached --check --binary source.patch
GIT_INDEX_FILE="$recovery_index" git apply --cached --binary source.patch
GIT_INDEX_FILE="$recovery_index" git write-tree
```

Stop unless the starting tree is `1b06d3c236b6549861a8aa893499edddda87067d`. The final tree must be `6d77d255a69a3a4ef1b9e291ae24761eaac21e9c`. Compare both patch hashes with `source-manifest.json`. Independent replay reproduced that exact tree and verified all 42 postimage/deletion hashes before publication. Earlier checkpoint results remain separately preserved. Cleanup remains with the designated owner.
