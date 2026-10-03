import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerNetworkScanRuntimeCommands } from '../../input/commands/network-scan-runtime.ts';
import { loadLanScanConsent, saveLanScanConsent } from '../../runtime/lan-scan-consent.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const SURFACE_ROOT = 'agent';

function makeContext(root: string, out: string[]): CommandContext {
  const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  return {
    session: {} as never,
    provider: {} as never,
    workspace: { shellPaths } as never,
    platform: {} as never,
    ops: {} as never,
    extensions: {} as never,
    renderRequest: () => {},
    print: (text: string) => out.push(text),
    exit: () => {},
  } as CommandContext;
}

describe('/network-scan command (LAN-scan consent + status surface)', () => {
  test('registers under its own name with a discoverable alias', () => {
    const registry = new CommandRegistry();
    registerNetworkScanRuntimeCommands(registry);
    expect(registry.get('network-scan')?.name).toBe('network-scan');
    expect(registry.get('discover-lan')?.name).toBe('network-scan');
  });

  test('with no persisted decision, status reads as off and explains what scanning would touch and store', async () => {
    const root = makeProjectTempDir('gv-network-scan-cmd');
    const registry = new CommandRegistry();
    registerNetworkScanRuntimeCommands(registry);
    const out: string[] = [];

    await registry.get('network-scan')!.handler([], makeContext(root, out));

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Local network scanning: off');
    expect(out[0]).toContain('subnet only');
    expect(out[0]).toContain(join(root, '.goodvibes', SURFACE_ROOT, 'discovered-providers.json'));
    expect(out[0]).toContain('/network-scan on');
  });

  test('"on" persists an explicit grant and states the purpose and scope', async () => {
    const root = makeProjectTempDir('gv-network-scan-cmd');
    const registry = new CommandRegistry();
    registerNetworkScanRuntimeCommands(registry);
    const out: string[] = [];

    await registry.get('network-scan')!.handler(['on'], makeContext(root, out));

    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    expect(loadLanScanConsent(shellPaths, SURFACE_ROOT)?.decision).toBe('granted');
    expect(out[0]).toContain('now on');
    expect(out[0]).toContain('local network');
    expect(out[0]).toContain('/provider');
  });

  test('"off" persists an explicit decline as a first-class, fully-supported path', async () => {
    const root = makeProjectTempDir('gv-network-scan-cmd');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    saveLanScanConsent(shellPaths, SURFACE_ROOT, 'granted');

    const registry = new CommandRegistry();
    registerNetworkScanRuntimeCommands(registry);
    const out: string[] = [];

    await registry.get('network-scan')!.handler(['off'], makeContext(root, out));

    expect(loadLanScanConsent(shellPaths, SURFACE_ROOT)?.decision).toBe('declined');
    expect(out[0]).toContain('now off');
    expect(out[0]).toContain('Nothing on your network will be probed');
  });

  test('status after granting reflects "on" and points at /provider for detail on demand', async () => {
    const root = makeProjectTempDir('gv-network-scan-cmd');
    const registry = new CommandRegistry();
    registerNetworkScanRuntimeCommands(registry);
    const out: string[] = [];
    const ctx = makeContext(root, out);

    await registry.get('network-scan')!.handler(['on'], ctx);
    out.length = 0;
    await registry.get('network-scan')!.handler(['status'], ctx);

    expect(out[0]).toContain('Local network scanning: on');
    expect(out[0]).toContain('/provider');
    expect(out[0]).toContain('/network-scan off');
  });

  test('an unrecognized argument prints usage instead of silently doing nothing', async () => {
    const root = makeProjectTempDir('gv-network-scan-cmd');
    const registry = new CommandRegistry();
    registerNetworkScanRuntimeCommands(registry);
    const out: string[] = [];

    await registry.get('network-scan')!.handler(['bogus'], makeContext(root, out));

    expect(out[0]).toContain('Usage: /network-scan [on|off|status]');
  });
});
