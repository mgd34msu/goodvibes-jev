import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { runSetupPairingCommand } from '../../cli/setup-pair-command.ts';
import { registerOnboardingRuntimeCommands } from '../../input/commands/onboarding-runtime.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { readAgentHostPairing } from '../../runtime/connected-host-pairing-store.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

async function withFixture(run: (f: { homeDirectory: string; configManager: ConfigManager; host: string; migrations: () => number }) => Promise<void>) {
  const saved = [process.env.GOODVIBES_CONNECTED_HOST_TOKEN, process.env.GOODVIBES_DAEMON_TOKEN];
  delete process.env.GOODVIBES_CONNECTED_HOST_TOKEN; delete process.env.GOODVIBES_DAEMON_TOKEN;
  const homeDirectory = makeProjectTempDir('setup-pair-cli');
  const configManager = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, configDir: join(homeDirectory, '.goodvibes', 'agent'), workingDir: homeDirectory, homeDir: homeDirectory });
  const minted = 'gvp_' + 'c'.repeat(32); const id = 'pair-12345678-1234-1234-1234-123456789abc'; let migrations = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname === '/api/control-plane/auth') return Response.json({ authenticated: true, authMode: 'shared-token', tokenPresent: true, authorizationHeaderPresent: true, sessionCookiePresent: false, principalId: request.headers.get('authorization') === `Bearer ${minted}` ? `pairing:${id}` : 'shared-token', principalKind: 'token', admin: true, scopes: ['*'], roles: [] });
    if (new URL(request.url).pathname === '/api/control-plane/methods/pairing.tokens.migrate/invoke') {
      migrations++; const { body } = await request.json() as { body: { name: string } };
      return Response.json({ token: { token: minted, id, name: body.name, createdAt: Date.now() } });
    }
    return new Response('unknown fixture route', { status: 404 });
  } });
  configManager.set('controlPlane.host', '127.0.0.1'); configManager.set('controlPlane.port', server.port!); configManager.set('daemon.connectedHost.enabled', true);
  mkdirSync(join(homeDirectory, '.goodvibes', 'daemon'), { recursive: true }); writeFileSync(join(homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'synthetic-bootstrap' }));
  try { await run({ homeDirectory, configManager, host: server.url.origin, migrations: () => migrations }); }
  finally { server.stop(true); for (const [i, key] of ['GOODVIBES_CONNECTED_HOST_TOKEN', 'GOODVIBES_DAEMON_TOKEN'].entries()) { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; } }
}

describe('standalone setup pair confirmation boundary', () => {
  for (const args of [['setup', 'pair'], ['setup', 'pair', '--apply', '--yes'], ['setup', 'pair', '--apply', '--json'], ['setup', 'pair', '--apply', '--output-format', 'stream-json']]) {
    test(`${args.join(' ')} never bypasses action-time confirmation`, async () => withFixture(async f => {
      let questions = 0;
      await runSetupPairingCommand({ ...f, workingDirectory: f.homeDirectory, cli: parseGoodVibesCli(args) }, { interactive: true, write: () => {}, question: async () => { questions++; return 'yes'; } });
      expect(questions).toBe(0); expect(f.migrations()).toBe(0); expect(readAgentHostPairing(f.homeDirectory, f.host).status).toBe('missing');
    }));
  }

  test('noninteractive apply refuses without asking or migrating', async () => withFixture(async f => {
    let questions = 0;
    const code = await runSetupPairingCommand({ ...f, workingDirectory: f.homeDirectory, cli: parseGoodVibesCli(['setup', 'pair', '--apply']) }, { interactive: false, write: () => {}, question: async () => { questions++; return 'yes'; } });
    expect(code).toBe(2); expect(questions).toBe(0); expect(f.migrations()).toBe(0);
  }));

  test('terminal prompt discloses admin scope before exact phrase and applies once', async () => withFixture(async f => {
    const output: string[] = []; let questions = 0;
    const code = await runSetupPairingCommand({ ...f, workingDirectory: f.homeDirectory, cli: parseGoodVibesCli(['setup', 'pair', '--name', 'CLI fixture', '--apply']) }, { interactive: true, write: text => output.push(text), question: async prompt => {
      questions++; expect(output.join('\n')).toContain('persistent administrative'); expect(output.join('\n')).toContain(f.host);
      return prompt.match(/Type (PAIR [0-9a-f]+) to create/)![1]!;
    } });
    expect(code).toBe(0); expect(questions).toBe(1); expect(f.migrations()).toBe(1); expect(output.join('\n')).not.toContain('synthetic-bootstrap');
    expect(output.join('\n')).not.toContain('gvp_'); expect(readAgentHostPairing(f.homeDirectory, f.host).status).toBe('paired');
  }));

  test('configuration changed while confirming requires a new preview', async () => withFixture(async f => {
    const code = await runSetupPairingCommand({ ...f, workingDirectory: f.homeDirectory, cli: parseGoodVibesCli(['setup', 'pair', '--apply']) }, { interactive: true, write: () => {}, question: async prompt => {
      f.configManager.set('controlPlane.port', 1); return prompt.match(/Type (PAIR [0-9a-f]+) to create/)![1]!;
    } });
    expect(code).toBe(1); expect(f.migrations()).toBe(0);
  }));

  test('actual setup status entrypoint reports fresh native readiness in JSON after pairing', async () => withFixture(async f => {
    const piped = Bun.spawn([process.execPath, 'src/main.ts', '--working-dir', f.homeDirectory, '--runtime-url', f.host, 'setup', 'pair', '--apply'], {
      cwd: process.cwd(), env: { ...process.env, HOME: f.homeDirectory, GOODVIBES_AGENT_HOME: f.homeDirectory }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [previewOut, previewExit] = await Promise.all([new Response(piped.stdout).text(), piped.exited]);
    expect(previewExit).toBe(2); expect(previewOut).toContain('No credential was created'); expect(f.migrations()).toBe(0);
    const code = await runSetupPairingCommand({ ...f, workingDirectory: f.homeDirectory, cli: parseGoodVibesCli(['setup', 'pair', '--apply']) }, { interactive: true, write: () => {}, question: async prompt => prompt.match(/Type (PAIR [0-9a-f]+) to create/)![1]! });
    expect(code).toBe(0);
    const child = Bun.spawn([process.execPath, 'src/main.ts', '--working-dir', f.homeDirectory, '--runtime-url', f.host, 'setup', 'status', '--json'], {
      cwd: process.cwd(), env: { ...process.env, HOME: f.homeDirectory, GOODVIBES_AGENT_HOME: f.homeDirectory }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [out, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(error).toBe(''); expect(exit).toBe(0);
    const result = JSON.parse(out) as { nativeReadiness: { status: string }; pairingStatus: string; selectedHost: string };
    expect(result.nativeReadiness.status).toBe('ready'); expect(result.pairingStatus).toBe('paired'); expect(result.selectedHost).toBe(f.host);
    expect(f.migrations()).toBe(1); expect(out).not.toContain('gvp_');
  }));

  test('setup status never echoes credential-like text embedded in an invalid host', async () => withFixture(async f => {
    const child = Bun.spawn([process.execPath, 'src/main.ts', '--working-dir', f.homeDirectory, '--config', 'controlPlane.host=synthetic-secret@example.com', 'setup', 'status', '--json'], {
      cwd: process.cwd(), env: { ...process.env, HOME: f.homeDirectory, GOODVIBES_AGENT_HOME: f.homeDirectory }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [out, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(0); expect(error).toBe(''); expect(out).not.toContain('synthetic-secret');
    expect(JSON.parse(out).selectedHost).toBe('(invalid endpoint)'); expect(f.migrations()).toBe(0);
  }));

  test('interactive slash command remains preview-only even with apply/yes arguments', async () => withFixture(async f => {
    const registry = new CommandRegistry(); registerOnboardingRuntimeCommands(registry); const printed: string[] = [];
    const context = { platform: { configManager: f.configManager }, workspace: { shellPaths: { homeDirectory: f.homeDirectory } }, print: (text: string) => printed.push(text) } as unknown as CommandContext;
    await registry.execute('setup', ['pair', '--apply', '--yes'], context);
    expect(f.migrations()).toBe(0); expect(printed.join('\n')).toContain('preview-only'); expect(readAgentHostPairing(f.homeDirectory, f.host).status).toBe('missing');
  }));
});
