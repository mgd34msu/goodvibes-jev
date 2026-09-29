/**
 * The run-start snapshot store behind `/replay load`: LocalLedgerExporter
 * stores the runtime state snapshot once per run id, on the run's first
 * recorded entry, next to the ledger file; handleReplayCommand loads it as the
 * replay baseline, and falls back to an empty baseline (and says so) only for
 * a run with no stored snapshot.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { LocalLedgerExporter } from '../sdk/src/platform/runtime/telemetry/exporters/local-ledger.ts';
import { DeterministicReplayEngine } from '../sdk/src/platform/core/deterministic-replay.ts';
import { handleReplayCommand } from '../sdk/src/platform/core/replay-command-handler.ts';
import type { RuntimeStateSnapshot } from '../sdk/src/platform/runtime/diagnostics/types.ts';

const GITHUB_TOKEN = 'ghp_0123456789012345678901234567890123456789';

let dir: string;
let previousPort: ReturnType<typeof installJudgmentPort>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-replay-snapshot-'));
  previousPort = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previousPort);
  rmSync(dir, { recursive: true, force: true });
});

function snapshotAt(capturedAt: number, turns: number): RuntimeStateSnapshot {
  return {
    capturedAt,
    domains: [{ domain: 'session', revision: turns, lastUpdatedAt: capturedAt, state: { turns } }],
  };
}

function ledgerPath(): string {
  return join(dir, 'run.ledger.jsonl');
}

function makeExporter(captureRunSnapshot?: () => RuntimeStateSnapshot): LocalLedgerExporter {
  return new LocalLedgerExporter({ filePath: join(dir, 'spans.jsonl'), ledgerFilePath: ledgerPath(), captureRunSnapshot });
}

function record(exporter: LocalLedgerExporter, runId: string, rev: number, payload: unknown = {}): void {
  exporter.recordEvent({ runId, rev, eventName: 'session:TURN_SUBMITTED', payload, ts: 1_700_000_000_000 + rev });
}

describe('run-start snapshot store', () => {
  test('the snapshot is captured once per run, on its first entry, and /replay load uses it as the baseline', async () => {
    let captures = 0;
    const exporter = makeExporter(() => snapshotAt(1_700_000_000_000 + captures, ++captures));
    record(exporter, 'run-a', 1);
    record(exporter, 'run-a', 2);
    record(exporter, 'run-b', 1);
    record(exporter, 'run-a', 3);
    await exporter.flush();

    expect(captures).toBe(2);
    expect(existsSync(`${ledgerPath()}.snapshots.jsonl`)).toBe(true);
    expect(exporter.readRunSnapshot('run-a')).toEqual(snapshotAt(1_700_000_000_000, 1));
    expect(exporter.readRunSnapshot('run-b')).toEqual(snapshotAt(1_700_000_000_001, 2));

    // A new exporter over the same files does not capture a run it already has.
    const reopened = makeExporter(() => {
      captures += 1;
      return snapshotAt(0, 99);
    });
    record(reopened, 'run-a', 4);
    await reopened.flush();
    expect(captures).toBe(2);

    const engine = new DeterministicReplayEngine(dir);
    const result = handleReplayCommand({ replayEngine: engine }, 'load', ['run-a'], reopened);
    expect(result.ok).toBe(true);
    expect(engine.getInitialSnapshot()).toEqual(snapshotAt(1_700_000_000_000, 1));
    expect(result.output).toContain('Baseline: state snapshot from run start (1 domain,');
    expect(result.output).not.toContain('recorded before');
  });

  test('a run with no stored snapshot replays from an empty baseline and the output says so', async () => {
    const exporter = makeExporter();
    record(exporter, 'old-run', 1);
    await exporter.flush();
    expect(exporter.readRunSnapshot('old-run')).toBeNull();

    const engine = new DeterministicReplayEngine(dir);
    const result = handleReplayCommand({ replayEngine: engine }, 'load', ['old-run'], exporter);
    expect(result.ok).toBe(true);
    expect(engine.getInitialSnapshot()).toEqual({ capturedAt: 1_700_000_000_001, domains: [] });
    expect(result.output).toContain('Baseline: empty (this run was recorded before run-start state snapshots were stored)');
  });

  test('the stored snapshot goes through the ledger at-rest redaction', async () => {
    const exporter = makeExporter(() => ({
      capturedAt: 1,
      domains: [{ domain: 'auth', revision: 1, lastUpdatedAt: 1, state: { note: `token ${GITHUB_TOKEN}` } }],
    }));
    record(exporter, 'run-c', 1);
    await exporter.flush();
    const raw = readFileSync(`${ledgerPath()}.snapshots.jsonl`, 'utf8');
    expect(raw).not.toContain(GITHUB_TOKEN);
    expect(raw).toContain('[REDACTED');
  });

  test('a failed capture is logged, not retried on the run\'s later events, and the entries are still recorded', async () => {
    let calls = 0;
    const exporter = makeExporter(() => {
      calls += 1;
      throw new Error('provider not ready');
    });
    record(exporter, 'run-d', 1);
    record(exporter, 'run-d', 2);
    await exporter.flush();
    expect(calls).toBe(1);
    expect(exporter.readRunSnapshot('run-d')).toBeNull();
    expect(exporter.readRunEntries('run-d')).toHaveLength(2);
  });
});
