# Daemon CLI contracts (partial migration)

This workspace contains the pinned daemon's real command vocabulary, parser,
help, shell completion and version helpers. It preserves the 20-command target
contract and delegates argument parsing to the shared engine terminal shell.

It is not a bootable daemon yet. There is no daemon binary entry or substitute
handler. Runtime composition, original catalog/provider integration tests and
remaining migration evidence are still required. The repository's strict
`migration:complete` gate must continue to reject this partial workspace.

From this directory:

- `bun run build` emits the actual CLI modules and declarations to `dist/`
- `bun run typecheck` checks source and tests
- `bun run test` runs the original CLI assertions through the guarded runner

The `@goodvibes-jev/daemon/cli` export exposes these contracts for composition.
The package is private during migration. Its initial version preserves the
pinned daemon package version, not a newly published release.

Source: `mgd34msu/goodvibes-daemon` at
`443e5ee4d6cda0d36d57e2886398d0836074a4a9`. Exact migrated paths are recorded in
`migration.json`; the full source inventory remains authoritative.
