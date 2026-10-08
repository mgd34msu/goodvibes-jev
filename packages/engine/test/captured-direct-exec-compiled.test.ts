import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provideCapturedBunRuntime } from '../toolchain/src/lib/captured-bun-runtime.js';
import { realExec } from '../toolchain/src/lib/effects.js';
import { probeCapturedExecAvailability } from '../sdk/src/platform/tools/exec/captured-exec.js';
import type { runDirectExecContract } from './fixtures/captured-direct-exec-compiled-entry.js';

const availability = await probeCapturedExecAvailability();
if (process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT === '1' && !availability.available)
  throw new Error('required compiled direct exec containment backend is unavailable');

test.skipIf(!availability.available)('restored compiled contract executes Bun build/test first and reads generated members with its packaged runtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'captured-direct-exec-compiled-'));
  try {
    const binary = join(dir, 'compiled-product');
    const built = spawnSync(process.execPath, ['build', join(import.meta.dir, 'fixtures/captured-direct-exec-compiled-entry.ts'),
      '--compile', `--target=bun-${process.platform}-${process.arch}`, '--outfile', binary],
    { cwd: join(import.meta.dir, '..'), encoding: 'utf8', timeout: 120_000 });
    expect(built.status, built.stderr).toBe(0);
    provideCapturedBunRuntime({ root: dir, outDir: '.', artifacts: ['compiled-product'], target: {
      key: `linux-${process.arch}`, bunTarget: `bun-linux-${process.arch}`, appArtifact: 'compiled-product', capturedBunRuntime: '1.3.14',
    }, exec(command, args, options) {
      // This test exercises the existing build/runtime artifact, never a
      // downloaded replacement or an alternate interpreter startup mode.
      if (command === 'npm') throw new Error('compiled direct exec acceptance must not download a runtime');
      return realExec(command, args, options);
    } });
    const archive = join(dir, 'compiled-product.tar');
    const packed = spawnSync('tar', ['-cf', archive, '-C', dir, 'compiled-product',
      'compiled-product.bun', 'compiled-product.bun.LICENSE.md', 'compiled-product.bun.json'], { encoding: 'utf8' });
    expect(packed.status, packed.stderr).toBe(0);
    const restored = join(dir, 'restored'); mkdirSync(restored);
    const unpacked = spawnSync('tar', ['-xf', archive, '--no-same-owner', '-C', restored], { encoding: 'utf8' });
    expect(unpacked.status, unpacked.stderr).toBe(0);
    const restoredBinary = join(restored, 'compiled-product');
    expect(existsSync(restoredBinary + '.bun.LICENSE.md')).toBe(true);
    expect(JSON.parse(readFileSync(restoredBinary + '.bun.json', 'utf8'))).toMatchObject({ version: '1.3.14', target: `linux-${process.arch}` });
    const run = spawnSync(restoredBinary, [], {
      cwd: restored, encoding: 'utf8', timeout: 90_000,
      env: { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir, CAPTURED_DIRECT_EXEC_PARENT: 'PRESERVED_NONCREDENTIAL', CAPTURE_DIRECT_EXEC_TOKEN: 'SYNTHETIC_WITHHELD_CREDENTIAL' },
      maxBuffer: 8 * 1024 * 1024,
    });
    expect(run.status, JSON.stringify({ stdout: run.stdout, stderr: run.stderr, error: run.error })).toBe(0);
    const proof = JSON.parse(run.stdout) as Awaited<ReturnType<typeof runDirectExecContract>>;
    expect(proof.execPath).toBe(restoredBinary);
    expect(proof.runtimeExecutable).toBe(restoredBinary + '.bun');
    expect(proof.parentMode).toBeNull();
    expect(proof.status, JSON.stringify(proof)).toBe('passed');
    expect(proof.storedDenial).toBe(true);
    expect(proof.originalReadAccess).toBe('restricted');
    expect(proof.approvalCalls).toBe(0);
    expect(proof.plannerCalls).toBe(1);
    expect(proof.memberCalls).toBe(3);
    expect(proof.executed, JSON.stringify(proof.requests.flatMap(request => request.messages)
      .find(message => message.role === 'tool' && message.name === 'exec'))).toEqual([{ name: 'exec', success: true }, { name: 'read', success: true }]);
    expect(proof.memberRoot).not.toBe(proof.ownerRoot);
    expect(proof.ownerGeneratedDuringExec).toBe(false);
    expect(proof.ownerValue).toContain('LATE_OWNER_DIRECT_EXEC_VALUE');
    expect(JSON.parse(proof.generated!)).toEqual({
      value: 'DIRTY_CAPTURED_DIRECT_EXEC_VALUE', configuredType: 'PROJECT_LOADER_OK', configValue: 'PROJECT_CONFIG_OK',
      startupOrder: ['first', 'second'], denied: ['DENIED_READ', 'DENIED_READ', 'DENIED_IMPORT'],
      mode: null, ambient: 'PRESERVED_NONCREDENTIAL', credential: null, ownerVisible: false, hostVisible: false, networkBlocked: true,
    });
    expect(proof.generatedSource).toContain('DIRTY_CAPTURED_DIRECT_EXEC_VALUE');
    const messages = proof.requests.filter((request) => !request.planner).flatMap((request) => request.messages);
    const exec = messages.find((message) => message.role === 'tool' && message.name === 'exec' && message.callId === 'direct-exec-step-1');
    expect(JSON.parse(String(exec?.content))).toMatchObject({ success: true, sandboxed: true, exit_code: 0, stdout: expect.stringContaining('DIRECT_EXEC_BUILD_TEST_OK') });
    const readback = messages.find((message) => message.role === 'tool' && message.name === 'read' && message.callId === 'direct-exec-step-2');
    expect(String(readback?.content)).toContain('DIRTY_CAPTURED_DIRECT_EXEC_VALUE');
    expect(String(readback?.content)).toContain('PROJECT_CONFIG_OK');
    expect(String(readback?.content)).toContain('PROJECT_LOADER_OK');
    for (const request of proof.requests) {
      expect(request.text).not.toContain('PRIVATE_DIRECT_EXEC_SOURCE_BYTES');
      expect(request.text).not.toContain('SYNTHETIC_WITHHELD_CREDENTIAL');
      expect(request.text).not.toContain('LATE_OWNER_DIRECT_EXEC_VALUE');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 240_000);
