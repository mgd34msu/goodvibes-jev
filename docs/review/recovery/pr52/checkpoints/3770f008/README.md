# PR52 notification repair 3770f008: UNMERGEABLE evidence

This packet preserves source-reconstruction data only. Do not merge it as implementation or apply its patch to main. The evidence commit adds only `docs/review/recovery/pr52/checkpoints/3770f008/`; runtime source is identical to public main checkpoint `9363f44d186e152f5c829aa106d5645ce3ed02a0`.

The validated source commit is `3770f00807c56524c3eaa7632f9aae1a8a032ab2`, tree `8cb708a656e7ef57da978d5a9e6a033c9e6576ed`, with actual ordered parents public repair `f76dd159c5a20401d463635fedf11d66075434f7` and public main9363. The earlier substitute checkpoint mentioned in the author manifest is not used for reconstruction or ancestry. All five reviewed repair postimages match the public repair blobs exactly.

168 tests / 719 assertions across 13 files, root build, forced solution/tests/scripts/public-consumer/present-product types, API union/check, unchanged hook and diff checks passed. The type log explicitly lists daemon/web UI as present and TUI/Agent as pending; those pending products are not accepted by this result. Fresh exact-tree credential scope passes 2,637 SDK files.

Full implementation-history publication, exact-head CI, final release guard and authorized integration remain separate gates. The designated coordinator owns those actions. This backup does not execute the publication helper or upload the 8MB generated API or 2.5MB inventory snapshot. Eight original gate logs remain byte-for-byte in `proof-logs.tar.gz`. `source-manifest.json` preserves original manifest bytes; `source-SHA256SUMS` preserves the original packet checksum index. Its publication helper entry is metadata only and that helper is not included.

## Exact reconstruction from public main

Neither the unpublished merge commit nor any local-only ancestor is required. In a disposable repository that contains public main9363, choose a new index path:

```sh
gzip -dc changes-from-main.patch.gz > changes-from-main.patch
sha256sum changes-from-main.patch.gz changes-from-main.patch
recovery_index=/absolute/path/to/new-pr52-recovery.index
GIT_INDEX_FILE="$recovery_index" git read-tree 9363f44d186e152f5c829aa106d5645ce3ed02a0
GIT_INDEX_FILE="$recovery_index" git apply --cached --check --binary changes-from-main.patch
GIT_INDEX_FILE="$recovery_index" git apply --cached --binary changes-from-main.patch
GIT_INDEX_FILE="$recovery_index" git write-tree
```

The final tree must be `8cb708a656e7ef57da978d5a9e6a033c9e6576ed`. The exact raw patch is 191,627 bytes with SHA-256 `af06c8c43566049e0be65363e4d0733a8f9342db2252743426a3c3e78fdc393f`. Compressed hash, all 15 postimage hashes and independent checks appear in `publication-manifest.json`. Replay and reviewed-postimage equality were verified before publication. Cleanup remains with the designated owner.
