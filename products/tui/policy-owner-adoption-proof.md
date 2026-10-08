# Live TUI policy owner adoption

This closes the bounded `/policy` caller-adoption obligation in the original
THE-62 inventory rows for `src/input/commands/policy.ts` and
`src/input/commands/policy-dispatch.ts`. It does not establish completion of the
remaining TUI inventory, autonomous tool admission, or project-wide acceptance.

## Ownership and contracts

- The registered `/policy` and `/pol` handler calls public
  `@goodvibes-jev/engine/sdk/platform/gate/policy.runPolicyCommand`.
- The former 384-line product dispatcher is now a surface-service adapter and a
  compatibility forwarding function. Subcommand grammar, aliases, parsing,
  bundle lifecycle, simulation, lint, preflight, promotion, rollback, status,
  and trend recording have one engine owner.
- Services remain lazy: opening the TUI policy modal or displaying usage requires
  no policy state, path, config, or MCP access. The actual `openPolicyView`
  callback stays in the TUI. The registration retains its modal-specific text.
- Config reads use `configManager.getAll()` at invocation time. The bootstrap's
  `platform.config` is a cloned startup snapshot. Both the simulator and the
  dashboard receive the current `permissions.divergenceThreshold`, including
  zero; the default remains 0.05.
- The optional product registry override and working-directory error are
  preserved. MCP preflight receives the existing security records through the
  engine's narrow context. Public engine context types and signatures do not
  change.
- Existing TUI safety repairs now reside in the canonical engine owner:
  successful load/promote/rollback mutations are announced and notified before
  lint refresh; a refresh failure is reported separately rather than misreported
  as a failed mutation. Late simulation results are fenced by active bundle and
  dashboard identity. Late lint/preflight results are fenced by bundle identity.
  Preflight retains the canonical owner’s lint-cache refresh contract; the cache
  itself is published only while its current/candidate bundle identities still
  match, so a stale refresh cannot overwrite newer findings.
- Awaited reader errors, including reader cancellation, continue to reject
  without recording a successful simulation or preflight result. Clearing or
  replacing a simulation dashboard prevents a delayed result from restoring it.
  This migration does not add a new cancellation API.
- The existing explicit `--force` grammar and warning are preserved. No new
  approval prompt, human semantic decision loop, execution authority, provider,
  title, scheduler, credential, or network behavior is introduced.

## Test-first evidence

The base is the reviewed PR #203 source tree `5f3349b581728698c6588245044c47f3ba696a5f`
(remote head `be38c78e5609b43b76adaaf1baa85f43a141bd7d`). All reading results use
synthetic judgment ports and fixture data; no live credentials or network are
needed.

1. The new actual-registered-command suite against the product-owned dispatcher:
   13 passed, one failed. A configured threshold of 0.2 incorrectly remained 0.05.
2. A direct public-owner switch without preserving TUI fixes: 18 passed, six
   failed across the two command files, exposing late-result, refresh-error,
   and output regressions.
3. A fixture matching the real static bootstrap config independently reproduced
   the stale-config bug until the adapter read the live config manager.
4. Final focused engine regression set: 52 passed across seven files. It covers
   the existing public-owner tests plus successful mutation/failed refresh,
   stale reads, lint, preflight, registry, simulation, and diagnostics.
5. Independent review identified a preflight lint-cache compatibility gap. Two
   new tests failed for missing fresh-cache publication and stale-cache overwrite;
   both pass after preserving canonical refresh and fencing cache publication.
   A cancelled preflight retains the prior cache and review.
6. Final focused TUI regression set: 28 passed across three files. It covers
   registration and modal routes; ordinary/default/alias behavior; non-default
   and zero thresholds; lazy missing-service behavior; MCP preflight; registry
   override; awaited results; errors; and stale/cancelled reader outcomes.

Commands:

```sh
bun test packages/engine/test/gate-policy-command.test.ts \
  packages/engine/test/gate-policy-command-safety.test.ts \
  packages/engine/test/gate-policy-lint.test.ts \
  packages/engine/test/gate-policy-preflight.test.ts \
  packages/engine/test/gate-policy-registry.test.ts \
  packages/engine/test/gate-policy-simulation-scenarios.test.ts \
  packages/engine/test/gate-policy-diagnostics-panel.test.ts
(cd products/tui && bun test src/test/input/policy-engine-owner.test.ts \
  src/test/input/policy-record-trend-command.test.ts \
  src/test/views/modals/policy-modal.test.ts)
```

Type-check and independent-review status must be confirmed against the final
commit before publication. These focused source tests are not full workspace,
compiled binary, hosted CI, or merge qualification.
