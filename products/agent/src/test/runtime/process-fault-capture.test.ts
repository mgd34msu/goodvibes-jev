/**
 * The gap this closes: the agent died on an uncaught exception and the stack
 * existed ONLY on the operator's terminal, nothing in the activity log, no
 * crash file. The process registered no `uncaughtException` handler at all, so
 * the one path that actually kills the agent recorded nothing.
 *
 * The core assertion runs against a REAL child process that raises a REAL
 * uncaught exception, because the defect was never "the write function is
 * wrong", it was "nothing runs on the way out".
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { createProcessFaultHandlers } from '../../runtime/process-fault-capture.ts';
// The record builder, reader and bounded appender are the SDK's now, the agent
// carried a copy only until the export was published. These assertions are
// unchanged: they still describe what the agent's crash log must contain, and
// they now run against the implementation that actually writes it.
import {
  appendCrashRecord,
  buildCrashRecord,
  CRASH_LOG_FILENAME,
  CRASH_LOG_MAX_RECORDS,
  readCrashRecords,
} from '@goodvibes-jev/engine/sdk/platform/runtime/operations';

function tempHome(): string {
  // The repo's own helper: scratch directories live under the project, not
  // os.tmpdir(), and are swept by the shared teardown.
  return makeProjectTempDir('crash-capture');
}

const CONTEXT = { version: '2.0.8', surface: 'agent', sessionId: 'user-cd11b528', pid: 4242 };

describe('a child process that raises an injected fatal', () => {
  test('leaves a crash record on disk and a line in the activity log', () => {
    const home = tempHome();
    const probe = join(import.meta.dir, '..', 'fixtures', 'crash-capture-probe.ts');

    const result = spawnSync('bun', [probe, home], { encoding: 'utf-8', timeout: 60_000 });

    // The process died on the fault, and said so on a descriptor the
    // full-screen output guard cannot intercept.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('injected fatal from crash-capture-probe');

    // 1. The durable record, the five fields forensics needed and did not have.
    const records = readCrashRecords(join(home, '.goodvibes', 'agent', CRASH_LOG_FILENAME));
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.kind).toBe('uncaughtException');
    expect(record.message).toBe('injected fatal from crash-capture-probe');
    expect(record.stack).toContain('crash-capture-probe');
    expect(record.sessionId).toBe('user-cd11b528');
    expect(record.pid).toBeGreaterThan(0);
    expect(record.version.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
    expect(record.surface).toBe('agent');

    // 2. The activity log, flushed synchronously, the logger batches on a
    //    timer a dying process never reaches.
    const activity = readFileSync(join(home, '.goodvibes', 'logs', 'activity.md'), 'utf-8');
    expect(activity).toContain('uncaughtException');
    expect(activity).toContain('injected fatal from crash-capture-probe');
  }, 90_000);
});

describe('crash record', () => {
  test('survives exotic throw values rather than failing to report', () => {
    expect(buildCrashRecord('unhandledRejection', 'plain string', CONTEXT).message).toBe('plain string');
    expect(buildCrashRecord('unhandledRejection', undefined, CONTEXT).message).toBe('undefined');
    expect(buildCrashRecord('uncaughtException', { nope: 1 }, CONTEXT).stack).toBeNull();
    const hostile = new Proxy(new Error('x'), { get(): never { throw new Error('getter exploded'); } });
    expect(() => buildCrashRecord('uncaughtException', hostile, CONTEXT)).not.toThrow();
  });
});

describe('crash log: bounded and content-validated', () => {
  test('keeps the NEWEST records within the cap', () => {
    const path = join(tempHome(), CRASH_LOG_FILENAME);
    for (let i = 0; i < CRASH_LOG_MAX_RECORDS + 15; i++) {
      appendCrashRecord(path, buildCrashRecord('uncaughtException', new Error(`crash-${i}`), {
        ...CONTEXT,
        sessionId: `session-${'p'.repeat(900)}-${i}`,
      }));
    }
    const records = readCrashRecords(path);
    expect(records.length).toBeLessThanOrEqual(CRASH_LOG_MAX_RECORDS);
    expect(records[records.length - 1]!.message).toBe(`crash-${CRASH_LOG_MAX_RECORDS + 14}`);
  });

  test('a torn final line does not cost the records before it', () => {
    const path = join(tempHome(), CRASH_LOG_FILENAME);
    appendCrashRecord(path, buildCrashRecord('uncaughtException', new Error('first'), CONTEXT));
    appendCrashRecord(path, buildCrashRecord('unhandledRejection', new Error('second'), CONTEXT));
    // Crashing mid-write is the NORMAL way this file ends.
    writeFileSync(path, `${readFileSync(path, 'utf-8')}{"timestamp":"2026-08-05T22:2`);

    expect(readCrashRecords(path).map((entry) => entry.message)).toEqual(['first', 'second']);
  });

  test('a missing log reads as an empty history rather than throwing', () => {
    expect(readCrashRecords(join(tempHome(), 'never-written.jsonl'))).toEqual([]);
  });
});

describe('handler wiring', () => {
  test('an unhandledRejection is recorded but does NOT kill the process', () => {
    const home = tempHome();
    const exits: number[] = [];
    const faults = createProcessFaultHandlers({
      notifyHigh: () => {},
      render: () => {},
      shellPaths: { resolveUserPath: (...segments: string[]) => join(home, '.goodvibes', ...segments) },
      activeSessionId: () => 'user-abc',
      exit: (code) => { exits.push(code); },
      writeStderr: () => {},
    });

    faults.capture('unhandledRejection', new Error('rejected'));

    const records = readCrashRecords(join(home, '.goodvibes', 'agent', CRASH_LOG_FILENAME));
    expect(records).toHaveLength(1);
    expect(records[0]!.kind).toBe('unhandledRejection');
    expect(exits).toEqual([]);
  });

  test('dispose removes both listeners, so the orderly exit path leaves nothing armed', () => {
    const home = tempHome();
    const before = process.listenerCount('uncaughtException');
    const faults = createProcessFaultHandlers({
      notifyHigh: () => {},
      render: () => {},
      shellPaths: { resolveUserPath: (...segments: string[]) => join(home, '.goodvibes', ...segments) },
      activeSessionId: () => null,
      exit: () => {},
      writeStderr: () => {},
    });

    faults.register();
    expect(process.listenerCount('uncaughtException')).toBe(before + 1);
    faults.dispose();
    expect(process.listenerCount('uncaughtException')).toBe(before);
  });

  test('a broken session-id accessor still yields a record', () => {
    const home = tempHome();
    const faults = createProcessFaultHandlers({
      notifyHigh: () => {},
      render: () => {},
      shellPaths: { resolveUserPath: (...segments: string[]) => join(home, '.goodvibes', ...segments) },
      activeSessionId: () => { throw new Error('runtime torn down'); },
      exit: () => {},
      writeStderr: () => {},
    });

    faults.capture('uncaughtException', new Error('boom'));

    const records = readCrashRecords(join(home, '.goodvibes', 'agent', CRASH_LOG_FILENAME));
    expect(records).toHaveLength(1);
    expect(records[0]!.sessionId).toBeNull();
  });
});
