# @pellux/goodvibes-operator-sdk

Public GoodVibes operator package for the contract-driven operator and control-plane HTTP client.

Most applications should install `@pellux/goodvibes-sdk` and import `@pellux/goodvibes-sdk/operator`. Install this package directly when you only need the operator client subset.

```ts
import { createOperatorSdk } from '@goodvibes-jev/engine/sdk/operator';

const operator = createOperatorSdk({
  baseUrl: 'http://127.0.0.1:3421',
  authToken: process.env.GOODVIBES_TOKEN,
});

const snapshot = await operator.control.snapshot();
const login = await operator.invoke('control.auth.login', {
  username: 'alice',
  password: 'secret',
});
```

Use this surface when you want only the operator/control-plane surface and do not need the main SDK composition layer.

## Typed methods

The `createOperatorSdk` client exposes the operator contract as typed,
namespaced methods:

```ts
const status = await operator.control.status();
const sessions = await operator.sessions.list();

// Open a server-sent event stream; resolves to an unsubscribe function.
const stop = await operator.stream('control.events.stream', {
  handlers: {
    onEvent: (eventName, payload) => console.log(eventName, payload),
  },
});
stop();
```

Response bodies are validated against their Zod contract schemas by default;
pass `validateResponses: false` to `createOperatorSdk` to opt out. Call
`dispose()` (or `await asyncDispose()`) to release resources when finished;
the client also implements `Symbol.dispose` / `Symbol.asyncDispose`.

Advanced consumers can also build directly from a preconfigured transport and contract:

```ts
import { getOperatorContract } from '@goodvibes-jev/engine/sdk/contracts';
import { createOperatorRemoteClient } from '@goodvibes-jev/engine/sdk/operator';
import { createHttpTransport } from '@goodvibes-jev/engine/sdk/transport-http';

const transport = createHttpTransport({
  baseUrl: 'http://127.0.0.1:3421',
  authToken: process.env.GOODVIBES_TOKEN,
});

const operator = createOperatorRemoteClient(transport, getOperatorContract());
const status = await operator.control.status();
```

## See also

- Main SDK: [`@pellux/goodvibes-sdk`](../sdk/README.md)
- [Getting Started](../../docs/getting-started.md)


## Native work ledger reads

`createOperatorWorkLedgerReadClient(operator, expectedProjectId, options?)` adapts
an already selected, authenticated `OperatorRemoteClient` to the shared host
read-client contract. It never discovers a database or selects another host.
The runtime owns `dispose()`; a view owns only the cleanup returned by
`subscribe()`. Subscribe before the initial snapshot, and use `history(cursor)`
after a reconnect to catch up durable changes. Notifications are best-effort
snapshot wake-ups, not evidence that every event was delivered.

The host serves only `workLedger.snapshot` and `workLedger.history`, requiring
owner/admin access **and** the dedicated `read:work-ledger` scope. Generic event,
fleet, workspace, and non-admin read grants cannot read this ledger. Every request
must match the injected host reader's project exactly. Actor identities,
filesystem paths, writes, launches, and verifier capabilities are not inputs.
Snapshots omit `allowedActions`.

History uses an exclusive `afterSequence` cursor and an immutable per-catch-up
`throughSequence` high-water mark. Each wire page contains at most 100 events and
1 MiB of JSON. `cursor` is the last delivered sequence; `hasMore` is true only
when the pinned high-water mark has not been reached. The client drains pages and
checks ordering, contiguous progress, project identity, and the pinned mark.
It refuses catch-up exceeding 10,000 events, 8 MiB, or 128 pages rather than
returning a partial success. Read a fresh snapshot to resume from a current
cursor. Snapshots exceeding 1 MiB likewise fail explicitly, never truncate.

Polling reauthenticates every request, backs off transient failures to at most
60 seconds, and stops after authentication, authorization, absent-host, or gone
responses. `onUnavailable` reports observation errors to the runtime. The runtime
must establish a new binding after a terminal admission failure. Reads time out
after 30 seconds by default; the optional timeout is bounded to 100–60,000 ms.
Disposal fences late results and aborts in-flight reads; removing the last
observer cancels observation without disposing the reader. No event subscription
or broader token grant is created.
