/**
 * Quality gates (contract/gates.ts): skip
 * detection, command execution with its timeout, the gate runner over
 * `contract.gates` with CONTRACT_GATE_RESULT events, and failing-gate selection.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeEventBus } from '../../sdk/src/platform/runtime/events/index.js';
import type { ContractEvent } from '../../sdk/src/events/index.js';
import type { ContractConfigReader } from '../../sdk/src/platform/contract/config.js';
import {
  executeGateCommand,
  failedGates,
  getSkippedGateReason,
  loadPackageScripts,
  runContractGates,
  type QualityGate,
} from '../../sdk/src/platform/contract/gates.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'contract-gates-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function config(gates: readonly QualityGate[], gateTimeoutMs = 120_000): ContractConfigReader {
  const values: Record<string, unknown> = { gateTimeoutMs };
  return {
    get: (key: string): unknown => values[key.replace(/^contract\./, '')],
    getCategory: (name: string): unknown => (name === 'contract' ? { gates, gateTimeoutMs } : undefined),
  } as unknown as ContractConfigReader;
}

describe('skip detection', () => {
  test('each built-in gate is skipped when its tree lacks what it runs on', () => {
    expect(getSkippedGateReason('typecheck', dir, {})).toBe('Skipped: no tsconfig.json found');
    expect(getSkippedGateReason('lint', dir, {})).toBe('Skipped: no ESLint config found');
    expect(getSkippedGateReason('test', dir, {})).toBe('Skipped: no test script in package.json');
    expect(getSkippedGateReason('build', dir, {})).toBe('Skipped: no build script in package.json');
  });

  test('each built-in gate applies once its tree has what it runs on', () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    writeFileSync(join(dir, 'eslint.config.js'), 'export default [];');
    expect(getSkippedGateReason('typecheck', dir, {})).toBeNull();
    expect(getSkippedGateReason('lint', dir, {})).toBeNull();
    expect(getSkippedGateReason('test', dir, { test: 'bun test' })).toBeNull();
    expect(getSkippedGateReason('build', dir, { build: 'tsc' })).toBeNull();
  });

  test('a custom gate always applies', () => {
    expect(getSkippedGateReason('format', dir, {})).toBeNull();
  });

  test('package scripts are read from package.json, and an unreadable one gives none', async () => {
    expect(await loadPackageScripts(dir)).toEqual({});
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }));
    expect(await loadPackageScripts(dir)).toEqual({ test: 'bun test' });
    writeFileSync(join(dir, 'package.json'), '{ not json');
    expect(await loadPackageScripts(dir)).toEqual({});
  });
});

describe('executeGateCommand', () => {
  test('exit zero passes with stdout and stderr joined', async () => {
    const result = await executeGateCommand('echo out; echo err 1>&2', dir);
    expect(result.passed).toBe(true);
    expect(result.output).toBe('out\n\nerr');
  });

  test('a non-zero exit fails', async () => {
    const result = await executeGateCommand('echo broken; exit 3', dir);
    expect(result.passed).toBe(false);
    expect(result.output).toBe('broken');
  });

  test('the command runs in the given directory', async () => {
    const result = await executeGateCommand('pwd', dir);
    expect(result.output.endsWith(dir.split('/').pop()!)).toBe(true);
  });

  test('a command past its timeout is stopped and fails, saying so', async () => {
    const started = Date.now();
    const result = await executeGateCommand('sleep 5', dir, 100);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(result.passed).toBe(false);
    expect(result.output).toContain('Gate timed out after 100 ms');
  });

  test('the deadline still stops descendants after their shell exits', async () => {
    const started = Date.now();
    const result = await executeGateCommand('sleep 5 &', dir, 100);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(result.passed).toBe(false);
    expect(result.output).toContain('Gate timed out after 100 ms');
  });

  test('a timed-out descendant cannot ignore termination and keep changing the worktree', async () => {
    const result = await executeGateCommand("sh -c 'trap \"\" TERM; sleep 0.3; touch escaped' & wait", dir, 50);
    expect(result.passed).toBe(false);
    await Bun.sleep(400);
    expect(existsSync(join(dir, 'escaped'))).toBe(false);
  });

  test('stdout and stderr are drained while a large-output gate is running', async () => {
    const result = await executeGateCommand("bun -e 'process.stdout.write(\"x\".repeat(262144)); process.stderr.write(\"y\".repeat(262144))'", dir, 4_000);
    expect(result.passed).toBe(true);
    expect(result.output).toBe(`${'x'.repeat(262144)}\n${'y'.repeat(262144)}`);
  });
});

describe('runContractGates', () => {
  test('runs enabled gates in order, records skips as passes, and emits a result event for each', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: {} }));
    const bus = new RuntimeEventBus();
    const events: ContractEvent[] = [];
    const off = bus.onDomain('contracts', (envelope) => {
      events.push(envelope.payload);
    });
    const seen: string[] = [];
    const results = await runContractGates({
      configManager: config([
        { name: 'test', command: 'exit 1', enabled: true },
        { name: 'custom', command: 'echo fine', enabled: true },
        { name: 'broken', command: 'echo bad; exit 2', enabled: true },
        { name: 'off', command: 'exit 1', enabled: false },
      ]),
      cwd: dir,
      runtimeBus: bus,
      sessionId: 's1',
      contractId: 'ctr-0a1b2c3d',
      targetId: 'u1',
      onResult: (_all, result) => seen.push(result.gate),
    });
    await Bun.sleep(10);
    off();

    expect(results.map((result) => [result.gate, result.passed, result.skipped])).toEqual([
      ['test', true, true],
      ['custom', true, false],
      ['broken', false, false],
    ]);
    expect(results[0]!.output).toBe('Skipped: no test script in package.json');
    expect(seen).toEqual(['test', 'custom', 'broken']);
    expect(events).toEqual([
      { type: 'CONTRACT_GATE_RESULT', contractId: 'ctr-0a1b2c3d', targetId: 'u1', gate: 'test', passed: true, skipped: true, durationMs: 0, occurrenceId: expect.any(String) },
      expect.objectContaining({ type: 'CONTRACT_GATE_RESULT', gate: 'custom', passed: true, skipped: false }),
      expect.objectContaining({ type: 'CONTRACT_GATE_RESULT', gate: 'broken', passed: false, skipped: false }),
    ]);
    expect(events.every((event) => typeof event.occurrenceId === 'string' && event.occurrenceId.trim().length > 0)).toBe(true);
    expect(new Set(events.map((event) => event.occurrenceId)).size).toBe(3);
    expect(failedGates(results).map((result) => result.gate)).toEqual(['broken']);
  });

  test('uses contract.gateTimeoutMs for each gate', async () => {
    const results = await runContractGates({
      configManager: config([{ name: 'slow', command: 'sleep 5', enabled: true }], 100),
      cwd: dir,
      runtimeBus: new RuntimeEventBus(),
      sessionId: 's1',
      contractId: 'ctr-0a1b2c3d',
      targetId: 'u1',
    });
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.output).toContain('timed out after 100 ms');
  });

  test('no enabled gates runs nothing', async () => {
    const results = await runContractGates({
      configManager: config([{ name: 'off', command: 'exit 1', enabled: false }]),
      cwd: dir,
      runtimeBus: new RuntimeEventBus(),
      sessionId: 's1',
      contractId: 'ctr-0a1b2c3d',
      targetId: 'u1',
    });
    expect(results).toEqual([]);
  });

  test('failedGates never counts a skipped gate', () => {
    expect(failedGates([{ gate: 'x', passed: false, output: '', durationMs: 0, skipped: true }])).toEqual([]);
    expect(failedGates(undefined)).toEqual([]);
  });
});
