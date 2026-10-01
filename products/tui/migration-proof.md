# TUI recovery checkpoint

This product is being reconstructed from immutable upstream
`ec057c33979839be84a1d8d2399f9c69f0c2a5aa` and the public planning runtime
archive at `a17c7cc6c3de2e057c4910865c020d6bfae377a2`. The workspace base is
`9363f44d186e152f5c829aa106d5645ce3ed02a0`. Source materialization is not a
completed port or a runnable-product claim.

The recovery verified 1,526 unchanged upstream paths and all 52 archived
overlay paths, with 1,578 total files and no missing or unexpected files.
Upstream's standalone lock and generated TypeScript build cache were omitted.
The workspace lock contains the archived 22-line additive TUI entry, alias and
Fuse resolution; existing resolutions and the root package manifest are unchanged.
Dependencies were installed in this worktree with the frozen lock and scripts
disabled.

The ordinary package-name adaptation touches 676 files. Every resulting engine
module specifier has a declared public export; this does not establish that every
imported symbol or caller is migrated. The product store now uses the public Jev
store and domain dispatch, matching the recovered RuntimeState alias.

The first guarded rendering run passes 79 tests / 550 assertions for the modal
surface kit, composer/status surface and runtime theme switching. The same run's
startup suite failed while loading the old local store. After moving to the public
store, startup reaches the still-unported WRFC service composition and fails on
`createFixWorkstreamRunner`. Full source/test types, app startup, compiled binary,
PTY and first-turn proof remain outstanding.

The original inventory and its JEV/HOIST obligations remain in force. In
particular, runtime composition, the work/contract tree and controls, notice
ownership and severity, external tool presentation, terminal capability readings,
provider health, memory review/consolidation, session titles and private workspace
launcher/update/build behavior need their actual adapters and tests. Retired WRFC
or QEMU functionality is not a substitute for those implementations. Old standalone
release and arbitrary source-size/wording/filler checks are not acceptance gates.

The recovered planning closure depends on the public PR57 generation contract,
which is not in this workspace's main base. Its corrected isolated SDK candidate
is preserved separately at `82458f6262384ef4b204b8543ed76bb266aa473c`; shared
integration and caller acceptance remain held. Captured-input behavior dependent
on the separately held PR56 work is outside this reconstruction checkpoint.
