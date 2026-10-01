# Agent source recovery

This is an incomplete workspace reconstruction from goodvibes-agent
`f05fe636c120baa469037efe7d7391c3d9503635` (tree
`7f5575e17a8f52f638b145830f9a4fc4e4bf650f`, 1,650 tracked files).
It is private and is not ready for product publication or interactive use.

The source references the monorepo's public engine, terminal-shell, toolchain
and daemon packages. The root workspace lock is authoritative. The upstream
standalone scripts, release records and lock remain retained source material;
they are not an accepted Jev release or installation contract. Standalone
release and publication scripts are not exposed by this workspace's manifest.

The source and package launchers support help, version, completion and parser
errors through the original parser and help renderer before loading the
interactive graph. The interactive implementation remains in `src/interactive.ts`.
This early command boundary does not establish interactive runtime compatibility.
The obsolete unused clipboard export is removed, and the store now uses the
public engine factories. Full bundling stops at the retired WRFC construction in
`src/runtime/services.ts`. Further runtime and semantic migration remains unfinished.

Fresh local evidence for the ordinary adapter checkpoint: 269 CLI, renderer,
profile and store tests, with 2,659 assertions. This includes source/package launcher subprocesses and theme,
diff, markdown-width and terminal-size behavior. The corrected source diagnostic has 108 errors, down from 146 at initial
materialization. The ordinary rendering/configuration fixes remove their own
diagnostics and consume the SDK source declarations. Full product compilation,
interactive startup, binary packaging and end-to-end acceptance have not passed.

No captured-input authority proposal or unpublished shared engine overlay is
part of this source recovery. The engine base is published main
`9363f44d186e152f5c829aa106d5645ce3ed02a0`.
