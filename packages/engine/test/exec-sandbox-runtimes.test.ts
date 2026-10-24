import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // The installed product supplies a copied Node binary ahead of the user's
  // package manager. npm must still work without exposing either directory.
  const runtime = join(workspace, 'installed-runtime'); mkdirSync(runtime);
  copyFileSync(Bun.which('node')!, join(runtime, 'node'));
  const startupPath = process.env.PATH;
  process.env.PATH = `${runtime}:${startupPath ?? ''}`;
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
  } finally {
    if (startupPath === undefined) delete process.env.PATH; else process.env.PATH = startupPath;
    await manager.close(); rmSync(workspace, { recursive: true, force: true });
  }
});


test.skipIf(!availability.available || !Bun.which('go'))('ordinary sandbox compiles and tests Go without exposing private home files or writable toolchains', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-go-runtime-'));
  const workspace = join(root, 'project'), home = join(root, 'private-home');
  mkdirSync(workspace); mkdirSync(home);
  const secret = join(home, 'private.txt'); writeFileSync(secret, 'PRIVATE_GO_SENTINEL');
  writeFileSync(join(workspace, 'go.mod'), 'module contained-go\n\ngo 1.22\n');
  writeFileSync(join(workspace, 'main.go'), `package main
import ("fmt"; "os"; "runtime")
func main() { fmt.Println("contained Go build") }
func isolated() bool {
  if _, err := os.Stat(${JSON.stringify(secret)}); !os.IsNotExist(err) { return false }
  probe := runtime.GOROOT()+"/src/.goodvibes-readonly-probe"
  if file, err := os.OpenFile(probe, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600); err == nil { file.Close(); os.Remove(probe); return false }
  return true
}
`);
  writeFileSync(join(workspace, 'main_test.go'), 'package main\nimport "testing"\nfunc TestIsolation(t *testing.T) { if !isolated() { t.Fatal("runtime isolation failed") } }\n');
  const manager = new ProcessManager();
  const tool = createExecTool(manager, { defaultWorkingDirectory: workspace,
    overflowHandler: new OverflowHandler({ baseDir: workspace }), credentialEnvScrub: { enabled: false },
    sandbox: { config: { enabled: true, egressAllowlist: [], workspaceWritable: [] }, availability, featureEnabled: true, homeDir: home } });
  try {
    const result = await tool.execute({ commands: [{ cmd: 'export GOCACHE="$PWD/.cache"; go test ./... && go build -o dist/contained . && ./dist/contained', progress: false, timeout_ms: 60_000 }] });
    expect(result.success, result.output ?? result.error).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output).toMatchObject({ sandboxed: true, sandbox_network: 'disabled', exit_code: 0 });
    expect(output.stdout).toContain('contained Go build');
    expect(readFileSync(secret, 'utf8')).toBe('PRIVATE_GO_SENTINEL');
  } finally { await manager.close(); rmSync(root, { recursive: true, force: true }); }
});
