import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecTool } from '../sdk/src/platform/tools/exec/runtime.ts';
import { withExternalOperationSource } from '../sdk/src/platform/permissions/external-operation-scope.ts';
import { brokerSandboxEscalation, resolveExecSandboxPlan, detectSandboxAvailability, probeSandboxHost, type SandboxEscalationPermit } from '../sdk/src/platform/tools/exec/sandbox.ts';
import { detectPtyAvailability, probePtyHost } from '../sdk/src/platform/tools/exec/interactive.ts';
import { ProcessManager } from '../sdk/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../sdk/src/platform/tools/shared/overflow.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

const command = 'printf owned-final-spawn';
useToolReadings([], [[command, { needsNetwork: true }]]);
const availability = detectSandboxAvailability(probeSandboxHost());
const pty = detectPtyAvailability(probePtyHost());
let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
for (const mode of ['foreground', 'progress', 'until', 'pty'] as const) {
  for (const revoked of [false, true]) {
    test.skipIf(!availability.available || (mode === 'pty' && !pty.available))(`${mode} claims exact admission at final spawn; revoked=${revoked}`, async () => {
      root = mkdtempSync(join(tmpdir(), 'sandbox-final-spawn-'));
      const controller = new AbortController();
      let claims = 0; let closes = 0; let spawns = 0;
      const permit: SandboxEscalationPermit = Object.freeze({ signal: controller.signal,
        assertCurrent() { controller.signal.throwIfAborted(); },
        claim() { claims++; if (revoked) throw new Error('fixture admission revoked at final effect'); },
        close() { closes++; },
      });
      const manager = new ProcessManager();
      const tool = createExecTool(manager, { defaultWorkingDirectory: root,
        overflowHandler: new OverflowHandler({ baseDir: root }), credentialEnvScrub: { enabled: false },
        sandbox: { config: { enabled: true, egressAllowlist: [], workspaceWritable: [] }, availability, featureEnabled: true,
          async requestEscalation(input) {
            expect(input.command).toBe(command); expect(input.workingDirectory).toBe(root!);
            expect(input.plan?.argvPrefix).toContain('--unshare-net');
            expect(Object.isFrozen(input.plan?.argvPrefix)).toBe(true);
            return permit;
          } },
        ...(mode === 'pty' ? { interaction: { availability: pty } } : {}),
      });
      const original = Bun.spawn;
      const spy = spyOn(Bun, 'spawn').mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
        spawns++; expect(claims).toBe(1);
        return original(...args);
      }) as typeof Bun.spawn);
      try {
        const result = await tool.execute({ commands: [{ cmd: command, timeout_ms: 1000, interactive: mode === 'pty',
          progress: mode === 'progress', ...(mode === 'until' ? { until: { pattern: 'owned-final-spawn', kill_after: true } } : {}) }] });
        expect(claims).toBe(1); expect(closes).toBe(1); expect(spawns).toBe(revoked ? 0 : 1);
        if (revoked) expect(result.success).toBe(false);
        else {
          const output = JSON.parse(result.output!);
          expect(output.sandboxed).toBe(true); expect(output.sandbox_network).not.toBe('enabled');
        }
      } finally { spy.mockRestore(); await manager.close(); }
    }, 10000);
  }
}


test.skipIf(!availability.available)('a canonical callback wrapper cannot downgrade an owned permit to boolean approval', async () => {
  root = mkdtempSync(join(tmpdir(), 'sandbox-no-downgrade-'));
  const sandbox = { config: { enabled: true, egressAllowlist: [], workspaceWritable: [] }, availability, featureEnabled: true, requestEscalation: async () => true };
  const plan = resolveExecSandboxPlan({ ...sandbox, command, workspaceDir: root, cwd: root, needs: { needsNetwork: true, needsPrivilege: false } });
  const result = await withExternalOperationSource({ sourceOf: () => ({ goal: 'Owned fixture', criteria: [] }), assertCurrent() {} },
    () => brokerSandboxEscalation(sandbox, plan, command, root!, { assertCurrent() {} }));
  expect(result).toHaveProperty('deniedEscalations');
});
