# Workspace development

Install dependencies from the GoodVibes Jev monorepo root with the pinned Bun
version. This product declares `@goodvibes-jev/engine: workspace:*`; its application
imports only public engine subpaths. The old standalone SDK link/restore workflow
is replaced by the workspace dependency graph.

Build the engine from the monorepo root before checking or bundling browser code.
After an intentional engine schema or presentation change, run
`bun run release:prepare` from `products/webui` and review the generated artifacts.
The browser build verifies these artifacts and refuses Node-only module imports.

Run `bun run dev` from this directory. Normal development retains daemon binding
discovery; explicit `GOODVIBES_DAEMON_BASE_URL`, `GOODVIBES_WEB_HOST` and
`GOODVIBES_WEB_PORT` settings choose an intended local connection. Set
`GOODVIBES_WEBUI_BINDING_DISCOVERY=0` for deterministic test environments. Production
builds and preview do not inspect machine CLI or settings state.

See [Testing and validation](testing-and-validation.md) for required product and
browser checks, and [the product README](../README.md) for migration limits.
Imported architecture/design/operator references document upstream behavior;
they do not imply that every Jev migration obligation or legacy standalone
release procedure is complete or active in this monorepo.
