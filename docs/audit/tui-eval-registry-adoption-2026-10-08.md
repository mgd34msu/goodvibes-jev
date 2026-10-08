# TUI canonical eval registry adoption

This bounded follow-up addresses row 1 (`src/panels/eval-registry.ts`, HOIST)
of `tui-retained-rename-review-2026-10-02.json`, against main
`dfe395031e14542ac21d35fb89336886fbdacffd`. The original inventory requires the
engine observe subsystem to own latest suite/gate results, running state, last
run time, and subscription notifications. Suite-name equality is exact identity
bookkeeping, with no judgment or lexical fallback.

## Ownership and live composition

- The old TUI view path is a compatibility re-export of public
  `@goodvibes-jev/engine/sdk/platform/observe` / `EvalRegistry`, with no local
  implementation or subclass.
- Command context and `/eval` handler types use that public owner directly.
- Production `createBootstrapCommandExtensionsSection` constructs one canonical
  registry per command context. The prior factory never supplied the optional
  registry, so live `/eval run` could print results without retaining them for
  `/eval compare`. The new registry survives across commands within its context;
  another context receives independent state.
- Engine implementation, exports, public signatures and browser boundaries are
  unchanged. No provider, configuration, mail or scoring behavior is changed.

## Behavioral proof

`products/tui/src/test/input/eval-command.test.ts` exercises the real composition
factory and real built-in eval runner, without mocking modules or calling live
providers. It proves constructor identity, per-context isolation, retained state
consumed by the next command, replace-versus-append for suite and gate results,
injectable last-run time, running transitions, notification counts,
unsubscription, baseline persistence and comparison. Existing flag parsing
checks remain. Fixture-based built-in scenarios prove integration, not live
provider performance or broad TUI acceptance.

Canonical owner and runner coverage remains in
`packages/engine/test/observe-hoists.test.ts`,
`packages/engine/test/runtime-eval-runner.test.ts` and
`packages/engine/test/platform-eval-smoke.test.ts`.

This is implementation evidence for the single adoption obligation. Historical
retained-rename audit hashes, statuses, original pins and aggregate accounting are
preserved; this does not declare all THE62/TUI migration obligations complete.

## Local verification

- TUI eval command tests: 6 passed, 39 assertions.
- Engine observe owner and eval runner tests: 29 passed, 103 assertions.
- Adjacent bootstrap command tests (reasoning-effort ratchet and masked local-auth
  entry routing): 21 passed, 71 assertions.
- Engine build, exact public API check (175 SDK subpaths / 10,414 exports and
  4 terminal-shell subpaths / 212 exports), browser-neutral entry check: passed.
- TUI production and test TypeScript checks: passed with a 4 GiB Node heap. The
  initial default 2 GiB heap attempt exhausted memory before reporting a type
  error; the increased-heap rerun completed successfully.
- TUI linux-x64 build and compiled version-banner smoke: passed.
- Product-workspace, credential-scope, test-temp architecture, judgment lint and
  TUI architecture checks, plus whitespace validation: passed.

These are focused local checks, not a full product suite or hosted CI receipt.
