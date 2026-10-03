import { expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { AgentWorkspace } from '../../input/agent-workspace.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { renderAgentWorkspace } from '../../renderer/agent-workspace.ts';
import { resolveConnectedHostConnection } from '../../runtime/client/daemon-verbs.ts';
import { createNativeWorkLedgerView } from '../../runtime/native-work-ledger-host.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

for (const revoked of ['token', 'dial permission'] as const) test(`discovery notification/render tolerates synchronous ${revoked} revocation`, () => {
  const home = makeProjectTempDir('native-render-revocation');
  const directory = join(home, '.goodvibes', 'daemon'); mkdirSync(directory, { recursive: true });
  const tokenPath = join(directory, 'operator-tokens.json'); writeFileSync(tokenPath, JSON.stringify({ token: 'synthetic-render-token' }));
  const previous = { connected: process.env.GOODVIBES_CONNECTED_HOST_TOKEN, daemon: process.env.GOODVIBES_DAEMON_TOKEN };
  delete process.env.GOODVIBES_CONNECTED_HOST_TOKEN; delete process.env.GOODVIBES_DAEMON_TOKEN;
  let enabled = true; let revokeOnRender = true; let discoveries = 0; let bindings = 0;
  const configManager = { get(key: string) { return key === 'daemon.connectedHost.enabled' ? enabled : key === 'controlPlane.host' ? '127.0.0.1' : key === 'controlPlane.port' ? 59999 : undefined; } } as unknown as ConfigManager;
  const workspace = new AgentWorkspace();
  const context = { print: () => {}, executeCommand: async () => true } as unknown as CommandContext;
  workspace.open(context, () => {}, 'work');
  const view = createNativeWorkLedgerView(() => {
    const host = resolveConnectedHostConnection({ configManager, homeDirectory: home });
    return 'reason' in host ? host : { ...host, workspace: home };
  }, () => {
    if (revokeOnRender && view.state.status === 'loading') {
      revokeOnRender = false;
      if (revoked === 'token') rmSync(tokenPath); else enabled = false;
    }
    // Actual Work renderer reads workspace.nativeWorkLedgerState and syncs the
    // real authenticated host resolver during the loading notification.
    renderAgentWorkspace(workspace, 132, 60);
  }, () => { bindings++; return { available: false, reason: 'Unexpected binding' }; }, async () => { discoveries++; return 'unused-project'; });
  context.nativeWorkLedger = view;
  try {
    expect(() => view.open()).not.toThrow();
    expect(view.state.status).toBe('unavailable');
    expect(discoveries).toBe(0); expect(bindings).toBe(0);
    const frame = renderAgentWorkspace(workspace, 132, 60).lines.map(line => line.map(cell => cell.char ?? ' ').join('')).join('\n');
    expect(frame).toContain(revoked === 'token' ? 'operator token is required' : 'set not to dial');
    expect(frame).not.toContain('synthetic-render-token');
  } finally {
    workspace.close();
    if (previous.connected === undefined) delete process.env.GOODVIBES_CONNECTED_HOST_TOKEN; else process.env.GOODVIBES_CONNECTED_HOST_TOKEN = previous.connected;
    if (previous.daemon === undefined) delete process.env.GOODVIBES_DAEMON_TOKEN; else process.env.GOODVIBES_DAEMON_TOKEN = previous.daemon;
  }
});
