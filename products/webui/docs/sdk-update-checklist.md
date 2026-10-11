# Update WebUI with the workspace engine

WebUI depends on `@goodvibes-jev/engine` through `workspace:*`. Update the engine
and its browser callers in the same monorepo checkout. The root owns versions,
the lockfile, CI and releases; WebUI has no independent npm SDK update or tag job.

## Prepare the workspace

From the repository root, install the declared dependencies:

```bash
bun install --frozen-lockfile
```

Review engine API, schema and route changes before adapting the browser. Use
declared public exports. External SDK overlays and private `dist/` imports are
unsupported.

If the operator contract changed, regenerate and review its root-owned artifacts:

```bash
bun run refresh:contracts
bun run contracts:check
bun run webui-facade:check
```

Build the engine's compiled public artifacts after reviewing any regenerated
contract changes:

```bash
bun packages/engine/scripts/build.ts
```

## Regenerate browser data

From `products/webui`, regenerate the configuration, ownership, presentation and
contract-inspection snapshots, then check them:

```bash
bun run release:prepare
bun run generated:check
bun run release:gate
```

`release:prepare` also updates the asset cache stamps in `index.html` from the
declared WebUI version. It does not bump versions, write a changelog, install a
package, tag or publish. Review all generated changes before continuing.

## Check the browser changes

From `products/webui`, run the actual product checks and build:

```bash
bun run typecheck
bun run test
bun run lint
bun run build
bun run e2e --project=phone --project=desktop
```

The default Playwright projects serve the production bundle with a synthetic
daemon and local refusal stub. They cover browser behavior and layout, not
authenticated account processing or genuine provider accuracy.

From the repository root, check the workspace and public artifact agreement:

```bash
bun run products:check
bun run exports:check
bun run contracts:check
bun run dist:check
```

Review the affected public imports and generated routes. Keep regular Knowledge
separate from Home Graph. Native Work requests retain engine-owned Jev admission;
legacy approval or attempt controls do not supply a semantic fallback.

## Qualify the intended runtime

Restart the development server with `bun run dev` from `products/webui` after the
compiled engine or generated browser data changes. Check the selected daemon and
the changed user flow, with source and runtime identity recorded in its receipt.

`bun run test:connected-browser` requires an isolated daemon serving the built
bundle and explicit connection settings. It checks status, configuration and
session lifecycle without model calls. It does not establish chat, relay,
configured-account or live-provider parity. Provider calibration and any wider
connected scenario need their own configured runs and receipts.

The root CI and release workflow own integration and artifact delivery. Passing
product checks or creating a bundle does not imply that a release is available
or that the whole project is complete.
