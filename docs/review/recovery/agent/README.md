# Ordinary Agent source checkpoint: UNMERGEABLE evidence

This branch preserves source-reconstruction data only. Do not merge it as implementation or apply it to main. Its evidence commit adds only four files under `docs/review/recovery/agent/`; runtime source remains identical to public main checkpoint `9363f44d186e152f5c829aa106d5645ce3ed02a0`.

The preserved candidate is local commit `4336fd37e8c2052ffb7233fd0ae9b0fab8d5ec46`, exact tree `ee3ced1a7d0325dc445abe867b18c44693093435`. It restores 1,650 tracked files from public `mgd34msu/goodvibes-agent` commit `f05fe636c120baa469037efe7d7391c3d9503635`, retargets imports, and adds the informational CLI boundary and workspace metadata. Its only paths outside `products/agent/` are 21 additive root lock lines.

## Proof and limitations

58 focused tests / 461 assertions across 6 files passed for the source/package informational CLI and ordinary CLI/theme/diff/markdown/terminal-size behavior. Actual informational source/package launchers exited successfully. The normal credential-only commit hook and a fresh isolated exact-tree SDK credential-scope check passed across 2,633 SDK files. These checks do not establish complete Agent product credential coverage.

The source typecheck failed with 146 diagnostics. Interactive startup and behavior, product build, binary packaging, end-to-end checks, and full migration acceptance are unverified. Independent review, full CI, and authorized runtime integration remain outstanding. This is incomplete source recovery, not a working-product or release claim. Full pinned upstream snapshots are referenced from their public Git tree rather than re-uploaded here.

## Exact reconstruction

Use a disposable clone or object repository containing both pinned public commits. For example, in a new scratch directory:

```sh
git clone --no-checkout https://github.com/mgd34msu/goodvibes-jev.git ordinary-agent-reconstruction
git -C ordinary-agent-reconstruction fetch --no-tags https://github.com/mgd34msu/goodvibes-agent.git f05fe636c120baa469037efe7d7391c3d9503635
python3 reconstruct.py --repo ordinary-agent-reconstruction --index /absolute/path/to/new-agent-recovery.index --patch residual.patch.gz
```

The index path must not already exist. The script uses immutable public tree objects, applies the five documented import renames, verifies each intermediate tree, checks the residual patch hashes, and writes a new disposable index. It does not check out files, update a branch, execute candidate code, or access a network. Its only writes are Git objects and the explicitly supplied index.

The printed final tree must equal `ee3ced1a7d0325dc445abe867b18c44693093435`. This exact script was run successfully before publication. `manifest.json` records source pins, tree hashes, residual postimage hashes, proof receipts and outstanding gates. Neither the unpublished candidate commit nor any local-only ancestor is needed. Cleanup remains with the designated owner.
