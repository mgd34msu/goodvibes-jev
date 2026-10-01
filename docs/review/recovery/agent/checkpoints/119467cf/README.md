# Ordinary Agent checkpoint 119467cf: UNMERGEABLE evidence

This versioned packet preserves a 21-file ordinary Agent contract-view/fleet delta as backup data. Do not merge it as implementation or apply it to main. Its evidence commit adds only this directory; runtime source and earlier checkpoint artifacts remain unchanged.

Source commit `119467cf5b60bd51232af3613d66ccc80933d42d`, tree `1bcc7514e310c0958890e47bce5c9ed65f9cd45d`, follows `74a344ad46bdd0eee004e1a121f1842c343378fa`, tree `5cd5cb06bdfa17593a4b1e746dc8ded14de70e0d`. Every changed path is inside `products/agent/`.

311 tests / 2,830 assertions across 26 component files and the normal credential-only hook passed. These results belong only to this checkpoint. Full type checking was queued at capture, and actual main remained blocked on the held notification seam. Full type/main/binary/interactive acceptance is not established. Later diagnostic reductions and private-update work are explicitly excluded from this snapshot and its proof.

The fresh SDK credential check passed across 2,633 files; this does not establish full Agent product credential coverage. All seven original proof receipts, including the exact test command and source-input record, are preserved byte-for-byte in deterministic `proof-logs.tar.gz`. Member hashes appear in `publication-manifest.json`. `source-manifest.json` preserves the author manifest. Dependencies and the local verification index are excluded.

## Exact reconstruction

First reconstruct 74a344ad through the prior evidence chain at `9186d97ab00a3db0a6f4b158b659630d494a0177`, under `docs/review/recovery/agent/checkpoints/74a344ad/`. Keep that disposable Git index. No unpublished source commit is required.

```sh
gzip -dc source.patch.gz > source.patch
sha256sum source.patch.gz source.patch
recovery_index=/absolute/path/to/the-prior-agent-recovery.index
GIT_INDEX_FILE="$recovery_index" git write-tree
GIT_INDEX_FILE="$recovery_index" git apply --cached --check --binary source.patch
GIT_INDEX_FILE="$recovery_index" git apply --cached --binary source.patch
GIT_INDEX_FILE="$recovery_index" git write-tree
```

Stop unless the starting tree is `5cd5cb06bdfa17593a4b1e746dc8ded14de70e0d`. The final tree must be `1bcc7514e310c0958890e47bce5c9ed65f9cd45d`. The raw patch is 95,164 bytes with SHA-256 `54727c11c350d13bf68c0723820047668bf552737ed6fdf7f0e951005fcaaec1`; compressed hash and all postimages are in `publication-manifest.json`. Independent replay reproduced the exact tree before publication. Earlier results remain separately preserved. Cleanup remains with the designated owner.
