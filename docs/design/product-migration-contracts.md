# Product workspace contracts and gates

The four products are ports of the existing products. They retain their screens,
commands, styles and behavior. Their composition, input and rendering remain in
the product; shared platform behavior is hoisted into the engine. The later
per-file inventory rulings control: legacy migration modules carry forward,
and WRFC/permission views are adapted to the contract runner and gate rather
than discarded merely because an earlier scope paragraph called them DROP.

The later [autonomous Jev decision contract](autonomous-jev-decisions.md)
controls runtime semantics: retained views render Jev's `act`, `revise`, `defer`
and `reject` outcomes and the shared port's waiting/cancellation progress, with
no human approval or owner-escalation loop. Provisioning and login remain
legitimate interactions. Legacy callers must migrate with their engine/native
owners and evidence; preserving an inventory mapping does not complete that
migration. See the [current admission, grant/revocation and retry gaps](../../README.md#status).

## Project tracking

Source revisions, per-file dispositions, migration progress and acceptance
records are maintained in [Linear](https://linear.app/the-artificery/issue/TA-14/port-daemon-tui-agent-and-webui-with-preserved-parity) and its product-owner issues.
They are not inputs to workspace builds or checks. A source mapping or passing
structural gate does not prove behavioral parity or live-provider acceptance.

## Workspace boundary

Each real product lives in `products/<name>`, is named
`@goodvibes-jev/<name>`, and depends on `@goodvibes-jev/engine` through
`workspace:*`. Imports use the declared public engine exports, for example:

- `@pellux/goodvibes-sdk/platform/config` becomes
  `@goodvibes-jev/engine/sdk/platform/config`
- `@pellux/goodvibes-terminal-shell` becomes
  `@goodvibes-jev/engine/terminal-shell`
- `@pellux/goodvibes-daemon-sdk/remote-routes` becomes
  `@goodvibes-jev/engine/daemon-sdk/remote-routes`
- The same package-to-subpath mapping applies to contracts, errors, operator
  and peer clients, transports and toolchain

Legacy package dependencies/imports, undeclared engine subpaths and relative
imports crossing a product boundary fail validation. Historical names in prose
are not imports. A missing export is an explicit integration change, not a
reason to reach into the engine's source tree.

Every product supplies real `build`, `test` and `typecheck` scripts, an actual
source entrypoint, test sources and TypeScript configurations. Script references
must exist; empty-success commands and empty entrypoints fail. Every owned
TypeScript source/test/tooling file outside fixture data must belong to a
TypeScript project. The whole-tree type gate checks that coverage and compiles
each actual product TypeScript project once, including separate test and tooling
projects. It fails on compiler errors, including diagnostics printed with an
incorrect zero exit status. Product `typecheck` scripts remain available as local
convenience commands; the whole-tree gate does not repeat their aggregate and
child compiler invocations.

## Executable workspace checks

- `bun run products:check` verifies product packages, real source entrypoints,
  scripts, public imports, test presence and complete TypeScript project coverage.
- Root `build`, `test` and `typecheck` run their corresponding product checks.
  CI obtains its product test matrix from the same inspected workspaces.
- Source entrypoints are read from the existing package, build and HTML inputs;
  no migration manifest or project-status document is required.
- Build/test failures, child signals and TypeScript diagnostics fail the gate.
  Passing structural checks does not establish UI parity or live calibration;
  those require actual execution and review of the evidence in Linear.

Product test runners must preserve their existing per-file isolation and
local fixture behavior while adopting the shared test environment/network
guard. Live proofs remain separate, explicitly configured runs. No new live
provider call is implied by adding a product to the workspace.
