import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildBwrapArgv } from '../sdk/src/platform/tools/exec/sandbox.js';

test.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap') || !existsSync('/usr/bin/python3'))('ordinary sandbox cannot connect to host runtime sockets', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'sandbox-socket-'));
  // /var/tmp was visible through the former root bind, unlike the isolated /tmp.
  const socket = `/var/tmp/gv-test-socket-${process.pid}-${randomUUID()}.sock`;
  let connections = 0;
  const server = createServer(client => { connections++; client.end(); });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    const source = 'import socket,sys\ns = socket.socket(socket.AF_UNIX)\ns.connect(sys.argv[1])';
    const control = Bun.spawn(['/usr/bin/python3', '-c', source, socket], { stdout: 'pipe', stderr: 'pipe' });
    expect(await control.exited).toBe(0);
    expect(connections).toBe(1);
    const argv = buildBwrapArgv({ bwrapPath: '/usr/bin/bwrap', workspaceDir: workspace, cwd: workspace,
      writableExtras: [], networkEnabled: true, resolverConfigPath: realpathSync('/etc/resolv.conf') });
    const child = Bun.spawn([...argv, '/usr/bin/python3', '-c', source, socket], { stdout: 'pipe', stderr: 'pipe' });
    const error = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(error).toContain('FileNotFoundError');
    expect(connections).toBe(1);
    const dns = Bun.spawn([...argv, '/usr/bin/python3', '-c', "open('/etc/resolv.conf').read()"], { stdout: 'pipe', stderr: 'pipe' });
    expect(await dns.exited).toBe(0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(socket, { force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
