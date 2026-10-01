# Ordinary TUI source checkpoint d08b6758: UNMERGEABLE evidence

This branch preserves source-reconstruction data only. Do not merge it as implementation or apply its patches to main. The evidence commit changes only `docs/review/recovery/tui/d08b6758/`; runtime source is identical to public main checkpoint `9363f44d186e152f5c829aa106d5645ce3ed02a0`.

The preserved local source commit is `d08b6758d0a5dfd633759f9168d71167a743f055`, exact tree `4fc2e2773d198093849dc96154e9a3014d1bcac4`. Its compact recipe uses the pinned public TUI repository and verified public planning archive. Only the archive's product overlay is consumed; its shared engine patch is excluded. The reconstruction was independently rerun and every one of the 1,574 tracked product postimages and Git modes matched. Adding the workspace lock patch reproduced the exact full candidate tree.

Five ignored upstream files present in the original materialized directory were absent from this Git checkpoint. They remain explicitly listed and excluded by the recipe. Upstream's standalone lock and generated TypeScript cache are separate omissions. This distinction is preserved in the unmodified source packet.

79 renderer tests / 550 assertions passed for guarded surface-kit, shell-surface and runtime-theme behavior. Startup failed module loading on a retired runtime service import. Types were not run for this checkpoint; binary/PTY/first-turn behavior and full migration acceptance are not established. JEV/HOIST obligations and the separately held planning-store contract integration remain open. The normal credential-only hook and fresh SDK credential check passed across 2,633 files; this is not complete TUI product credential coverage.

## Packet and reproduction

`source/` contains the nine original recipe/manifest/patch/proof files plus their hash index. The local verification index is deliberately excluded. Follow `source/README.md` to obtain the exact public inputs and run `source/reconstruct.py`. Apply only the listed product files and `source/workspace-lock.patch` to a disposable index over the pinned public main base. `source/ordinary-postimages.patch` is review material; the recipe already installs its two exact postimages.

`publication-manifest.json` records the independent reproduction, public Git-tree and archive hashes, scoped proof, omitted files, credential preflight, and outstanding gates. The candidate's unpublished local commit is not required to reconstruct it. Subsequent source edits and tests are excluded. Cleanup remains with the designated owner.
