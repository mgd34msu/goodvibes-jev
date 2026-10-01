# Ordinary TUI checkpoint 25d3865b: UNMERGEABLE evidence

This versioned packet preserves a 61-file ordinary TUI product delta as backup data. Do not merge it as implementation or apply it to main. Its evidence commit adds only this directory; runtime source and earlier checkpoint artifacts remain unchanged.

The exact source checkpoint is `25d3865bbc17ceab7388e3d1ac12f8dc34b7069b`, tree `1b06d3c236b6549861a8aa893499edddda87067d`, over `d08b6758d0a5dfd633759f9168d71167a743f055`, tree `4fc2e2773d198093849dc96154e9a3014d1bcac4`. Every changed path is inside `products/tui/`.

350 component tests / 1,362 assertions across 23 files and the normal credential-only hook passed. These counts belong only to this checkpoint. Actual main startup, whole-product types, binary/PTY/first-turn behavior and full acceptance remain open. The earlier bounded type diagnostic occurred during source edits and is not a passing exact-checkpoint result. PR52 notification and PR57 planning-store dependencies remain held as recorded in the source manifest. JEV/HOIST and private workspace launcher/updater/build obligations remain open.

The earlier d08 packet retains its own 79/550 renderer proof and failed startup. Neither checkpoint is a working-product or release claim. The fresh SDK credential-scope check passed across 2,633 files, but does not establish full TUI product credential coverage.

## Exact reconstruction

First reconstruct d08 from the prior public-source recipe at evidence commit `f99a84a58b8f96a6d52583ba3ed6e8abb09f8ee6`, under `docs/review/recovery/tui/d08b6758/source/`. Keep its disposable Git index. The prior recipe retains the five ignored-upstream-file exclusions; no unpublished local commit is required.

Then run from that same disposable repository:

```sh
sha256sum source.patch.gz
gzip -dc source.patch.gz > source.patch
sha256sum source.patch
recovery_index=/absolute/path/to/the-prior-tui-recovery.index
GIT_INDEX_FILE="$recovery_index" git write-tree
GIT_INDEX_FILE="$recovery_index" git apply --cached --check --binary source.patch
GIT_INDEX_FILE="$recovery_index" git apply --cached --binary source.patch
GIT_INDEX_FILE="$recovery_index" git write-tree
```

Stop unless the starting tree is `4fc2e2773d198093849dc96154e9a3014d1bcac4`. The final tree must be `1b06d3c236b6549861a8aa893499edddda87067d`. Both patch hashes are in the unmodified `source-manifest.json`; independent exact-tree replay and all 61 postimage/deletion hashes were verified before publication. Both original proof logs are preserved. `publication-manifest.json` records the independent checks and remaining gates. Cleanup remains with the designated owner.
