# Ordinary Agent checkpoint 74a344ad: UNMERGEABLE evidence

This versioned packet preserves a 22-file ordinary Agent service-graph delta as backup data. Do not merge it as implementation or apply it to main. Its evidence commit adds only this directory; runtime source and earlier checkpoint artifacts remain unchanged.

Source commit `74a344ad46bdd0eee004e1a121f1842c343378fa`, tree `5cd5cb06bdfa17593a4b1e746dc8ded14de70e0d`, follows `87bdf8a98a4d136bb0188337b940b53dcf9566ad`, tree `8ef56085dc5808e3545c8ac48aa4ad59c994da6e`. Changes are confined to `products/agent/` and the root workspace lock.

281 focused tests / 2,723 assertions across 23 files passed for this checkpoint. The real offline graph/preset and service-entry-only bundle also passed, as did the normal credential-only hook. These checks do not establish whole-product main, binary or interactive acceptance. Main still fails on held notification exports and full source types still fail. Prompt/context parity and complete runtime acceptance remain open. The separate 1-test/12-assertion preset control is retained as a separate run, not added to the combined total.

A fresh SDK credential check passed across 2,633 files; this does not establish full Agent product credential coverage. All seven original proof receipts, including failed types and main bundle output, are preserved byte-for-byte in deterministic `proof-logs.tar.gz`. Member hashes appear in `publication-manifest.json`. The unmodified author manifest retains its original receipt hashes. Dependencies, built bundles and the local verification index are excluded.

## Exact reconstruction

First reconstruct 87bdf8a9 through the prior evidence chain at `26e8bf631c7b79ef75227d27ecc102ae812513a0`, under `docs/review/recovery/agent/checkpoints/87bdf8a/`. Keep that disposable Git index. No unpublished source commit is required.

```sh
gzip -dc source.patch.gz > source.patch
sha256sum source.patch.gz source.patch
recovery_index=/absolute/path/to/the-prior-agent-recovery.index
GIT_INDEX_FILE="$recovery_index" git write-tree
GIT_INDEX_FILE="$recovery_index" git apply --cached --check --binary source.patch
GIT_INDEX_FILE="$recovery_index" git apply --cached --binary source.patch
GIT_INDEX_FILE="$recovery_index" git write-tree
```

Stop unless the starting tree is `8ef56085dc5808e3545c8ac48aa4ad59c994da6e`. The final tree must be `5cd5cb06bdfa17593a4b1e746dc8ded14de70e0d`. The exact raw patch is 59,539 bytes with SHA-256 `7e55bac8b681f62e01d18663512db3d4f499ded1714f30f02d223e250b535d69`; compressed hash and all postimages are in `publication-manifest.json`. Independent replay reproduced the exact tree before publication. Earlier checkpoint results remain separately preserved. Cleanup remains with the designated owner.
