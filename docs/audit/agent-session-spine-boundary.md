# Agent session-spine connection boundary reconciliation

## One row, existing behavior

This documentation/accounting correction changes only the disposition of
`src/runtime/session-spine-rest-transport.ts` from HOIST to PORT. It preserves
Agent-owned host/token selection and the public engine's injected REST transport,
probe, receipt machinery and session client. It changes no production source,
tracked tests, validators or runtime policy. It does not resolve the separate
upstream-deleted `src/test/runtime/session-spine-client.test.ts` row.

The independently reviewed base is
`4698d47405ea1ba824389a0311148ec48d74645a`. That prior ledger/permission-owner
accounting commit is preserved separately. This work uses its own isolated
checkout; the frozen native qualification and pending publication trees are
untouched. Production source remains the qualified `94d5753a` source.

## Provenance and disposition

The exact original Agent baseline file was fetched through the GitHub connector
at revision `9e225a349667632bb550e9c270d922b985848eaa`:
[original resolver](https://github.com/mgd34msu/goodvibes-agent/blob/9e225a349667632bb550e9c270d922b985848eaa/src/runtime/session-spine-rest-transport.ts),
blob `c5f4eddc58b0d88c161e207d36eaac5bef2a454b`. It already contains only
`SessionRegistrationConnection` and `createSpineConnectionResolver`; its header
expressly excludes the resolver from the REST hoist and directs consumers to
public SDK transport/probe/receipt factories. This is not a newly invented
exemption based on the current implementation.

The accepted [extraction decision](../../packages/engine/docs/decisions/2026-07-05-session-spine-sdk-extraction.md)
lines 21–23 and 108–109 retains Agent token-reading and the named resolver.
Its later correction, lines 132–146, hoists the raw REST transport while
explicitly preserving that consumer trust boundary. The
[intent](../../goodvibes-jev-intent.md) line 256 requires the spine *transports*
to live in the engine; its runtime list separately retains connected-host auth.
The [engine transport header](../../packages/engine/sdk/src/platform/runtime/session-spine/rest-transport.ts)
lines 15–30 repeats the same division.

The old [inventory](../inventory/agent.md) row described only this resolver but
labeled it HOIST and said it moves. Under the unchanged
[validator](../../packages/engine/scripts/product-workspace-contract.ts)
lines 190–200, HOIST can target only engine files and PORT can target only
product files. Pointing a HOIST mapping at adjacent engine transport machinery
would therefore pass the location check while falsely describing what happened
to this resolver. Correcting this single mislabeled row to PORT, then mapping
its actual retained product file, faithfully represents the accepted boundary.
Independent read-only review approved that correction **before** the mapping
and count advanced, after checking the original baseline evidence.

The retained [product file](../../products/agent/src/runtime/session-spine-rest-transport.ts)
blob is `9ec656fe9eea0bef07acf980875d7aff5af493bb`. It is retained with existing
adaptations, not byte-identical: imports use the monorepo public namespace and
its prior host-bound pairing improvement supplies `baseUrl` to
`readConnectedHostOperatorToken`. This reconciliation adds neither change.
The historical `recoveredBlob` remains
`827556babd8c8db3a45ba75e58c9eb60e1362559`; it is not rewritten as a current
source digest.

## Actual owners and callers

- The [public barrel](../../packages/engine/sdk/src/platform/runtime/session-spine/index.ts)
  and [package export](../../packages/engine/package.json) expose
  `SessionSpineClient`, REST register/close, probe and receipt functions.
  Engine transport blob: `49ac790ac3ff58844dd9fa9a1e3cfb3afc309647`;
  client blob: `62c6a6dd855715b243cc0f0e4e295b3eb89eb62c`.
- [Agent services](../../products/agent/src/runtime/services.ts) lines 93–100
  import public machinery separately from the local resolver. Lines 1154–1160
  construct its resolver and receipt consumer; 1220–1237 construct the public
  client, explicit `recordKind: 'agent'`, transport and plain liveness probe.
  Register, close, probe and receipt factories resolve the connection anew for
  each operation (engine transport lines 200, 205, 264 and 327).
- [Bootstrap core](../../products/agent/src/runtime/bootstrap-core.ts) registers
  and heartbeats the current session; [resume](../../products/agent/src/runtime/bootstrap-hook-bridge.ts)
  reopens explicitly. [Bootstrap](../../products/agent/src/runtime/bootstrap.ts)
  retains legacy folding and the adoption-edge receipt consumption; frequent
  liveness probes do not consume receipts. [Shutdown](../../products/agent/src/runtime/bootstrap-shutdown.ts)
  closes/disposes, and services also register graph-owned disposal.
- [Memory CLI wiring](../../products/agent/src/cli/memory-command-wire.ts)
  lines 135–139 passes this same product resolver to the public probe and its
  memory transport. [Token selection](../../products/agent/src/runtime/connected-host-auth.ts)
  retains environment precedence, host-bound paired credentials and fail-closed
  unknown/unavailable pairing handling. None of those responsibilities moves.

## Fresh bounded proof, 2026-10-08

All commands used Bun 1.3.14 and the canonical owned runner with unchanged
budgets. Public Bun exports resolved to this isolated checkout's engine source.
Network was mocked or synthetic loopback; homes, tokens and pairing stores were
fixtures. No real credentials, live endpoint, provider or mailbox was used.

```sh
bun packages/engine/scripts/test.ts \
  test/session-spine-rest-transport.test.ts test/session-spine-client.test.ts
# 51 pass, 0 fail; 153 assertions; 2 files

bun packages/engine/scripts/test.ts --cwd ../../products/agent \
  src/test/runtime/agent-host-pairing.test.ts \
  src/test/runtime/daemon-receipts.test.ts \
  src/test/runtime/memory-spine-adoption.test.ts
# 37 pass, 0 fail; 140 assertions; 3 files

# Materialize the audit-only TypeScript appendix below at this ignored path.
mkdir -p /tmp/gv-spine-audit-home
env -i PATH="$PATH" HOME=/tmp/gv-spine-audit-home \
  bun packages/engine/scripts/test.ts --cwd ../../products/agent \
  ./temp/session-spine-boundary-proof.test.ts
# 3 pass, 0 fail; 60 assertions; 1 audit-only file
```

The canonical suites cover wire shapes, durable-reject versus transient-offline
folding, queue/heartbeat/activation behavior, host-bound pairing selection and
stale/unknown pairing outcomes, receipt buffering/dedup, and adoption/loss/
re-adoption/build-floor edges. The additional audit probe uses a cleared process
environment and synthetic HOME. It reuses one resolver across eight operations,
rotating configured port and synthetic file/environment tokens before each
register, close, probe and receipt call. It verifies the actual Agent graph's
public constructor identity, `agent` record kind, rotated connection selection,
receipt consumption/dedup and close. Its last case checks concrete production
call sites; those source assertions are not represented as executed full
bootstrap or CLI flows.

The appendix is review evidence, not a claim of restored parity for the deleted
client-test row. No project compiler, package build, API extraction, heavy
containment or full Agent aggregate was run. Existing genuine connected/live,
native aggregate, semantic migration and final release obligations remain open.
No external publication, Linear mutation or pending approval-card action occurred.

## Metadata validation

The canonical `inventoryDispositions` parser verified the before/after counts,
unique/disjoint/exact baseline partition and byte-identical unrelated rows.
Exact JSON comparisons verified every preserved ledger and remaining obligation.
`product-workspaces.ts check` first correctly rejected the temporary audit-only
TypeScript file because it sits outside the declared projects. After removing
that scratch copy (retaining the exact appendix below), the unchanged check
passed: four present products, zero pending. No source, project boundary or
validator exemption was used to obtain that pass. `git diff --check` passes and
all relative audit links resolve. The direct product matrix also returns exactly
`["daemon", "tui", "agent", "webui"]`. Independent final read-only review reran
the canonical parser/invariant proof, checked the derived area totals, matched
the appendix to its tested bytes and verified the unchanged production source.

## Accounting conservation

The actual JSON structure advances from 1,159 mapped + 443 unresolved to
**1,160 mapped + 442 unresolved = 1,602**. Both sets remain unique and disjoint,
and their union is exactly the pinned baseline. Only the named source moves;
remaining buckets are 222 public-engine-successor rows and 220 deleted-review
rows, with unresolved dispositions 176 PORT + 44 JEV + 222 HOIST.

The 248 deleted-source entries and 296 added-source reviews are unchanged, as
are all 1,650 historical coverage/materialization entries, all 207 pending
mapped JEV rows, every unrelated mapping/unresolved row, remaining-obligation
text and `status: partial`. In particular the deleted session-spine-client test
is still unresolved. No source-retention count is treated as live parity proof.

The inventory's pre-existing prose totals already disagreed with its actual
rows before this correction. The actual row counts change only by PORT +1 /
HOIST −1: 1,118 PORT / 252 JEV / 230 HOIST / 2 DROP becomes
1,119 PORT / 252 JEV / 229 HOIST / 2 DROP. The stale summary had claimed 1,117 PORT / 254 JEV / 231 HOIST / 0 DROP.
The overall, affected area and affected subsection totals are corrected to the
parsed current rows, including prior changes in Core/config, Runtime and
cross-cutting tests. This is explicitly derived summary reconciliation; only
the named resolver row changes disposition and every other inventory row remains
byte-identical. Decision-point counts and historical recovery ledgers are unchanged. The two
DROP rows already recorded separate owner-authorized removal of the test-only
plain-language gate; this correction does not authorize or perform any removal.
Older prose describing the initial no-DROP scope is historical and is not used
as current accounting evidence.

## Audit-only reproducible probe

Save the following block to `products/agent/temp/session-spine-boundary-proof.test.ts`
(an ignored directory), then use the canonical command above with a synthetic
HOME and no inherited provider credentials. Remove that scratch file afterward
before running the product metadata gate, which rightly scans all source files
including ignored test scratch. SHA-256 of the exact probe bytes:
`b1c6775f1da6277cd12ab8a26c1a5d4679c484520bd975033ad5d94d1830484e`.

```ts
/** Audit-only probe; no tracked source changes. Run through the canonical owned runner. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SessionSpineClient, AGENT_SPINE_PARTICIPANT, createSessionSpineRestTransport,
  createSessionSpineRestProbe, createSessionSpineReceiptConsumer,
} from '@goodvibes-jev/engine/sdk/platform/runtime/session-spine';
import { ConfigManager } from '../src/config/index.ts';
import { createSpineConnectionResolver } from '../src/runtime/session-spine-rest-transport.ts';
import { makeProjectTempDir } from '../src/test/helpers/project-temp.ts';
import { getTestRuntimeServices, resetTestRuntimeServices } from '../src/test/helpers/runtime-services.ts';
import type { RuntimeServices } from '../src/runtime/services.ts';

const names = ['GOODVIBES_CONNECTED_HOST_TOKEN', 'GOODVIBES_DAEMON_TOKEN'] as const;
let saved: (string | undefined)[];
let originalFetch: typeof fetch;
let runtime: RuntimeServices | undefined;
let requests: { url: string; method: string; token: string | null; body: Record<string, unknown> | null }[];
beforeEach(() => {
  saved = names.map(name => process.env[name]);
  for (const name of names) delete process.env[name];
  originalFetch = globalThis.fetch;
  requests = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, method: init?.method ?? 'GET', token: headers.get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null });
    return Response.json(url.includes('/status')
      ? { version: '9.0.0', receipts: [{ id: 'synthetic-receipt', text: 'Synthetic restart', at: 1 }] }
      : { reopened: false, session: null });
  }) as typeof fetch;
});
afterEach(() => {
  runtime?.dispose(); runtime = undefined;
  resetTestRuntimeServices();
  globalThis.fetch = originalFetch;
  names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; });
});

test('one retained resolver reselects host and synthetic token on every public REST operation', async () => {
  const home = makeProjectTempDir('session-spine-boundary');
  const config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(home, 'config'), workingDir: home, homeDir: home });
  config.set('controlPlane.host', '127.0.0.1');
  const tokenPath = join(home, '.goodvibes', 'daemon', 'operator-tokens.json');
  mkdirSync(join(home, '.goodvibes', 'daemon'), { recursive: true });
  const resolver = createSpineConnectionResolver(config, home);
  const transport = createSessionSpineRestTransport({ resolveConnection: resolver });
  const probe = createSessionSpineRestProbe({ resolveConnection: resolver });
  const consume = createSessionSpineReceiptConsumer({ resolveConnection: resolver });
  const paths = ['/api/sessions/register', '/api/sessions/fixture%2Fid/close', '/status', '/status?receipts=consume'];
  for (let i = 0; i < 8; i++) {
    for (const name of names) delete process.env[name];
    config.set('controlPlane.port', 18000 + i);
    const token = `synthetic-selection-${i}`;
    writeFileSync(tokenPath, JSON.stringify({ token }));
    if (i % 3 === 1) process.env.GOODVIBES_DAEMON_TOKEN = token;
    if (i % 3 === 2) { process.env.GOODVIBES_DAEMON_TOKEN = 'synthetic-shadowed'; process.env.GOODVIBES_CONNECTED_HOST_TOKEN = token; }
    const operation = i % 4;
    if (operation === 0) expect(await transport.register({ sessionId: 'fixture/id', participant: { ...AGENT_SPINE_PARTICIPANT, lastSeenAt: i } })).toEqual({ outcome: 'ok' });
    if (operation === 1) expect(await transport.close('fixture/id')).toEqual({ outcome: 'ok' });
    if (operation === 2) expect(await probe()).toBe(true);
    if (operation === 3) expect(await consume()).toEqual([{ id: 'synthetic-receipt', text: 'Synthetic restart', at: 1 }]);
    expect(requests).toHaveLength(i + 1);
    expect(requests[i]?.url).toBe(`http://127.0.0.1:${18000 + i}${paths[operation]}`);
    expect(requests[i]?.token).toBe(`Bearer ${token}`);
    expect(requests[i]?.method).toBe(operation < 2 ? 'POST' : 'GET');
  }
});

test('actual Agent graph uses public constructor, product selection, record kind and receipt dedup', async () => {
  process.env.GOODVIBES_CONNECTED_HOST_TOKEN = 'synthetic-graph-first';
  runtime = getTestRuntimeServices();
  expect(runtime.sessionSpineClient.constructor).toBe(SessionSpineClient);
  runtime.configManager.set('controlPlane.host', '127.0.0.1');
  runtime.configManager.set('controlPlane.port', 18100);
  requests.length = 0;
  runtime.sessionSpineClient.register({ sessionId: 'graph-session', project: 'synthetic-project' });
  await Bun.sleep(0);
  expect(requests[0]?.url).toBe('http://127.0.0.1:18100/api/sessions/register');
  expect(requests[0]?.body).toMatchObject({ sessionId: 'graph-session', kind: 'agent', participant: AGENT_SPINE_PARTICIPANT });
  expect(requests[0]?.token).toBe('Bearer synthetic-graph-first');
  process.env.GOODVIBES_CONNECTED_HOST_TOKEN = 'synthetic-graph-second';
  runtime.configManager.set('controlPlane.port', 18101);
  expect(await runtime.sessionSpineClient.probeReachability()).toBe('online');
  expect(requests.at(-1)).toMatchObject({ url: 'http://127.0.0.1:18101/status', token: 'Bearer synthetic-graph-second' });
  const delivered: string[] = [];
  await runtime.consumeDaemonReceipts();
  runtime.daemonReceiptFeed.attach(receipt => delivered.push(receipt.id));
  await runtime.consumeDaemonReceipts();
  expect(delivered).toEqual(['synthetic-receipt']);
  expect(requests.filter(request => request.url.endsWith('/status?receipts=consume'))).toHaveLength(2);
  runtime.sessionSpineClient.close('graph-session');
  await Bun.sleep(0);
  expect(requests.at(-1)).toMatchObject({ url: 'http://127.0.0.1:18101/api/sessions/graph-session/close', token: 'Bearer synthetic-graph-second' });
});

test('actual product callers retain local composition and consume public engine lifecycle', () => {
  const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
  const services = source('runtime/services.ts');
  expect(services).toContain("from '@goodvibes-jev/engine/sdk/platform/runtime/session-spine'");
  expect(services).toContain("import { createSpineConnectionResolver } from './session-spine-rest-transport.ts'");
  expect(services).toContain('createSpineConnectionResolver(configManager, homeDirectory)');
  expect(services).toContain('createSessionSpineRestTransport({ resolveConnection: spineResolveConnection })');
  expect(services).toContain("disposalScope.registry.add('session spine client', () => sessionSpineClient.dispose())");
  const bootstrap = source('runtime/bootstrap.ts');
  expect(bootstrap).toContain('probeReachability: () => services.sessionSpineClient.probeReachability()');
  expect(bootstrap).toContain('return services.consumeDaemonReceipts()');
  expect(source('runtime/bootstrap-core.ts')).toContain('services.sessionSpineClient.heartbeat(runtimeSessionIdRef.value)');
  expect(source('runtime/bootstrap-hook-bridge.ts')).toContain('options.sessionSpineClient.reopen({ sessionId, project: options.projectRoot })');
  const cli = source('cli/memory-command-wire.ts');
  expect(cli).toContain('createSpineConnectionResolver(runtime.configManager, runtime.homeDirectory)');
  expect(cli).toContain("from '@goodvibes-jev/engine/sdk/platform/runtime/session-spine'");
});
```
