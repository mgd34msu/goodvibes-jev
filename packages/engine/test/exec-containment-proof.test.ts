import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecContainmentProof, execContainmentRequired, skipExecContainment, EXEC_CONTAINMENT_FIXTURES } from './_helpers/exec-containment-proof.ts';

const supported = {
  pty: { available: true, reason: 'PTY available' },
  sandbox: { available: true, bwrapPath: '/usr/bin/bwrap', reason: 'bubblewrap available', networkIsolationGuaranteed: true },
};

describe('required exec containment proof', () => {
  test('only an unset flag opts out; malformed required flags fail closed', () => {
    expect(execContainmentRequired(undefined)).toBe(false);
    expect(execContainmentRequired('1')).toBe(true);
    for (const value of ['', '0', 'true', 'false', ' 1']) expect(() => execContainmentRequired(value)).toThrow();
  });

  test('missing PTY fails before fixtures and at final verification', () => {
    const proof = createExecContainmentProof(true, { ...supported, pty: { available: false, reason: 'no script' } });
    expect(() => proof.assertHost()).toThrow('no script');
    expect(() => proof.assertComplete()).toThrow('no script');
  });

  test('missing, unsupported, or unusable bubblewrap cannot satisfy required mode', () => {
    for (const reason of ['not found on PATH', 'unsupported platform', 'user namespace probe failed']) {
      const proof = createExecContainmentProof(true, { ...supported, sandbox: { ...supported.sandbox, available: false, reason } });
      expect(() => proof.assertHost()).toThrow(reason);
      expect(() => proof.assertComplete()).toThrow(reason);
    }
    const noPath = createExecContainmentProof(true, { ...supported, sandbox: { ...supported.sandbox, bwrapPath: undefined } });
    expect(() => noPath.assertHost()).toThrow();
  });

  test('optional fixture selection needs PTY, filesystem and network support; required mode never skips', () => {
    expect(skipExecContainment(false, supported)).toBe(false);
    expect(skipExecContainment(true, supported)).toBe(false);
    for (const host of [
      { ...supported, pty: { available: false, reason: 'no PTY' } },
      { ...supported, sandbox: { ...supported.sandbox, available: false } },
      { ...supported, sandbox: { ...supported.sandbox, bwrapPath: undefined } },
      { ...supported, sandbox: { ...supported.sandbox, networkIsolationGuaranteed: false } },
    ]) {
      expect(skipExecContainment(false, host)).toBe(true);
      expect(skipExecContainment(true, host)).toBe(false);
    }
  });

  test('working filesystem sandbox without proven network isolation still fails', () => {
    const proof = createExecContainmentProof(true, { ...supported, sandbox: { ...supported.sandbox, networkIsolationGuaranteed: false } });
    expect(() => proof.assertHost()).toThrow('network namespace isolation');
    for (const fixture of EXEC_CONTAINMENT_FIXTURES) proof.completed(fixture);
    expect(() => proof.assertComplete()).toThrow('network namespace isolation');
  });

  test('availability alone and each individual fixture leave the proof incomplete', () => {
    for (const fixture of EXEC_CONTAINMENT_FIXTURES) {
      const proof = createExecContainmentProof(true, supported);
      proof.assertHost();
      expect(() => proof.assertComplete()).toThrow('did not complete');
      proof.completed(fixture);
      expect(() => proof.assertComplete()).toThrow('did not complete');
      expect(() => proof.completed(fixture)).toThrow('Duplicate');
    }
  });

  test('required proof succeeds only after both distinct fixtures complete', () => {
    const proof = createExecContainmentProof(true, supported);
    for (const fixture of EXEC_CONTAINMENT_FIXTURES) proof.completed(fixture);
    expect(() => proof.assertComplete()).not.toThrow();
  });

  test('optional developer runs do not claim required proof on unsupported hosts', () => {
    const proof = createExecContainmentProof(false, { ...supported, pty: { available: false, reason: 'unsupported' } });
    expect(() => proof.assertHost()).not.toThrow();
    expect(() => proof.assertComplete()).not.toThrow();
  });

  test('the Bun afterAll proof makes early returns and thrown assertions nonzero', () => {
    const directory = mkdtempSync(join(tmpdir(), 'exec-containment-harness-'));
    try {
      const fixture = join(directory, 'proof.test.ts');
      // Synthetic host data tests the proof harness only. Positive live OS
      // containment is established exclusively by exec-interactive.test.ts.
      const helper = JSON.stringify(new URL('./_helpers/exec-containment-proof.ts', import.meta.url).href);
      for (const mode of ['early-return', 'one-completed', 'assertion-failed', 'complete']) {
        writeFileSync(fixture, [
          "import { afterAll, expect, test } from 'bun:test';",
          `import { createExecContainmentProof } from ${helper};`,
          `const proof = createExecContainmentProof(true, ${JSON.stringify(supported)});`,
          'afterAll(() => proof.assertComplete());',
          "test('synthetic filesystem fixture', () => {",
          mode === 'early-return' ? 'return;' : "proof.completed('filesystem-boundary');",
          '});',
          "test('synthetic answer fixture', () => {",
          mode === 'assertion-failed' ? 'expect(false).toBe(true);' : '',
          mode === 'complete' ? "proof.completed('sandboxed-answer');" : 'return;',
          '});',
        ].join('\n'));
        const result = spawnSync(process.execPath, ['--no-env-file', 'test', fixture], {
          env: process.env, encoding: 'utf8', timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(mode === 'complete' ? 0 : 1);
        if (mode !== 'complete') expect(result.stderr).toContain('Required exec containment fixtures did not complete');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
