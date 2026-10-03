import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerQrcodeRuntimeCommands } from '../../input/commands/qrcode-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeContext(out: string[], root: string): CommandContext {
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    workingDir: root,
    homeDir: root,
    configDir: join(root, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT),
  });
  return {
    print: (text: string) => { out.push(text); },
    platform: { configManager },
    workspace: {
      shellPaths: createShellPathService({
        workingDirectory: root,
        homeDirectory: root,
      }),
    },
  } as unknown as CommandContext;
}

describe('qrcode runtime command', () => {
  test('prints companion pairing details and QR text instead of opening a panel', async () => {
    const registry = new CommandRegistry();
    registerQrcodeRuntimeCommands(registry);
    const command = registry.get('qrcode');
    expect(command).toEqual(expect.objectContaining({
      name: 'qrcode',
      handler: expect.any(Function),
    }));
    const root = makeProjectTempDir('goodvibes-agent-qrcode');
    const tokenDir = join(root, '.goodvibes', 'daemon');
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(join(tokenDir, 'operator-tokens.json'), JSON.stringify({ token: 'existing-connected-host-token' }));
    const out: string[] = [];

    await command!.handler([], makeContext(out, root));

    const text = out.join('\n');
    expect(text).toContain('goodvibes-agent');
    expect(text).toContain('http://127.0.0.1:3421');
    expect(text).toContain('Token:          present sha256:');
    expect(text).toContain('rerun /pair --show-token --yes');
    expect(text).not.toContain('existing-connected-host-token');
    expect(text).not.toContain('QR code panel');
  });

  test('prints manual token only after explicit confirmation', async () => {
    const registry = new CommandRegistry();
    registerQrcodeRuntimeCommands(registry);
    const command = registry.get('pair');
    expect(command).toEqual(expect.objectContaining({
      name: 'qrcode',
      aliases: expect.arrayContaining(['pair']),
      handler: expect.any(Function),
    }));
    const root = makeProjectTempDir('goodvibes-agent-qrcode-manual');
    const tokenDir = join(root, '.goodvibes', 'daemon');
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(join(tokenDir, 'operator-tokens.json'), JSON.stringify({ token: 'manual-connected-host-token' }));

    const previewOut: string[] = [];
    await command!.handler(['--show-token'], makeContext(previewOut, root));
    const preview = previewOut.join('\n');
    expect(preview).toContain('Manual companion token display requires confirmation.');
    expect(preview).not.toContain('manual-connected-host-token');

    const confirmedOut: string[] = [];
    await command!.handler(['--show-token', '--yes'], makeContext(confirmedOut, root));
    const confirmed = confirmedOut.join('\n');
    expect(confirmed).toContain('Manual token display was explicitly confirmed');
    expect(confirmed).toContain('manual-connected-host-token');
  });

  test('uses an environment connected-host token without exposing it by default', async () => {
    const registry = new CommandRegistry();
    registerQrcodeRuntimeCommands(registry);
    const command = registry.get('pair');
    expect(command).toEqual(expect.objectContaining({
      name: 'qrcode',
      aliases: expect.arrayContaining(['pair']),
      handler: expect.any(Function),
    }));
    const root = makeProjectTempDir('goodvibes-agent-qrcode-env');
    const previous = process.env.GOODVIBES_CONNECTED_HOST_TOKEN;
    process.env.GOODVIBES_CONNECTED_HOST_TOKEN = 'env-connected-host-token';
    const out: string[] = [];

    try {
      await command!.handler([], makeContext(out, root));
    } finally {
      if (previous === undefined) delete process.env.GOODVIBES_CONNECTED_HOST_TOKEN;
      else process.env.GOODVIBES_CONNECTED_HOST_TOKEN = previous;
    }

    const text = out.join('\n');
    expect(text).toContain('goodvibes-agent');
    expect(text).toContain('Token:          present sha256:');
    expect(text).toContain('rerun /pair --show-token --yes');
    expect(text).not.toContain('env-connected-host-token');
    expect(text).not.toContain('Connected-host operator token is required.');
  });

  test('points to confirmed setup token provisioning when pairing token is missing', async () => {
    const registry = new CommandRegistry();
    registerQrcodeRuntimeCommands(registry);
    const command = registry.get('qrcode');
    expect(command).toEqual(expect.objectContaining({
      name: 'qrcode',
      handler: expect.any(Function),
    }));
    const root = makeProjectTempDir('goodvibes-agent-qrcode-missing');
    const out: string[] = [];

    await command!.handler([], makeContext(out, root));

    const text = out.join('\n');
    expect(text).toContain('Connected-host operator token is required.');
    expect(text).toContain('provision_connected_host_token');
    expect(text).toContain('confirm:true');
    expect(text).not.toContain('existing-connected-host-token');
  });
});
