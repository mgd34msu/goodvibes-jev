/**
 * Security: the public safety check (`security.runSafetyChecks`).
 *
 * A NUL byte in a path argument is refused in code: the operating system
 * truncates a path at NUL, so the path a call names is not the path it would
 * open. Whether a path reaching outside the project matters is the gate's
 * stakes reading (`beyondProject`), so traversal-looking paths are not refused
 * here. A shell command is refused when Jev reads it as catastrophic, or when
 * the reading is uncertain (nothing in this check can ask the owner).
 */
import { describe, test, expect } from 'bun:test';
import { useGateReadings } from './_helpers/gate-readings.ts';
import { runSafetyChecks } from './_helpers/runtime-seam.ts';

describe('security: the safety check', () => {
  useGateReadings([
    ['mkfs.ext4 /dev/sda1', { mutates: true, catastrophic: true }],
  ]);

  describe('a NUL byte in a path is refused', () => {
    for (const nullPath of ['/project/file.ts\0', '/tmp/safe\0/etc/passwd', '\0etc/shadow']) {
      test(`a path argument ${JSON.stringify(nullPath)} is refused`, async () => {
        const result = await runSafetyChecks({ path: nullPath });
        expect(result.blocked).toBe(true);
        expect(result.reason).toBe('SAFETY_DENY_PATH_ESCAPE');
      });
    }
  });

  describe('paths without a NUL byte pass (reaching beyond the project is the stakes reading)', () => {
    for (const path of ['/home/user/project/src/index.ts', './relative/path.ts', '/project/../../etc/passwd']) {
      test(`"${path}" passes`, async () => {
        expect((await runSafetyChecks({ path })).blocked).toBe(false);
      });
    }
  });

  describe('shell commands are read for catastrophe', () => {
    test('a command read as catastrophic is refused', async () => {
      const result = await runSafetyChecks({ command: 'mkfs.ext4 /dev/sda1' });
      expect(result.blocked).toBe(true);
      expect(result.steps.some((step) => step.check === 'catastrophic' && step.matched)).toBe(true);
    });

    test('an ordinary command passes', async () => {
      expect((await runSafetyChecks({ command: 'cat ../../etc/hosts' })).blocked).toBe(false);
    });
  });
});
