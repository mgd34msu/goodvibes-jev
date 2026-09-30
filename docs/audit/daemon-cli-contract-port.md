# Partial daemon CLI contract port

Source: `mgd34msu/goodvibes-daemon` at `443e5ee4d6cda0d36d57e2886398d0836074a4a9`.

The actual first product workspace is `products/daemon`, privately named
`@goodvibes-jev/daemon` and preserving the pinned package version `1.28.25`.
Its `./cli` export contains the seven-file import closure of the original
`src/cli/index.ts`: command catalog, completion, help, barrel, parser, types
and version. The four original CLI suites retain their assertions. Imports
use only the public engine terminal-shell contract and platform Node APIs.
`migration.json` maps each exact source path. Original PORT rulings remain.

This is not a bootable daemon: there is no binary entry, replacement runtime,
substitute handler or successful boot claim. The full original daemon entry
closes over 117 local modules (61 PORT, 55 HOIST, 1 JEV), and importing it before
that closure is ready would conceal the missing work. The strict completion
gate must still reject unmapped daemon modules and the three absent products.
Previously hoisted engine modules still need final product mapping and wiring.

## Behavior preserved and deliberate identity correction

The 20-command vocabulary, aliases, flag arities, refusals, provider:model
registry-key grammar, passthrough arguments, platform service wording and
bash/zsh/fish completion scripts preserve upstream behavior. They are exact
program grammar rather than semantic classification, as the inventory ruled.
Completion generation does not install anything into the user's shell.

The pinned package manifest said `1.28.25`, but its baked version fallback was
`1.28.14`, and both identity guards expected the unscoped package name rather
than its actual scoped name. The port checks `@goodvibes-jev/daemon` and uses
`1.28.25` as its compiled fallback. New fixtures prove the actual workspace
version, a different version from a fixture with the correct identity, and
refusal to trust an unrelated package's version. The binary display name
remains `goodvibes-daemon`.

## Gates and evidence

- All 110 original CLI tests plus three identity regressions pass: 113 tests,
  968 assertions. The two identity regressions failed before the correction.
- Real product build emits JavaScript and declarations; both product configs
  and the source/test typecheck pass. Compiled Node and Bun public-export
  smoke checks are recorded separately before commit.
- Seven product-only hook regression cases failed on the original hook. The
  new trigger includes product source, tests, scripts, package/TypeScript
  configs and migration maps; nine hook tests pass with the engine and
  documentation-only cases retained. Gate implementations are unchanged.
- Tests use the existing guarded runner, isolated HOME and owned temporary
  directories. The version fixture exposed a stripped test-runner marker;
  that isolation regression is fixed separately, with the original real-run
  containment assertion rerun rather than dropped.
- Root product checks report one present, three pending. The strict migration
  gate exits nonzero for the real remaining source mappings/evidence.

No release, service installation, shell modification or live daemon/provider
call is part of this slice. Upstream release drift after the pinned snapshot
remains a separate reconciliation gate before final parity.
