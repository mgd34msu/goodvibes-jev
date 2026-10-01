# PR57 persistence recovery evidence: UNMERGEABLE

This is backup data only. Do not merge this branch as implementation or apply its patches to main. The evidence commit changes only four files under `docs/review/recovery/pr57/`; runtime source is identical to public evidence parent `9363f44d186e152f5c829aa106d5645ce3ed02a0`.

The two patches reconstruct immutable local candidate `82458f6262384ef4b204b8543ed76bb266aa473c`, tree `a0248dc7cf0c66ef9638e93bf740c9da2e4ed8aa`, directly from public base `c70f79ecccca21a8a08400626c4f8f748fa2bd29`. The unpublished candidate commit is provenance only; reconstruction requires the public base and these patches. `source.patch` preserves the source/tests/documentation delta. `generated-api.patch` preserves the necessary API-report delta without duplicating its complete generated file. All 16 postimage hashes, patch hashes, and proof status are in `manifest.json`.

## Current proof and remaining gates

The exact candidate passed 114 focused tests / 1,111 assertions across 13 files, SDK/engine-test/public-consumer type checks, the unchanged aggregate API check, and its normal credential-only commit hook. A fresh isolated exact-tree credential-scope check also passed across 2,633 SDK files. The manifest retains existing API tooling warnings and hash-verified proof receipts.

Independent source review, shared-lock ownership reconciliation, current-main integration and composition checks, full repository/product CI on an authorized implementation head, and actual TUI caller/product acceptance remain outstanding. Shared source integration remains held for Buzz reconciliation. Focused and type/API passes do not establish full acceptance or merge readiness. The original recovery branch and remote implementation head remain unchanged.

## Reconstruct in a disposable index

After downloading both patches, run these commands from a repository that contains the public base. The index path must be a new, nonexistent path outside the working index:

```sh
sha256sum source.patch generated-api.patch
recovery_index=/absolute/path/to/new-pr57-recovery.index
GIT_INDEX_FILE="$recovery_index" git read-tree c70f79ecccca21a8a08400626c4f8f748fa2bd29
GIT_INDEX_FILE="$recovery_index" git apply --cached --check --binary source.patch
GIT_INDEX_FILE="$recovery_index" git apply --cached --binary source.patch
GIT_INDEX_FILE="$recovery_index" git apply --cached --check --binary generated-api.patch
GIT_INDEX_FILE="$recovery_index" git apply --cached --binary generated-api.patch
GIT_INDEX_FILE="$recovery_index" git write-tree
```

Compare patch hashes with `manifest.json`. The resulting tree must be exactly `a0248dc7cf0c66ef9638e93bf740c9da2e4ed8aa`. Those operations and all source hashes were independently checked before this evidence publication. Neither a local-only ancestor nor the local candidate commit is required. Cleanup remains with the designated owner.
