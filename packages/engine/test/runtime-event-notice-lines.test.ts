/** Drive the real producers: recognize their lines without inventing occurrence identity. */
import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { createEventEnvelope } from '../sdk/src/platform/runtime/event-envelope.js';
import { emitContractEvent } from '../sdk/src/platform/contract/events.js';
import { registerHostRuntimeEvents, runtimeEventKey, runtimeEventOfNotice } from '../sdk/src/platform/runtime/bootstrap-runtime-events.js';
import type { ContractEvent } from '../sdk/src/events/contract.js';
import { SAMPLES, ALL_CONTRACT_EVENTS } from './contract/event-samples.js';

function harness() {
  const lines: string[] = [];
  const bus = new RuntimeEventBus();
  const record = { id: 'agent-b6834750', template: 'engineer', task: 'Cap the "retry" delay\nand add a test', status: 'completed', startedAt: 0, completedAt: 51_000, toolCallCount: 3 };
  const { unsubs, agentStatusIntervalRef } = registerHostRuntimeEvents({
    runtimeBus: bus,
    domainDispatch: new Proxy({}, { get: () => () => {} }) as never,
    getSystemMessageRouter: () => ({ low: (m) => lines.push(m), high: (m) => lines.push(m), contract: (m) => lines.push(m) }),
    requestRender: () => {},
    agentManager: { getStatus: () => record, listByCohort: () => [], list: () => [] } as never,
    contractRunner: { get: () => null, list: () => [] },
  });
  return { bus, lines, stop() {
    for (const unsub of unsubs) unsub();
    if (agentStatusIntervalRef.value) clearInterval(agentStatusIntervalRef.value);
  } };
}

const ctx = { sessionId: 't', traceId: 't', source: 't' };

async function contractNotice(event: ContractEvent) {
  const h = harness();
  try {
    emitContractEvent(h.bus, 't', event);
    await Promise.resolve();
    expect(h.lines).toHaveLength(1);
    const notice = runtimeEventOfNotice(h.lines[0]!);
    expect(notice?.type).toBe(event.type);
    expect(notice?.detail.startsWith('[')).toBe(false);
    return notice!;
  } finally { h.stop(); }
}

describe('runtime event notices', () => {
  for (const type of ['AGENT_COMPLETED', 'AGENT_FAILED'] as const) {
    test(`${type} keeps its multiline operator line without claiming complete occurrence identity`, async () => {
      const h = harness();
      const payload = { type, agentId: 'agent-b6834750', durationMs: 51_000, error: 'quota refused\ntry again' };
      try {
        h.bus.emit('agents', createEventEnvelope(type, payload, ctx));
        await Promise.resolve();
        expect(h.lines).toHaveLength(1);
        const notice = runtimeEventOfNotice(h.lines[0]!);
        expect(notice?.type).toBe(type);
        expect(notice?.title).toBe(type === 'AGENT_COMPLETED' ? 'Agent finished' : 'Agent failed');
        expect(notice?.level).toBe(type === 'AGENT_COMPLETED' ? 'info' : 'warning');
        expect(notice?.key).toBeUndefined();
        expect(runtimeEventKey(type, payload)).toBeUndefined();
        expect(notice?.detail).toContain('"retry" delay\n');
      } finally { h.stop(); }
    });
  }

  for (const type of ['CONTRACT_PASSED', 'CONTRACT_FAILED', 'CONTRACT_CANCELLED', 'CONTRACT_COMMITTED'] as const) {
    test(`${type} retains the full contract id in detail without claiming occurrence identity`, async () => {
      const event = { ...SAMPLES[type], contractId: 'ctr-1234567890-common-prefix-first' };
      const notice = await contractNotice(event);
      expect(notice.detail).toContain(event.contractId);
      expect(notice.key).toBeUndefined();
      expect(runtimeEventKey(type, event)).toBeUndefined();
      const other = await contractNotice({ ...event, contractId: 'ctr-1234567890-common-prefix-second' });
      expect(other.detail).toContain('ctr-1234567890-common-prefix-second');
      expect(other.detail).not.toBe(notice.detail);
    });
  }

  test('every emitted contract line is recognized; incomplete repeated-event identities stay keyless', async () => {
    const lineTypes = new Set([
      'CONTRACT_CREATED', 'CONTRACT_STATUS_CHANGED', 'CONTRACT_CHECKED', 'CONTRACT_NUDGED',
      'CONTRACT_CRITERION_REGRESSED', 'CONTRACT_STALLED', 'CONTRACT_ESCALATED', 'CONTRACT_GATE_RESULT',
    ]);
    for (const event of ALL_CONTRACT_EVENTS.filter((event) => lineTypes.has(event.type))) {
      const notice = await contractNotice(event);
      expect(notice.key).toBeUndefined();
      expect(runtimeEventKey(event.type, event)).toBeUndefined();
    }
  });

  for (const [status, title, level] of [
    ['committed', 'Changes committed', 'info'], ['applied', 'Changes applied', 'info'],
    ['skipped', 'Commit skipped', 'info'], ['failed', 'Commit failed', 'warning'],
  ] as const) {
    test(`commit ${status} keeps the actual result and its multiline detail`, async () => {
      const note = 'Hook refused: lint\nNo commit was created.';
      const notice = await contractNotice({ ...SAMPLES.CONTRACT_COMMITTED, hash: undefined, status, note });
      expect(notice.title).toBe(title);
      expect(notice.level).toBe(level);
      expect(notice.detail).toContain(note);
      expect(notice.key).toBeUndefined();
      expect(runtimeEventKey('CONTRACT_COMMITTED', SAMPLES.CONTRACT_COMMITTED)).toBeUndefined();
    });
  }

  for (const [passed, skipped, title, level] of [
    [true, false, 'Quality check passed', 'info'], [false, false, 'Quality check failed', 'warning'],
    [true, true, 'Quality check skipped', 'info'], [false, true, 'Quality check skipped', 'info'],
  ] as const) {
    test(`gate passed=${passed}, skipped=${skipped} preserves the declared result`, async () => {
      const notice = await contractNotice({ ...SAMPLES.CONTRACT_GATE_RESULT, passed, skipped });
      expect(notice.title).toBe(title);
      expect(notice.level).toBe(level);
      expect(notice.key).toBeUndefined();
    });
  }

  for (const result of ['pass', 'nudge', 'await-owner', 'stall'] as const) {
    test(`check result ${result} is recognized`, async () => {
      const notice = await contractNotice({ ...SAMPLES.CONTRACT_CHECKED, result });
      expect(notice.level).toBe(result === 'pass' ? 'info' : 'warning');
    });
  }

  test('record-only checks are silent, and unrelated or legacy lines are left alone', async () => {
    const h = harness();
    try {
      emitContractEvent(h.bus, 't', { ...SAMPLES.CONTRACT_CHECKED, result: 'recorded' });
      await Promise.resolve();
      expect(h.lines).toHaveLength(0);
    } finally { h.stop(); }
    for (const line of ['', 'Compaction finished', '[Contract] custom prose', '[Contract] ctr-a invented -> imaginary', '[WRFC] ✓ Chain wrfc-1 PASSED — all gates clear', '[Agents] Cohort work complete', '[Agents] 2 running:\nagent-1']) {
      expect(runtimeEventOfNotice(line)).toBeUndefined();
    }
  });

  test('payloads without a typed event identity have no key', () => {
    for (const payload of [null, undefined, 0, false, 'agent-a', [], {}, { agentId: '' }, { agentId: 12 }, { contractId: 'ctr-a' }]) {
      expect(runtimeEventKey('AGENT_COMPLETED', payload)).toBeUndefined();
    }
    for (const payload of [{ contractId: '' }, { contractId: 12 }, { chainId: 'ctr-a' }, { agentId: 'agent-a' }]) {
      expect(runtimeEventKey('CONTRACT_PASSED', payload)).toBeUndefined();
    }
    expect(runtimeEventKey('UNKNOWN_EVENT', { contractId: 'ctr-a' })).toBeUndefined();
    expect(runtimeEventKey('CONTRACT_CREATED', SAMPLES.CONTRACT_CREATED)).toBeUndefined();
  });

  test('surrounding whitespace is trimmed without removing the event detail', () => {
    expect(runtimeEventOfNotice(' \n[Contract] ✓ ctr-a PASSED: 2 of 2 criteria met, 0 corrections\n ')?.detail)
      .toBe('ctr-a PASSED: 2 of 2 criteria met, 0 corrections');
  });
});


test('a notice key requires matching declared provenance, never a guessed id or altered text', () => {
  const line = '[Contract] ✓ ctr-a PASSED: 2 of 2 criteria met, 0 corrections';
  const provenance = { type: 'CONTRACT_PASSED', occurrenceId: 'producer-occurrence' };
  expect(runtimeEventOfNotice(line, provenance)?.key).toBe(runtimeEventKey(provenance.type, provenance));
  for (const occurrenceId of ['', ' ', null, 1]) {
    expect(runtimeEventKey(provenance.type, { ...provenance, occurrenceId })).toBeUndefined();
  }
  expect(runtimeEventOfNotice(line, { ...provenance, type: 'CONTRACT_FAILED' })?.key).toBeUndefined();
  expect(runtimeEventOfNotice(line)?.key).toBeUndefined();
  expect(runtimeEventOfNotice('[Contract] arbitrary prose', provenance)).toBeUndefined();
});
