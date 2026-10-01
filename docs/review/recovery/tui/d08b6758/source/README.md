# Ordinary TUI source recovery checkpoint

This compact packet reconstructs commit d08b6758d0a5dfd633759f9168d71167a743f055, tree 4fc2e2773d198093849dc96154e9a3014d1bcac4, against public main 9363f44d186e152f5c829aa106d5645ce3ed02a0. It contains no shared runtime source or PR56 delta. No dependencies, user state or credentials are included.

Use the exact public TUI commit and public planning archive identified in manifest.json. Run reconstruct.py with --upstream-repository, --archive and a new --output path. The recipe verifies the archive hash and complete product contents/modes digest before writing output. The recipe uses only the archive overlay subtree; it never applies the archived engine-composition.patch. Copy the resulting products/tui into the public base and apply workspace-lock.patch. The ordinary-postimages.patch is for review; the recipe already applies its two exact postimages.

An independent temporary Git index reproduced the exact full source tree, including the lock, as recorded in exact-tree-proof.log. Five ignored public upstream files were present in the restored directory but not in this Git checkpoint; they are listed explicitly in manifest.json and excluded from this exact-tree recipe.

The guarded surface-kit, shell-surface and runtime-theme tests pass 79 tests / 550 assertions. Startup failed module loading on retired runtime service imports. Full types, app boot, binary/PTY and first-turn behavior are not accepted. The archive's previous planning runtime proof was against a separate held SDK contract; it is not a proof for this base. JEV/HOIST obligations remain open. The normal credential-scope commit hook passed before this source checkpoint. Subsequent working-tree edits are excluded.
