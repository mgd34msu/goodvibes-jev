import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provideCapturedBunRuntime } from '../toolchain/src/lib/captured-bun-runtime.js';
import { probeCapturedExecAvailability } from '../sdk/src/platform/tools/exec/captured-exec.js';

const availability = await probeCapturedExecAvailability();
if (process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT === '1' && !availability.available)
  throw new Error('required compiled captured REPL containment backend is unavailable');

test.skipIf(!availability.available)('restored compiled product evaluates captured JS/TS with packaged runtime, project config and nested programs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'captured-repl-compiled-'));
  try {
    const binary = join(dir, 'compiled-product');
    const built = spawnSync(process.execPath, ['build', join(import.meta.dir, 'fixtures/captured-repl-compiled-entry.ts'),
      '--compile', `--target=bun-${process.platform}-${process.arch}`, '--outfile', binary],
    { cwd: join(import.meta.dir, '..'), encoding: 'utf8', timeout: 120_000 });
    expect({ status: built.status, stderr: built.stderr }).toEqual({ status: 0, stderr: '' });
    provideCapturedBunRuntime({ root: dir, outDir: '.', artifacts: ['compiled-product'], target: {
      key: `linux-${process.arch}`, bunTarget: `bun-linux-${process.arch}`, appArtifact: 'compiled-product', capturedBunRuntime: '1.3.14',
    } });
    expect(existsSync(binary + '.bun.LICENSE.md')).toBe(true);
    expect(JSON.parse(readFileSync(binary + '.bun.json', 'utf8'))).toMatchObject({ version: '1.3.14', target: `linux-${process.arch}` });
    const archive = join(dir, 'compiled-product.tar');
    const packed = spawnSync('tar', ['-cf', archive, '-C', dir, 'compiled-product',
      'compiled-product.bun', 'compiled-product.bun.LICENSE.md', 'compiled-product.bun.json'], { encoding: 'utf8' });
    expect({ status: packed.status, stderr: packed.stderr }).toEqual({ status: 0, stderr: '' });
    const restored = join(dir, 'restored'); mkdirSync(restored);
    const unpacked = spawnSync('tar', ['-xf', archive, '--no-same-owner', '-C', restored], { encoding: 'utf8' });
    expect({ status: unpacked.status, stderr: unpacked.stderr }).toEqual({ status: 0, stderr: '' });
    const restoredBinary = join(restored, 'compiled-product');
    expect(existsSync(restoredBinary + '.bun.LICENSE.md')).toBe(true);
    expect(JSON.parse(readFileSync(restoredBinary + '.bun.json', 'utf8'))).toMatchObject({ version: '1.3.14', target: `linux-${process.arch}` });
    const owner = join(dir, 'owner'); mkdirSync(owner);
    const run = spawnSync(restoredBinary, [owner], {
      cwd: restored, encoding: 'utf8', timeout: 30_000,
      env: { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir, CAPTURED_REPL_COMPILED_PARENT: 'MUST_NOT_LEAK' },
    });
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
    const proof = JSON.parse(run.stdout);
    expect(proof.execPath).toBe(restoredBinary);
    expect(proof.runtimeExecutable).toBe(restoredBinary + '.bun');
    expect(proof.compiledRuntimeRejected).toBe(true);
    expect(proof.parentMode).toBeNull();
    expect(proof.results).toHaveLength(2);
    for (const { runtime, result } of proof.results) {
      expect({ success: result.success, error: result.error }).toEqual({ success: true, error: undefined });
      const output = JSON.parse(result.output);
      expect(output).toMatchObject({ runtime, isolated: true, stateless: true, workspace_changes_persist: true,
        captured_exec_availability: { available: true, backend: 'linux-bwrap-projection' } });
      expect(JSON.parse(output.result)).toEqual({
        value: 'CAPTURED_ALLOWED', answer: 42,
        nested: { status: 0, stdout: 'COMPILED_PROGRAM_OK\n', stderr: '', mode: null },
        configuredPreload: { status: 0, stdout: 'COMPILED_PROGRAM_OK\n', stderr: '', mode: null },
        startupOrder: ['first', 'second'], configValue: 'PROJECT_CONFIG_OK', configuredType: 'LOADER_OK',
        mode: null, ambient: null, deniedVisible: false, ownerVisible: false, hostVisible: false, networkBlocked: true,
        compiledInBody: 'COMPILED_PROGRAM_OK\n', nestedInterpreter: '{"answer":42,"config":"PROJECT_CONFIG_OK","order":["first","second"]}\n',
      });
    }
    expect(proof.history.success).toBe(true);
    const history = JSON.parse(proof.history.output);
    expect(history.count).toBe(2);
    for (const [index, entry] of history.history.entries()) {
      expect(entry.runtime).toBe(proof.results[index].runtime);
      expect(entry.result).toBe(JSON.parse(proof.results[index].result.output).result);
    }
    expect(proof.deniedHistory.success).toBe(false);
    expect(proof.deniedHistory.error).toContain('Output withheld');
    expect(JSON.stringify(proof.deniedHistory)).not.toContain('CAPTURED_ALLOWED');
    expect(proof.memberOutput).toBe('MEMBER_GENERATED');
    expect(proof.ownerOutput).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 150_000);
