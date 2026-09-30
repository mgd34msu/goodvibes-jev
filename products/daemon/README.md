# Daemon contracts (partial migration)

This workspace contains the pinned daemon's real command vocabulary, parser,
help, shell completion, version helpers and daemon configuration adapters. It preserves the 20-command target
contract and delegates argument parsing to the shared engine terminal shell.

It is not a bootable daemon yet. There is no daemon binary entry or substitute
handler. Runtime composition, original catalog/provider integration tests and
remaining migration evidence are still required. The repository's strict
`migration:complete` gate must continue to reject this partial workspace.

From this directory:

- `bun run build` emits the actual CLI modules and declarations to `dist/`
- `bun run typecheck` checks source and tests
- `bun run test` runs the original CLI assertions through the guarded runner

The `@goodvibes-jev/daemon/cli` export exposes the CLI contracts for composition.
Configuration adapters remain internal product modules and consume the public
engine config contract. They retain the historical `tui` storage root and
daemon-owned config migration; tests use only dummy values in isolated stores.
The package is private during migration. Its initial version preserves the
pinned daemon package version, not a newly published release.

Source: `mgd34msu/goodvibes-daemon` at
`443e5ee4d6cda0d36d57e2886398d0836074a4a9`. Exact migrated paths are recorded in
`migration.json`; the full source inventory remains authoritative.

The initial runtime adapters now compose credential/identity services and mail
dependencies and register every declared disposal owner. They do not start the
full runtime. Hosts must await the disposal scope's `close()` before transferring
ownership; `dispose()` only starts that cleanup for legacy callers.

Cluster adapters now wire the real group and coordinator with one signed
transport. Callers must await startup and shutdown, including return admission;
optional clock/transport seams permit deterministic tests without joining a LAN.
The actual inbox registration and complete server composition are still pending.
