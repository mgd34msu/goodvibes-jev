import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { pairNativeTestHost } from '../helpers/native-host-pairing.ts';
import { tuiHostPairingStorePath } from '../../runtime/tui-host-credential-store.ts';
import { executeNativeHeadless } from '../../cli/native-headless.ts';

for (const paired of [true, false]) test(`native headless command ${paired ? 'uses the private origin credential' : 'refuses daemon and environment fallback'} before bootstrap`, async () => {
  const home = mkdtempSync(join(tmpdir(), 'tui-headless-credential-')); const requests: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname; requests.push(path);
    expect(request.headers.get('authorization')).toBe('Bearer headless-private-token');
    if (path === '/api/work-ledger/project') return Response.json({ projectId: 'project' });
    if (path === '/api/control-plane/auth') return Response.json({ authenticated: true, authMode: 'shared-token', tokenPresent: true, authorizationHeaderPresent: true, sessionCookiePresent: false,
      principalId: 'paired-native-principal', principalKind: 'token', admin: true, scopes: ['read:work-ledger', 'write:work-ledger'], roles: [] });
    throw new Error(`Unexpected native headless request ${path}`);
  } });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  try {
    if (paired) await pairNativeTestHost(home, baseUrl, 'headless-private-token');
    mkdirSync(join(home, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(join(home, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'global-token' }));
    const command = fileURLToPath(new URL('../../cli/native-headless-command.ts', import.meta.url));
    const script = `import { runNativeHeadlessCommand } from ${JSON.stringify(command)};
      const configManager = { get: key => key === 'daemon.enabled' ? true : key === 'controlPlane.publicBaseUrl' ? ${JSON.stringify(baseUrl)} : undefined };
      process.exitCode = await runNativeHeadlessCommand({ cli: { flags: { outputFormat: 'json' }, commandArgs: [], positionals: [] }, configManager, homeDirectory: ${JSON.stringify(home)}, workingDirectory: ${JSON.stringify(home)} }, 'status');`;
    const child = Bun.spawn([process.execPath, '--eval', script], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: { ...process.env, GOODVIBES_HOST_TOKEN: 'environment-token' }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe(''); expect(exitCode).toBe(1); expect(JSON.parse(stdout).stopReason).toBe('native-unavailable');
    expect(requests).toEqual(paired ? ['/api/work-ledger/project', '/api/control-plane/auth'] : []);
    expect(stdout).not.toContain('private-token'); expect(stdout).not.toContain('global-token'); expect(stdout).not.toContain('environment-token');
    if (!paired) { expect(stdout).toContain('goodvibes host pair'); expect(existsSync(tuiHostPairingStorePath(home))).toBe(false); }
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }); }
});

test('headless discovery is fenced when the private store changes with the same token', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tui-headless-discovery-'));
  let arrived!: () => void; const arrival = new Promise<void>(resolve => { arrived = resolve; });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let identity = 'store-one'; const requests: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) { requests.push(new URL(request.url).pathname); arrived(); await held; return Response.json({ projectId: 'project' }); } });
  try {
    const pending = executeNativeHeadless({ mode: 'submit', prompt: 'Original input', signal: new AbortController().signal,
      resolveHost: () => ({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'same-private-token', credentialIdentity: identity, workspace: home, journalPath: join(home, 'intake.json') }),
      runTurn: async () => { throw new Error('A changed host cannot dispatch a turn'); } });
    await arrival; identity = 'store-two'; release();
    expect((await pending).exitCode).toBe(1); expect(requests).toEqual(['/api/work-ledger/project']);
    expect(existsSync(join(home, 'intake.json'))).toBe(false);
  } finally { release(); server.stop(true); rmSync(home, { recursive: true, force: true }); }
});
