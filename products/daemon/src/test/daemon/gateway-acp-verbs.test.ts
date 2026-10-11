/**
 * acp.agents.list / acp.sessions.create over this daemon's own composition.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * These two verbs used to be pinned as KNOWN_STRANDED in
 * gateway-catalog-handler-or-route.test.ts: `registerAcpGatewayMethods` is
 * gated on `deps.acpHost` (register-gateway-verb-groups.ts), and
 * runtime/service-graph.ts threaded no ACP host, so both were cataloged,
 * advertised as invokable, and served by nothing. service-graph.ts now constructs
 * an AcpHostService (wired to the shared approval broker and shared session
 * broker, exactly like the SDK's own reference composition) and threads it
 * into the gateway verb group registration and the fleet registry.
 *
 * ── What this file does NOT do ────────────────────────────────────────────
 *
 * It never spawns a real third-party agent binary. `acp.agents.list`'s
 * discovery is real (read-only PATH/known-install-dir checks, see
 * discoverAcpAgents), so its result is asserted on SHAPE only: an empty list
 * is the honest, expected answer on a machine with no Claude Code / Codex /
 * opencode ACP adapter installed. `acp.sessions.create`'s refusal paths
 * (unauthenticated, missing/invalid fields) all return before the handler
 * ever calls discover() or host.spawnAgent(), so no process is launched here
 * either.
 */
import { describe, expect, test } from 'bun:test';
import { useGatewayFixture } from '../helpers/gateway-route-fixture.js';
const fixture = useGatewayFixture({ hostSessions: false });



interface Refusal {
  readonly code: string;
  readonly status: number;
}

/** Invoke a verb directly on the composed catalog and report the refusal it raised, or null if it answered. */
async function refusalOf(
  invoke: (methodId: string, invocation: { context: Record<string, unknown>; body?: unknown }) => Promise<unknown>,
  methodId: string,
  invocation: { context: Record<string, unknown>; body?: unknown },
): Promise<Refusal | null> {
  try {
    await invoke(methodId, invocation);
    return null;
  } catch (error) {
    const record = error as { code?: unknown; status?: unknown };
    return {
      code: typeof record.code === 'string' ? record.code : '',
      status: typeof record.status === 'number' ? record.status : 0,
    };
  }
}

const AUTHENTICATED = { context: { principalId: 'test-operator' } };
const UNAUTHENTICATED = { context: {} };

describe('acp.agents.list / acp.sessions.create over the composed daemon', () => {
  test('both verbs are cataloged and handler-attached, not a 501 facade', () => {
    const services = () => fixture().services;
    for (const id of ['acp.agents.list', 'acp.sessions.create']) {
      expect(services().gatewayMethods.get(id), `${id} is not cataloged`).toBeTruthy();
      expect(services().gatewayMethods.hasHandler(id), `${id} has no handler`).toBe(true);
    }
  });

  test('acp.agents.list answers a real discovery result over the composed graph; shape, not contents', async () => {
    const services = () => fixture().services;
    const result = await services().gatewayMethods.invoke('acp.agents.list', AUTHENTICATED) as {
      agents: readonly { id: string; title: string; binaryPath: string }[];
    };
    // Real discoverAcpAgents() runs read-only PATH/known-install-dir checks.
    // An empty list is the honest answer on a machine with nothing installed,
    // asserting the shape (an array, present) is what this composition owes,
    // not any particular agent being present.
    expect(Array.isArray(result.agents)).toBe(true);
  });

  test('acp.sessions.create refuses an unauthenticated caller', async () => {
    const services = () => fixture().services;
    const refusal = await refusalOf(
      (id, invocation) => services().gatewayMethods.invoke(id, invocation as never),
      'acp.sessions.create',
      { ...UNAUTHENTICATED, body: { agentId: 'claude-code', cwd: '/tmp' } },
    );
    expect(refusal).not.toBeNull();
    expect(refusal!.code).toBe('UNAUTHENTICATED');
    expect(refusal!.status).toBe(401);
  });

  test('acp.sessions.create refuses a missing agentId', async () => {
    const services = () => fixture().services;
    const refusal = await refusalOf(
      (id, invocation) => services().gatewayMethods.invoke(id, invocation as never),
      'acp.sessions.create',
      { ...AUTHENTICATED, body: { cwd: '/tmp' } },
    );
    expect(refusal).not.toBeNull();
    expect(refusal!.code).toBe('INVALID_ARGUMENT');
    expect(refusal!.status).toBe(400);
  });

  test('acp.sessions.create refuses a missing cwd', async () => {
    const services = () => fixture().services;
    const refusal = await refusalOf(
      (id, invocation) => services().gatewayMethods.invoke(id, invocation as never),
      'acp.sessions.create',
      { ...AUTHENTICATED, body: { agentId: 'claude-code' } },
    );
    expect(refusal).not.toBeNull();
    expect(refusal!.code).toBe('INVALID_ARGUMENT');
    expect(refusal!.status).toBe(400);
  });

  test('acp.sessions.create refuses a cwd that is not an existing directory', async () => {
    const services = () => fixture().services;
    const refusal = await refusalOf(
      (id, invocation) => services().gatewayMethods.invoke(id, invocation as never),
      'acp.sessions.create',
      { ...AUTHENTICATED, body: { agentId: 'claude-code', cwd: '/definitely/not/a/real/path/gv-acp-test' } },
    );
    expect(refusal).not.toBeNull();
    expect(refusal!.code).toBe('INVALID_ARGUMENT');
    expect(refusal!.status).toBe(400);
  });
});
