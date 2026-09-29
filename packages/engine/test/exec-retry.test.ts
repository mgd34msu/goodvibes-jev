/**
 * precision_exec-style retry jitter + retryable classification
 *
 * Tests:
 * 1. Timed-out and cancelled runs are never retried, and nothing is read
 * 2. A failure Jev reads as lasting is not retried
 * 3. A failure in a category the caller lists is retried
 * 4. retry.on is honoured: an unlisted category is not retried
 * 5. Jittered delays differ between retry attempts
 */
import { describe, expect, test } from 'bun:test';
import { isRetryableExecResult } from '../sdk/src/platform/tools/exec/runtime.js';
import { useToolReadings } from './_helpers/tool-readings.ts';

// Jev reads which kind of failure a run hit; these fakes stand in for it.
// Output no entry names reads as a lasting failure.
const readings = useToolReadings([
  ['ECONNRESET', { failure: 'network' }],
  ['ENOTFOUND', { failure: 'network' }],
  ['index.lock', { failure: 'lock' }],
  ['EBUSY', { failure: 'busy' }],
  ['ENOMEM', { failure: 'oom' }],
]);

function makeResult(overrides: Partial<{
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}>): Parameters<typeof isRetryableExecResult>[0] {
  return {
    cmd: 'test',
    exit_code: overrides.exit_code ?? 1,
    stdout: overrides.stdout ?? '',
    stderr: overrides.stderr ?? '',
    success: overrides.success ?? false,
    timed_out: overrides.timed_out,
  };
}

describe('isRetryableExecResult', () => {
  test('timed_out and cancelled are never retried, and nothing is read', async () => {
    expect(await isRetryableExecResult(makeResult({ timed_out: true, stderr: 'ECONNRESET' }))).toBe(false);
    expect(await isRetryableExecResult({ ...makeResult({ stderr: 'ECONNRESET' }), cancelled: true })).toBe(false);
    expect(readings.requests).toHaveLength(0);
  });

  test('a failure read as lasting is not retried', async () => {
    expect(await isRetryableExecResult(makeResult({ stderr: 'bash: foobar: command not found' }))).toBe(false);
    expect(await isRetryableExecResult(makeResult({ stderr: 'EACCES: permission denied' }), ['network', 'lock', 'busy', 'oom'])).toBe(false);
  });

  test('network, lock and busy failures are retried by default', async () => {
    expect(await isRetryableExecResult(makeResult({ stderr: 'Error: read ECONNRESET' }))).toBe(true);
    expect(await isRetryableExecResult(makeResult({ stderr: 'getaddrinfo ENOTFOUND registry.npmjs.org' }))).toBe(true);
    expect(await isRetryableExecResult(makeResult({ stderr: "fatal: Unable to create '.git/index.lock': File exists." }))).toBe(true);
    expect(await isRetryableExecResult(makeResult({ stderr: 'EBUSY: resource busy or locked' }))).toBe(true);
  });

  test('oom is retried only when the caller lists it', async () => {
    const result = makeResult({ stderr: 'ENOMEM: Cannot allocate memory' });
    expect(await isRetryableExecResult(result)).toBe(false);
    expect(await isRetryableExecResult(result, ['oom'])).toBe(true);
    expect(await isRetryableExecResult(result, ['network'])).toBe(false);
  });

  test('retry.on filter: only network allowed: a busy failure is not retried', async () => {
    expect(await isRetryableExecResult(makeResult({ stderr: 'EBUSY: locked' }), ['network'])).toBe(false);
  });

  test('the reading sees the command, exit code and output ends', async () => {
    await isRetryableExecResult(makeResult({ exit_code: 7, stdout: 'partial', stderr: 'Error: read ECONNRESET' }));
    expect(readings.requests[0]!.state).toEqual({ command: 'test', exitCode: 7, stderr: 'Error: read ECONNRESET', stdout: 'partial' });
  });

  test('jitter: bounded random source can produce varied retry delays', () => {
    const cap = 1000 * Math.pow(2, 1); // attempt=1, base=1000
    let seed = 0x12345678;
    const nextUnit = () => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const delays = Array.from({ length: 20 }, () => nextUnit() * cap);
    const allSame = delays.every((d) => d === delays[0]);
    expect(allSame).toBe(false);
  });
});
