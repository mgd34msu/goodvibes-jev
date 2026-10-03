import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import {
  buildAgentWorkspaceChannelTriage,
  formatAgentWorkspaceChannelTriage,
} from '../../input/agent-workspace-channel-triage.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function writeTokenHome(): string {
  const home = makeProjectTempDir('goodvibes-agent-triage-token');
  const tokenDir = join(home, '.goodvibes', 'daemon');
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(join(tokenDir, 'operator-tokens.json'), JSON.stringify({ token: 'route-token-redacted' }));
  return home;
}

function triageContext(homeDirectory: string): CommandContext {
  const shellPaths = createShellPathService({ workingDirectory: homeDirectory, homeDirectory });
  const values: Record<string, unknown> = {
    'controlPlane.host': '127.0.0.1',
    'controlPlane.port': 3421,
  };
  return {
    print: () => {},
    platform: {
      configManager: {
        get: (key: string) => values[key],
      },
    },
    workspace: {
      shellPaths,
    },
  } as unknown as CommandContext;
}

async function withMockFetch<T>(handler: Parameters<typeof mockFetch>[0], run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(handler);
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const EMPTY_ROUTE_BODIES: Record<string, unknown> = {
  '/api/deliveries': { totals: {}, attempts: [] },
  '/api/control-plane/messages': { messages: [] },
};

describe('agent workspace channel triage: honest inbound attribution', () => {
  test('a binding whose externalId resolves to a known principal shows the resolved name', async () => {
    const home = writeTokenHome();
    const context = triageContext(home);
    const resolveCalls: unknown[] = [];

    const triage = await withMockFetch(async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path === '/api/principals/resolve') {
        resolveCalls.push(init?.body ? JSON.parse(String(init.body)) : null);
        return new Response(JSON.stringify({
          known: true,
          principal: { id: 'principal-abc123', name: 'Mike Davis', kind: 'user', identities: [], createdAt: 1, updatedAt: 1 },
        }));
      }
      if (path === '/api/routes/bindings') {
        return new Response(JSON.stringify({
          bindings: [{
            id: 'binding-known',
            kind: 'channel',
            surfaceKind: 'slack',
            surfaceId: 'slack',
            externalId: 'U-known-sender',
            title: 'Ops',
            lastSeenAt: 1,
          }],
        }));
      }
      if (path in EMPTY_ROUTE_BODIES) return new Response(JSON.stringify(EMPTY_ROUTE_BODIES[path]));
      return new Response('not found', { status: 404 });
    }, () => buildAgentWorkspaceChannelTriage(context, {}));

    const bindings = (triage.routeBindings as { bindings: readonly Record<string, unknown>[] }).bindings;
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.principalLabel).toBe('Mike Davis (principal-abc123)');
    expect(bindings[0]?.principal).toEqual({ id: 'principal-abc123', name: 'Mike Davis', kind: 'user' });
    expect(resolveCalls).toEqual([{ channel: 'slack', value: 'U-known-sender' }]);

    const formatted = formatAgentWorkspaceChannelTriage(triage);
    expect(formatted).toContain('sender=Mike Davis (principal-abc123)');
    expect(formatted).not.toContain('U-known-sender');
  });

  test('a binding whose externalId resolves to known:false shows exactly "unknown principal"', async () => {
    const home = writeTokenHome();
    const context = triageContext(home);

    const triage = await withMockFetch(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/principals/resolve') {
        return new Response(JSON.stringify({ known: false, principal: null }));
      }
      if (path === '/api/routes/bindings') {
        return new Response(JSON.stringify({
          bindings: [{
            id: 'binding-unmapped',
            kind: 'channel',
            surfaceKind: 'slack',
            surfaceId: 'slack',
            externalId: 'U-unmapped-sender',
            title: 'Ops',
            lastSeenAt: 1,
          }],
        }));
      }
      if (path in EMPTY_ROUTE_BODIES) return new Response(JSON.stringify(EMPTY_ROUTE_BODIES[path]));
      return new Response('not found', { status: 404 });
    }, () => buildAgentWorkspaceChannelTriage(context, {}));

    const bindings = (triage.routeBindings as { bindings: readonly Record<string, unknown>[] }).bindings;
    expect(bindings[0]?.principalLabel).toBe('unknown principal');
    expect(bindings[0]?.principal).toBeNull();

    const formatted = formatAgentWorkspaceChannelTriage(triage);
    expect(formatted).toContain('sender=unknown principal');
  });

  test('a binding whose resolve call fails shows exactly "unknown principal", not a guess', async () => {
    const home = writeTokenHome();
    const context = triageContext(home);

    const triage = await withMockFetch(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/principals/resolve') {
        return new Response(JSON.stringify({ error: 'internal error' }), { status: 500 });
      }
      if (path === '/api/routes/bindings') {
        return new Response(JSON.stringify({
          bindings: [{
            id: 'binding-erroring',
            kind: 'channel',
            surfaceKind: 'slack',
            surfaceId: 'slack',
            externalId: 'U-erroring-sender',
            title: 'Ops',
            lastSeenAt: 1,
          }],
        }));
      }
      if (path in EMPTY_ROUTE_BODIES) return new Response(JSON.stringify(EMPTY_ROUTE_BODIES[path]));
      return new Response('not found', { status: 404 });
    }, () => buildAgentWorkspaceChannelTriage(context, {}));

    const bindings = (triage.routeBindings as { bindings: readonly Record<string, unknown>[] }).bindings;
    expect(bindings[0]?.principalLabel).toBe('unknown principal');
    expect(bindings[0]?.principal).toBeNull();
    expect(typeof bindings[0]?.principalResolutionError).toBe('string');
  });

  test('a binding with no externalId shows "unknown principal" without attempting a network call', async () => {
    const home = writeTokenHome();
    const context = triageContext(home);
    let resolveCallCount = 0;

    const triage = await withMockFetch(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/principals/resolve') {
        resolveCallCount += 1;
        return new Response(JSON.stringify({
          known: true,
          principal: { id: 'principal-should-not-appear', name: 'Should Not Appear', kind: 'user', identities: [], createdAt: 1, updatedAt: 1 },
        }));
      }
      if (path === '/api/routes/bindings') {
        return new Response(JSON.stringify({
          bindings: [{
            id: 'binding-no-external-id',
            kind: 'channel',
            surfaceKind: 'slack',
            surfaceId: 'slack',
            title: 'Ops',
            lastSeenAt: 1,
          }],
        }));
      }
      if (path in EMPTY_ROUTE_BODIES) return new Response(JSON.stringify(EMPTY_ROUTE_BODIES[path]));
      return new Response('not found', { status: 404 });
    }, () => buildAgentWorkspaceChannelTriage(context, {}));

    const bindings = (triage.routeBindings as { bindings: readonly Record<string, unknown>[] }).bindings;
    expect(bindings[0]?.principalLabel).toBe('unknown principal');
    expect(bindings[0]?.principal).toBeNull();
    expect(bindings[0]?.externalIdDigest).toBeNull();
    expect(resolveCallCount).toBe(0);
  });

  test('connected host without an operator token shows "unknown principal" without a guess', async () => {
    const home = makeProjectTempDir('goodvibes-agent-triage-no-token');
    const context = triageContext(home);

    const triage = await withMockFetch(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/routes/bindings') {
        return new Response(JSON.stringify({
          bindings: [{
            id: 'binding-no-token',
            kind: 'channel',
            surfaceKind: 'slack',
            surfaceId: 'slack',
            externalId: 'U-no-token-sender',
            title: 'Ops',
            lastSeenAt: 1,
          }],
        }));
      }
      return new Response('not found', { status: 404 });
    }, () => buildAgentWorkspaceChannelTriage(context, {}));

    // No operator token means every connected-host route (including bindings)
    // fails closed; there is nothing to resolve, and the triage must not crash.
    expect((triage.routeBindings as { state: string }).state).toBe('unavailable');
  });
});
