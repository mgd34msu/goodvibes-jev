// The execution ledger hoisted from goodvibes-agent src/runtime/execution-ledger.ts.
// Its route kind is Jev's side-effect kind reading (the agent's tool-name
// keyword ladder is gone), answered here by a fake port. The reading is
// asynchronous, so these tests also pin that a call's later events are
// applied after its record exists, in order, and that a failed reading still
// records the call.
import { describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import {
  emitToolCancelled,
  emitToolFailed,
  emitToolPermissioned,
  emitToolReceived,
  emitToolSucceeded,
  type EmitterContext,
} from '../sdk/src/platform/runtime/emitters/index.ts';
import { AgentExecutionLedger, EXECUTION_LEDGER_SITE } from '../sdk/src/platform/gate/policy/execution-ledger.ts';
import { useGateReadings } from './_helpers/gate-readings.ts';

// Argument roles (engine.gate.ledger-arg) are asked with state { tool, argument },
// so their entries come first; the route-kind entries match the tool name.
const readings = useGateReadings([
  ['"argument":"apiKey"', { holds_credential: true }],
  ['"argument":"authorization"', { holds_credential: true }],
  ['"argument":"url"', { is_target: true }],
  ['"browser"', { kind: 'browser' }],
  ['"exec"', { kind: 'shell' }],
  ['"read"', { kind: 'read' }],
  ['"fetch"', { kind: 'network' }],
]);

const CTX: EmitterContext = { sessionId: 'session-1', traceId: 'trace-1', source: 'test' };

async function settle(ledger: AgentExecutionLedger): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await ledger.settled();
}

function received(bus: RuntimeEventBus, callId: string, tool: string, args: Record<string, unknown> = {}): void {
  emitToolReceived(bus, CTX, { callId, turnId: 'turn-1', tool, args });
}

describe('AgentExecutionLedger', () => {
  test('each record\'s route kind is Jev\'s reading of the call, asked at the ledger site', async () => {
    const bus = new RuntimeEventBus();
    const ledger = new AgentExecutionLedger(bus);
    received(bus, 'c1', 'browser', { action: 'click' });
    received(bus, 'c2', 'exec', { commands: [{ cmd: 'git status' }] });
    received(bus, 'c3', 'read', { files: [{ path: 'src/a.ts' }] });
    received(bus, 'c4', 'fetch', { urls: [{ url: 'https://example.org' }] });
    received(bus, 'c5', 'sleep', { seconds: 3 });
    await settle(ledger);

    const kinds = Object.fromEntries(ledger.getSnapshot().records.map((record) => [record.tool, record.routeKind]));
    expect(kinds).toEqual({ browser: 'browser', exec: 'shell', read: 'read', fetch: 'network', sleep: 'other' });
    const routeRequests = readings.requests.filter((request) => JSON.stringify(request.state).includes('"arguments"'));
    expect(routeRequests).toHaveLength(5);
    expect(JSON.stringify(routeRequests[0])).toContain(EXECUTION_LEDGER_SITE);
  });

  test('lifecycle events that arrive while the reading is pending apply after it, in order', async () => {
    const bus = new RuntimeEventBus();
    const ledger = new AgentExecutionLedger(bus);
    received(bus, 'c1', 'exec', { commands: [{ cmd: 'bun test' }] });
    emitToolPermissioned(bus, CTX, { callId: 'c1', turnId: 'turn-1', tool: 'exec', approved: true });
    emitToolSucceeded(bus, CTX, { callId: 'c1', turnId: 'turn-1', tool: 'exec', durationMs: 42, result: { kind: 'text', byteSize: 5, preview: 'ok' } });
    await settle(ledger);

    const [record] = ledger.getSnapshot().records;
    expect(record).toEqual(expect.objectContaining({
      callId: 'c1',
      routeKind: 'shell',
      status: 'succeeded',
      phase: 'TOOL_SUCCEEDED',
      permissionApproved: true,
      durationMs: 42,
      resultSummary: { kind: 'text', byteSize: 5, preview: 'ok' },
    }));
  });

  test('counts, newest first, failures and cancellations', async () => {
    const bus = new RuntimeEventBus();
    const ledger = new AgentExecutionLedger(bus);
    received(bus, 'a', 'read');
    received(bus, 'b', 'exec');
    received(bus, 'c', 'fetch');
    emitToolFailed(bus, CTX, { callId: 'b', turnId: 'turn-1', tool: 'exec', error: 'exit 1', durationMs: 3 });
    emitToolCancelled(bus, CTX, { callId: 'c', turnId: 'turn-1', tool: 'fetch', reason: 'user stopped it' });
    await settle(ledger);

    const snapshot = ledger.getSnapshot();
    expect(snapshot.records.map((record) => record.callId)).toEqual(['c', 'b', 'a']);
    expect([snapshot.total, snapshot.running, snapshot.failed, snapshot.cancelled, snapshot.succeeded]).toEqual([3, 1, 1, 1, 0]);
    expect(snapshot.records[1]?.error).toBe('exit 1');
    expect(snapshot.records[0]?.cancelReason).toBe('user stopped it');
  });

  test('declared credential input is withheld before readings and previews', async () => {
    const bus = new RuntimeEventBus();
    const ledger = new AgentExecutionLedger(bus);
    received(bus, 'c1', 'fetch', { url: 'https://api.example.org', apiKey: 'sk-live-123', headers: { authorization: 'Bearer x' } });
    await settle(ledger);

    const [record] = ledger.getSnapshot().records;
    expect(record?.argsPreview).not.toContain('sk-live-123');
    expect(record?.argsPreview).not.toContain('Bearer x');
    expect(record?.argsPreview).toContain('[redacted: protected input]');
    expect(record?.argsKeys).toEqual([]);
    expect(record?.targetPreview).toBeUndefined();
    expect(record?.routeKindError).toContain('Refused before judgment');
    expect(readings.requests).toEqual([]);
  });

  test('the ledger keeps the newest records up to its limit', async () => {
    const bus = new RuntimeEventBus();
    const ledger = new AgentExecutionLedger(bus, 2);
    for (const id of ['1', '2', '3']) received(bus, id, 'read');
    await settle(ledger);
    expect(ledger.getSnapshot().records.map((record) => record.callId)).toEqual(['3', '2']);
  });

  test('a failed reading still records the call, with the failure stated and no guessed kind', async () => {
    const bus = new RuntimeEventBus();
    const ledger = new AgentExecutionLedger(bus);
    const previous = installJudgmentPort(undefined);
    try {
      received(bus, 'c1', 'exec', { commands: [{ cmd: 'ls' }] });
      await settle(ledger);
    } finally {
      installJudgmentPort(previous);
    }
    const [record] = ledger.getSnapshot().records;
    expect(record?.routeKind).toBe('other');
    expect(record?.routeKindError).toContain('No judgment port is installed');
  });

  test('subscribers hear each change; dispose stops the ledger', async () => {
    const bus = new RuntimeEventBus();
    const ledger = new AgentExecutionLedger(bus);
    let notified = 0;
    ledger.subscribe(() => { notified += 1; });
    received(bus, 'c1', 'read');
    await settle(ledger);
    expect(notified).toBe(1);

    ledger.dispose();
    received(bus, 'c2', 'read');
    await settle(ledger);
    expect(ledger.getSnapshot().total).toBe(1);
  });
});
