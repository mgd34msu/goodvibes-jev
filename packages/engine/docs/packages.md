# Entry point guide

This SDK publishes `@goodvibes-jev/engine/sdk` plus source-of-truth sibling
packages such as `@goodvibes-jev/engine/contracts`, `@goodvibes-jev/engine/errors`,
and the transport/client packages. Normal application code should still install
`@goodvibes-jev/engine/sdk`; the sibling packages are public dependencies and
source-of-truth facades, not separate setup steps for most consumers.

See the [Published Surface Matrix](./surfaces.md) for the two-tier model: full surface (Bun) vs. companion surface (Hermes / browser / Workers). For the internal runtime-boundary model, see [Runtime Surfaces](./runtime-surfaces.md).

## Consumer decision matrix

| Consumer | Entry point (import path) | Install | Read |
|---|---|---|---|
| Bun service (TUI, daemon) | `@goodvibes-jev/engine/sdk` | `bun add @goodvibes-jev/engine/sdk` | [Getting started](./getting-started.md) |
| Bun CLI app | `@goodvibes-jev/engine/sdk` | `bun add @goodvibes-jev/engine/sdk` | [Getting started](./getting-started.md) |
| Bun server host (daemon routes) | `@goodvibes-jev/engine/sdk/daemon` | `bun add @goodvibes-jev/engine/sdk` | [Daemon embedding](./daemon-embedding.md) |
| React Native app (Hermes) | `@goodvibes-jev/engine/sdk/react-native` | `npm install @goodvibes-jev/engine/sdk` | [React Native integration](./react-native-integration.md) |
| Expo app | `@goodvibes-jev/engine/sdk/expo` | `npm install @goodvibes-jev/engine/sdk` | [Expo integration](./expo-integration.md) |
| Browser SPA needing all operator methods | `@goodvibes-jev/engine/sdk/browser` | `npm install @goodvibes-jev/engine/sdk` | [Browser integration](./browser-integration.md) |
| Base knowledge/wiki WebUI | `@goodvibes-jev/engine/sdk/browser/knowledge` | `npm install @goodvibes-jev/engine/sdk` | [Web UI integration](./web-ui-integration.md) |
| Home Assistant panel | `@goodvibes-jev/engine/sdk/browser/homeassistant` | `npm install @goodvibes-jev/engine/sdk` | [Browser integration](./browser-integration.md) |
| Agent knowledge browser panel | `@goodvibes-jev/engine/sdk/browser/agent` | `npm install @goodvibes-jev/engine/sdk` | [Web UI integration](./web-ui-integration.md) |
| Web app needing the full operator contract | `@goodvibes-jev/engine/sdk/web` | `npm install @goodvibes-jev/engine/sdk` | [Web UI integration](./web-ui-integration.md) |
| Cloudflare Worker batch bridge and provisioning routes | `@goodvibes-jev/engine/sdk/workers` plus daemon `/api/cloudflare/*` | `npm install @goodvibes-jev/engine/sdk` | [Daemon batch processing](./daemon-batch-processing.md) |
| iOS native | JSON contracts via `/contracts/operator-contract.json` and `/contracts/peer-contract.json` | N/A | [iOS integration](./ios-integration.md) |
| Android native | JSON contracts via `/contracts/operator-contract.json` and `/contracts/peer-contract.json` | N/A | [Android integration](./android-integration.md) |

`/browser` and `/web` are both companion-safe browser runtime entrypoints. Use
`/browser` for generic browser applications and `/web` for web UI hosts.

## Advanced platform entry points

| Entry point | Use it when |
|---|---|
| `@goodvibes-jev/engine/sdk/platform/node` | You need runtime capability metadata or Node-like runtime-boundary checks before loading server-side modules |
| `@goodvibes-jev/engine/sdk/platform/runtime` | You are wiring runtime bootstrap, observability, operations, security, shell, state, transport, or UI behavior |
| `@goodvibes-jev/engine/sdk/platform/knowledge` | You are using the base self-improving knowledge/wiki system directly |
| `@goodvibes-jev/engine/sdk/platform/knowledge/home-graph` | You are extending the knowledge system for Home Assistant Home Graph behavior |
| `@goodvibes-jev/engine/sdk/platform/providers` | You are working with provider registries, model catalogs, capabilities, or provider-specific runtime helpers |
| `@goodvibes-jev/engine/sdk/platform/tools` | You are registering or executing runtime tools from a full platform host |
| `@goodvibes-jev/engine/sdk/platform/pairing` | You need QR code generation, companion token management, and connection info formatting |
| `@goodvibes-jev/engine/sdk/platform/daemon` | You need daemon HTTP host helpers, including port-in-use checking |

The platform surface is explicit. There is no root
`@goodvibes-jev/engine/sdk/platform` entry and no public
`@goodvibes-jev/engine/sdk/platform/*` wildcard export. Import only subpaths listed
in `package.json` and the canonical [Public surface](./public-surface.md) reference.

Treat `platform/...` modules as full-platform/server-side unless a specific
document marks the entry point as companion-safe. Today the full surface is
Bun-oriented; `platform/node` exposes capability metadata and runtime-boundary
helpers without aggregating the full platform. Do not
bypass the package export map from applications; repository file layout is not
the consumer contract.

## Companion-safe entry points

These entry points contain no Bun globals and bundle cleanly with Metro, Vite, webpack, and esbuild:

| Entry point | Purpose |
|---|---|
| `@goodvibes-jev/engine/sdk/react-native` | React Native (Hermes) defaults |
| `@goodvibes-jev/engine/sdk/expo` | Expo companion defaults and Expo secure token stores |
| `@goodvibes-jev/engine/sdk/browser` | Full browser defaults and complete operator contract |
| `@goodvibes-jev/engine/sdk/browser/knowledge` | Scoped base knowledge/wiki browser client |
| `@goodvibes-jev/engine/sdk/browser/homeassistant` | Scoped Home Assistant Home Graph browser client |
| `@goodvibes-jev/engine/sdk/browser/agent` | Scoped browser client for the Agent-owned knowledge environment; routes Knowledge/Wiki calls to the agent knowledge routes |
| `@goodvibes-jev/engine/sdk/web` | Full web UI companion defaults |
| `@goodvibes-jev/engine/sdk/workers` | Manual Cloudflare Worker bridge for optional daemon batch queue/tick integration; SDK-owned provisioning is done through daemon `/api/cloudflare/*` routes |
| `@goodvibes-jev/engine/sdk/auth` | Token storage and auth flows |
| `@goodvibes-jev/engine/sdk/client-auth` | Low-level auth primitives: `AutoRefreshCoordinator`, platform-specific token stores, and auto-refresh options. Use `@goodvibes-jev/engine/sdk/auth` for most use cases. |
| `@goodvibes-jev/engine/sdk/observer` | Observability helpers (`createConsoleObserver`, `createOpenTelemetryObserver`). Also re-exported from root. |
| `@goodvibes-jev/engine/sdk/errors` | Typed error classes |
| `@goodvibes-jev/engine/sdk/contracts` | Runtime-neutral contract types and method IDs |
| `@goodvibes-jev/engine/sdk/operator` | Operator/control-plane client |
| `@goodvibes-jev/engine/sdk/peer` | Peer/distributed-runtime client |
| `@goodvibes-jev/engine/sdk/transport-core` | Transport/event-feed primitives |
| `@goodvibes-jev/engine/sdk/transport-http` | HTTP/SSE/auth/retry primitives |
| `@goodvibes-jev/engine/sdk/transport-realtime` | Runtime-event connectors over SSE and WebSocket |
| `@goodvibes-jev/engine/sdk/transport-direct` | In-process direct transport facade subpath; see [Transports](./transports.md) |

CI job `platform-matrix` (`rn-bundle` dimension) enforces that companion dist bundles contain no `Bun.*` identifiers and no `node:*` imports.


## Transport middleware

The SDK supports Koa-style transport middleware via `sdk.use()`. Middleware wraps every HTTP request/response cycle through the operator and peer transports.

```ts
import { createGoodVibesSdk } from '@goodvibes-jev/engine/sdk';
import type { TransportMiddleware } from '@goodvibes-jev/engine/sdk/transport-core';

const sdk = createGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3421',
  authToken: process.env.GOODVIBES_TOKEN,
});

// Append middleware at construction time via options.middleware:
// const sdk = createGoodVibesSdk({ ..., middleware: [myMiddleware] });

// Or append after construction:
sdk.use(async (ctx, next) => {
  const start = Date.now();
  console.log('->', ctx.method, ctx.url);
  await next();
  console.log('<-', ctx.response?.status, Date.now() - start, 'ms');
  if (ctx.error) {
    console.error('transport error', ctx.error);
  }
});
```

Middleware runs in order. Each middleware receives a mutable `TransportContext` and a `next()` function. Calling `next()` executes the remainder of the chain (including the real fetch). After `await next()` returns:
- `ctx.response`: the `Response` object (on success)
- `ctx.durationMs`: round-trip time in milliseconds
- `ctx.error`: the thrown error (on failure)

Middleware can:
- inspect or mutate request headers (`ctx.headers`) before the fetch
- inspect the response after `next()` resolves
- short-circuit by not calling `next()` (returns without a response)
- access `ctx.signal`, `ctx.body`, `ctx.options` for per-request data

`TransportMiddleware` and `TransportContext` are exported from `@goodvibes-jev/engine/sdk/transport-core`.

`composeMiddleware` is also exported for building standalone composed chains outside the SDK:

```ts
import { composeMiddleware } from '@goodvibes-jev/engine/sdk/transport-core';

const executor = composeMiddleware([loggingMiddleware, retryMiddleware], innerFetch);
```

## Contracts

The `@goodvibes-jev/engine/sdk/contracts` entry is runtime-neutral. Raw JSON artifacts are available at:
- `@goodvibes-jev/engine/sdk/contracts/operator-contract.json`
- `@goodvibes-jev/engine/sdk/contracts/peer-contract.json`

`@goodvibes-jev/engine/sdk/contracts/node` exports filesystem path helpers for locating JSON contract artifacts on disk. It is a build/tooling convenience, not a runtime surface.

## Entry point relationships

- `@goodvibes-jev/engine/sdk/auth` adds token storage and login/current-auth helpers.
- `@goodvibes-jev/engine/sdk/contracts` is the typed vocabulary layer (method IDs, endpoint IDs, event maps).
- `@goodvibes-jev/engine/sdk/errors` defines the shared error model (`GoodVibesSdkError`, `SDKErrorKind`).
- `@goodvibes-jev/engine/sdk/transport-*` subpaths carry low-level transport behavior.
- `@goodvibes-jev/engine/sdk/operator` and `/peer` build contract-driven clients on top of transport.
- `@goodvibes-jev/engine/sdk` (root) composes those pieces into a Bun-optimized full-surface SDK.
- `@goodvibes-jev/engine/sdk/daemon` is the reusable server/daemon route layer for Bun hosts.

## Sibling-package deep subpaths

The source-of-truth sibling packages (`@goodvibes-jev/engine/contracts`, `@goodvibes-jev/engine/daemon-sdk`,
`@goodvibes-jev/engine/transport-core`, `@goodvibes-jev/engine/transport-http`, `@goodvibes-jev/engine/operator-sdk`,
`@goodvibes-jev/engine/peer-sdk`, and `@goodvibes-jev/engine/errors`) each publish additional deep subpaths,
for example `contracts/generated/*`, `contracts/zod-schemas/*`, `daemon-sdk/*` route helpers,
`transport-core/*`, `transport-http/*`, the operator/peer `client*` entries, and
`errors/daemon-error-contract`. These back the `@goodvibes-jev/engine/sdk` facade and are not part of the
supported consumer contract; import the matching `@goodvibes-jev/engine/sdk/...` subpath instead. See
[Public exports](./exports.md) for the same guidance.
