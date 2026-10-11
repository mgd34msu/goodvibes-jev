# GoodVibes WebUI

The browser product in the GoodVibes Jev monorepo. The app, responsive shell, PWA,
assets and behavior tests originate at upstream `goodvibes-webui` revision
`dadf57700668fe4500b17b0b0b4520715ab25ef4` (WebUI 2.0.0).

The app consumes the engine's contract inspection, session gate presets and
authenticated browser judgment transport. Declared status catalogs remain exact
producer facts; unknown metadata requires its canonical reader or stays held.
Native requests use daemon-owned Jev admission and execution, with cancellation
and recorded outcomes visible in Work.

Source integration and tests with scripted responses do not establish full
connected-daemon parity or live-provider accuracy. The default browser matrix
uses a synthetic daemon. Connected runtime and provider qualification require
their own receipts for the tested source and configuration.

## Development

Install dependencies from the monorepo root and build the workspace with
`bun run build`. This product uses only declared `@goodvibes-jev/engine` exports;
its production browser build consumes compiled engine artifacts. Standalone SDK
overlays and independent package pins are not supported.

From `products/webui`:

- `bun run dev`: local Vite server, with daemon binding discovery
- `bun run build`: verify engine-derived snapshots, then compile the browser app
- `bun run typecheck`: browser, tooling and Playwright TypeScript programs
- `bun run test`: isolated Bun behavior tests
- `bun run e2e --project=phone --project=desktop`: synthetic daemon browser matrix
- `bun run lint`: source and tooling lint
- `bun run release:gate`: shared engine workspace dependency/export checks
- `bun run release:prepare`: regenerate engine data snapshots and versioned assets
- `bun run pack:bundle`: deterministic archive of the built `dist/`

Use `GOODVIBES_DAEMON_BASE_URL` to point the development proxy at an intended
local daemon. Playwright uses its own 503 stub and in-browser mocks, and must not
be pointed at live providers, mail, payment or credential services. Live smoke
commands are opt-in and are not part of the default test suite.

The monorepo owns installation, versions, release workflows, tagging and
publication. Product-level preparation only writes generated browser data and
asset cache stamps. Existing legacy URLs continue to map into Chat, Work,
Library, Personal and Settings while preserving deep-link fragments.
