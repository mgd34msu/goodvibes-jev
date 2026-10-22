import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createExecTool } from '../sdk/src/platform/tools/exec/runtime.js';
import { detectSandboxAvailability, probeSandboxHost } from '../sdk/src/platform/tools/exec/sandbox.js';
import { ProcessManager } from '../sdk/src/platform/tools/shared/process-manager.js';
import { OverflowHandler } from '../sdk/src/platform/tools/shared/overflow.js';
import { useToolReadings } from './_helpers/tool-readings.js';

useToolReadings();
const availability = detectSandboxAvailability(probeSandboxHost());
if (process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT === '1' && !availability.available)
  throw new Error('Required ordinary runtime containment backend is unavailable');

test.skipIf(!availability.available)('ordinary sandbox runs Bun tests while keeping home, runtime writes and host networking unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-js-runtime-'));
  const workspace = join(root, 'project'), home = join(root, 'private-home');
  mkdirSync(workspace); mkdirSync(home);
  const privatePath = join(home, 'private.txt'); writeFileSync(privatePath, 'PRIVATE_RUNTIME_SENTINEL');
  writeFileSync(join(workspace, 'runtime.test.ts'), `import { expect, test } from 'bun:test';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
test('real contained Bun execution', () => {
  expect(2 + 2).toBe(4);
  expect(existsSync(${JSON.stringify(privatePath)})).toBe(false);
  expect(() => writeFileSync(process.execPath, 'must not replace the interpreter')).toThrow();
  expect(readFileSync('/proc/net/route', 'utf8').trim().split('\\n')).toHaveLength(1);
});\n`);
  const manager = new ProcessManager();
  const tool = createExecTool(manager, { defaultWorkingDirectory: workspace,
    overflowHandler: new OverflowHandler({ baseDir: workspace }), credentialEnvScrub: { enabled: false },
    sandbox: { config: { enabled: true, egressAllowlist: [], workspaceWritable: [] }, availability, featureEnabled: true, homeDir: home } });
  try {
    const result = await tool.execute({ commands: [{ cmd: 'bun test', progress: false, timeout_ms: 10_000 }] });
    expect(result.success, result.output ?? result.error).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output).toMatchObject({ sandboxed: true, sandbox_network: 'disabled', exit_code: 0 });
    expect(output.stderr).toContain('1 pass');
    expect(readFileSync(privatePath, 'utf8')).toBe('PRIVATE_RUNTIME_SENTINEL');
  } finally { await manager.close(); rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(!availability.available || !Bun.which('node') || !Bun.which('npm'))('ordinary sandbox supplies the selected native Node and npm without mounting home directories', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'sandbox-node-runtime-'));
  const manager = new ProcessManager();
  const tool = createExecTool(manager, { defaultWorkingDirectory: workspace,
    overflowHandler: new OverflowHandler({ baseDir: workspace }), credentialEnvScrub: { enabled: false },
    sandbox: { config: { enabled: true, egressAllowlist: [], workspaceWritable: [] }, availability, featureEnabled: true } });
  try {
    const result = await tool.execute({ commands: [{ cmd: 'node --version && npm --version && npx --version', progress: false, timeout_ms: 10_000 }] });
    expect(result.success, result.output ?? result.error).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output).toMatchObject({ sandboxed: true, sandbox_network: 'disabled', exit_code: 0 });
    expect(output.stdout.trim().split('\n')).toHaveLength(3);
    expect(output.stdout).toMatch(/^v\d+\./);
    const custom = await tool.execute({ commands: [{ cmd: 'printf "%s" "$PATH"', env: { PATH: '/usr/bin:/bin' }, progress: false, timeout_ms: 1000 }] });
    expect(JSON.parse(custom.output!).stdout).toBe('/usr/bin:/bin');
  } finally { await manager.close(); rmSync(workspace, { recursive: true, force: true }); }
});
