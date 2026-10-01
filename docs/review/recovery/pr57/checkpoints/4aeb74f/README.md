# PR57 repair on main checkpoint 4aeb74f: UNMERGEABLE evidence

This versioned packet preserves source-reconstruction data only. Do not merge it as implementation or apply its patches to main. The evidence commit adds only this directory; runtime source and the earlier isolated PR57 evidence remain unchanged.

The preserved source commit is `4aeb74ff8e45c69c6d45d4205daf7cd5b1ebd9a3`, tree `7391b3c7569415ff6c697e6a17918a52f1dca584`, with parents `82458f6262384ef4b204b8543ed76bb266aa473c` and public main checkpoint `9363f44d186e152f5c829aa106d5645ce3ed02a0`. All 15 previously reviewed source/test/documentation postimages are byte-identical to the isolated repair. The generated API report is the tested union with public main; its complete 8MB snapshot is not duplicated here.

Fresh 114 tests / 1,111 assertions across 13 files, SDK/engine-test/public-consumer types, the unchanged aggregate API check and the normal credential-only commit hook passed. A fresh isolated exact-tree credential-scope check passed across 2,635 SDK files. The author manifest also records source review without a finding, repeated focused proof and separate 2/22 real-process probes. Existing API tooling warnings are retained.

These source checks do not establish remote implementation publication, exact-head CI, actual TUI caller acceptance or final integration. The designated coordinator owns full Git-history publication and runtime integration; this backup does neither and does not execute the publication helper. The six original proof artifacts, including postimage-equality evidence, are retained byte-for-byte in deterministic `proof-logs.tar.gz`.

## Exact reconstruction from the public base

The unpublished source commit and its local repair parent are not needed. Use a new disposable index in a repository that contains public main9363:

```sh
gzip -dc source.patch.gz > source.patch
gzip -dc generated-api.patch.gz > generated-api.patch
sha256sum source.patch.gz source.patch generated-api.patch.gz generated-api.patch
recovery_index=/absolute/path/to/new-pr57-main-recovery.index
GIT_INDEX_FILE="$recovery_index" git read-tree 9363f44d186e152f5c829aa106d5645ce3ed02a0
GIT_INDEX_FILE="$recovery_index" git apply --cached --check --binary source.patch
GIT_INDEX_FILE="$recovery_index" git apply --cached --binary source.patch
GIT_INDEX_FILE="$recovery_index" git apply --cached --check --binary generated-api.patch
GIT_INDEX_FILE="$recovery_index" git apply --cached --binary generated-api.patch
GIT_INDEX_FILE="$recovery_index" git write-tree
```

Compare patch hashes with `publication-manifest.json`. The final tree must be `7391b3c7569415ff6c697e6a17918a52f1dca584`. Independent replay reproduced it and verified all 19 postimage hashes plus the 15-file review equality before publication. `source-manifest.json` is the unmodified author manifest. Cleanup remains with the designated owner.
