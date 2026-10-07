import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { availableLoopbackPorts, companionCliFixture } from '../helpers/companion-cli-fixture.js';

for (const host of ['user:private-password@127.0.0.1', 'http://user:private-password@localhost/path?private-query#private-fragment']) {
  test('emitted malformed-host startup fails without disclosing URL components or claiming readiness', async () => {
    const f = companionCliFixture();
    const [port] = await availableLoopbackPorts(1);
    mkdirSync(f.daemonHome, { recursive: true });
    writeFileSync(join(f.daemonHome, 'settings.json'), JSON.stringify({
      cluster: { enabled: false }, relay: { enabled: false }, controlPlane: { hostMode: 'custom', host, port },
    }));
    const child = f.launch(['--daemon-home', 'selected-daemon', 'serve'], { composed: true });
    try {
      expect(await child.waitForExit()).toBe(1);
      const { stdout, stderr } = child.output();
      expect(stdout).toContain('intended-host=[withheld]');
      expect(stdout).not.toContain(' bound:'); expect(stdout).not.toContain('host started');
      expect(stderr).toContain('Daemon startup failed');
      const token = (JSON.parse(readFileSync(join(f.daemonHome, 'operator-tokens.json'), 'utf8')) as { token: string }).token;
      for (const secret of ['private-password', 'private-query', 'private-fragment', token]) expect(stdout + stderr).not.toContain(secret);
    } finally { await child.close(); }
  });
}
