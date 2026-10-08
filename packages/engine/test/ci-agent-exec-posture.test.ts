/** CI dispatch proof only; the selected Agent tests exercise the real sandbox. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runOwnedTestChild } from '../scripts/owned-test-child.ts';
import { RUNNER_ENV_FLAG } from '../scripts/test-run-tmp.ts';

const root = resolve(import.meta.dir, '../../..');
interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
  readonly if?: unknown;
  readonly 'continue-on-error'?: unknown;
}
interface Job {
  readonly 'runs-on': string;
  readonly 'timeout-minutes': number;
  readonly strategy: { readonly matrix: { readonly lane: readonly string[] } };
  readonly steps: readonly Step[];
  readonly if?: unknown;
  readonly 'continue-on-error'?: unknown;
}
const workflow = Bun.YAML.parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')) as {
  readonly jobs: Record<string, Job>;
};
const job = workflow.jobs['exec-containment-proof']!;
const execution = job.steps.find(step => step.name === 'Require actual sandbox fixture execution')!;
const runner = 'packages/engine/scripts/test.ts';
const commands: Record<string, readonly string[]> = {
  tools: [runner, 'test/exec-interactive.test.ts', 'test/exec-sandbox.test.ts', 'test/exec-containment-proof.test.ts',
    'test/captured-exec.test.ts', 'test/captured-exec-modes.test.ts', 'test/captured-exec-file-ops.test.ts', 'test/captured-exec-runtime-input.test.ts', 'test/captured-edit-write.test.ts'],
  'direct-exec': [runner, 'test/contract/actual-direct-exec-input-authority.test.ts', 'test/captured-direct-exec-compiled.test.ts'],
  repl: [runner, 'test/captured-repl.test.ts', 'test/captured-repl-compiled.test.ts', 'test/captured-bun-runtime-input.test.ts',
    'test/contract/actual-repl-input-authority.test.ts', 'test/contract/actual-repl-run-history.test.ts', 'test/contract/actual-repl-history-cancellation.test.ts'],
  'graph-runtime': [runner, 'test/contract/actual-input-authority-graph.test.ts', 'test/contract/actual-edit-write-input-authority.test.ts', 'test/contract/actual-validator-runtime.test.ts', 'test/captured-passive-context-pipeline.test.ts'],
  'agent-posture': [runner, '--cwd', '../../products/agent', './src/test/tools/owner-terminal-guard.test.ts',
    './src/test/runtime/exec-cancellation-wrappers.test.ts', './src/test/tools/tool-execution-safety.test.ts'],
  repair: [runner, 'test/captured-auto-heal-candidate.test.ts', 'test/captured-auto-heal-revision.test.ts', 'test/captured-auto-heal.test.ts',
    'test/captured-auto-heal-backend-isolation.test.ts', 'test/captured-auto-heal-rollback.test.ts', 'test/contract/actual-captured-auto-heal.test.ts'],
  'repair-runtime': [runner, 'test/captured-auto-heal-real-tools.test.ts'],
};

test('ordinary Agent posture joins the existing required unprivileged containment job', () => {
  expect(job['runs-on']).toBe('ubuntu-22.04');
  expect(job['timeout-minutes']).toBe(10);
  expect(job.strategy.matrix.lane).toEqual(Object.keys(commands));
  expect(job.if).toBeUndefined();
  expect(job['continue-on-error']).toBeUndefined();
  expect(execution.env?.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT).toBe('1');
  expect(execution.if).toBeUndefined();
  expect(execution['continue-on-error']).toBeUndefined();
  const provision = job.steps.find(step => step.name === 'Install official sandbox and PTY packages')!;
  expect(job.steps.indexOf(provision)).toBeLessThan(job.steps.indexOf(execution));
  expect(provision.run).toContain('bwrap --ro-bind / / --proc /proc --dev /dev --unshare-net /bin/true');
  expect(provision.run).toContain('verify_host');
  expect(execution.run).not.toMatch(/\bsudo\b|\bsysctl\b|\bapparmor\b|--privileged/);
});

for (const [lane, expected] of Object.entries(commands)) {
  for (const status of [0, 37]) {
    test(`${lane} dispatch preserves exact files and propagates runner status ${status}`, () => {
      const scratch = mkdtempSync(join(tmpdir(), 'ci-agent-posture-dispatch-'));
      const bin = join(scratch, 'bin');
      const args = join(scratch, 'args');
      const required = join(scratch, 'required');
      mkdirSync(bin);
      writeFileSync(join(bin, 'bun'), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$ARGV_TRACE"\nprintf "%s" "$GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT" >> "$REQUIRED_TRACE"\nexit "$FIXTURE_STATUS"\n', { mode: 0o755 });
      try {
        const script = execution.run!.replace('${{ matrix.lane }}', lane);
        const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
          cwd: root,
          env: { ...process.env, ...execution.env, PATH: `${bin}:${process.env.PATH ?? ''}`,
            ARGV_TRACE: args, REQUIRED_TRACE: required, FIXTURE_STATUS: String(status) },
          encoding: 'utf8', timeout: 5_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(status);
        expect(readFileSync(args, 'utf8').trimEnd().split('\n')).toEqual([...expected]);
        expect(readFileSync(required, 'utf8')).toBe('1');
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    });
  }
}

test('unknown containment lane fails without invoking any runner', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'ci-agent-posture-unknown-'));
  const marker = join(scratch, 'ran');
  writeFileSync(join(scratch, 'bun'), '#!/bin/sh\nprintf ran > "$MARKER"\n', { mode: 0o755 });
  try {
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c',
      execution.run!.replace('${{ matrix.lane }}', 'unknown-fixture')], {
      cwd: root, env: { ...process.env, ...execution.env, PATH: scratch, MARKER: marker }, timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});


test('required containment flag reaches the actual Agent child after isolation and preload', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'ci-agent-posture-environment-'));
  const fixture = join(scratch, 'required-environment.test.ts');
  const marker = join(scratch, 'proved');
  writeFileSync(fixture, `
    import { expect, test } from 'bun:test';
    import { writeFileSync } from 'node:fs';
    test('the required Agent fixture receives its actual environment', () => {
      expect(process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT).toBe('1');
      expect(process.env[${JSON.stringify(RUNNER_ENV_FLAG)}]).toBe('1');
      expect(process.cwd()).toBe(${JSON.stringify(join(root, 'products/agent'))});
      expect(process.env.TMPDIR).toContain('gv-agent-test-run-');
      expect(process.env.GOODVIBES_DAEMON_HOME).toContain('goodvibes-agent-test-daemon-home-');
      expect(process.env.TZ).toBe('UTC');
      writeFileSync(${JSON.stringify(marker)}, 'required Agent preload observed');
    });
  `);
  try {
    // scripts/test.ts supplies these same arguments/environment to its owned
    // child. Call that owner directly here to avoid taking its workspace lock
    // recursively while this regression itself runs under scripts/test.ts.
    const result = await runOwnedTestChild({
      argv: ['--cwd', '../../products/agent', fixture],
      cwd: join(root, 'packages/engine'),
      env: { ...process.env, ...execution.env, [RUNNER_ENV_FLAG]: '1' },
      ceilingMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('required Agent preload observed');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
