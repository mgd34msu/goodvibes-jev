import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createGoodVibesSdk } from '@goodvibes-jev/engine/sdk';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { resolveDaemonEnabled } from '@goodvibes-jev/engine/sdk/platform/config';
import { resolveDaemonStateDirectory, resolveControlPlaneBaseUrl } from './client/operator-endpoint.ts';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/operator-read-client';
import type { NativeWorkLedgerSelectionReader } from './native-work-ledger.ts';
import type { CommandRegistry } from '../input/command-registry.ts';

/** Explicit project selection on the configured authenticated daemon. No legacy ID inference. */
export function createNativeWorkLedgerHost(deps: {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string;
  readonly daemonHomeDirectory?: string;
  readonly workspace: () => string;
}) {
  let projectId = ''; let generation = 0; let selectedLocation = ''; let discoveryReason = '';
  const readToken = (): string | undefined => {
    try {
      const record: unknown = JSON.parse(readFileSync(join(deps.daemonHomeDirectory ?? resolveDaemonStateDirectory(deps.homeDirectory), 'operator-tokens.json'), 'utf8'));
      if (record && typeof record === 'object' && 'token' in record && typeof record.token === 'string' && record.token) return record.token;
    } catch { /* A read-only view never mints or repairs credentials. */ }
    return undefined;
  };
  const location = () => JSON.stringify([resolveControlPlaneBaseUrl(deps.configManager), deps.workspace()]);
  const selectProject = (id: string): void => {
    if (!id.trim() || id.length > 200) throw new Error('Use the exact daemon project ID (1–200 characters).');
    projectId = id; discoveryReason = ''; selectedLocation = location(); generation++;
  };
  const readSelection: NativeWorkLedgerSelectionReader = () => {
    if (projectId && selectedLocation !== location()) { projectId = ''; generation++; }
    const url = resolveControlPlaneBaseUrl(deps.configManager);
    const enabled = resolveDaemonEnabled(deps.configManager);
    const token = readToken();
    const authEpoch = token ? createHash('sha256').update(token).digest('hex') : 'no-auth';
    const identity = JSON.stringify([generation, url, enabled, deps.workspace(), projectId, authEpoch]);
    if (!projectId) return { available: false, identity, reason: discoveryReason || 'Select an exact daemon project with /work <project-id>.' };
    if (!enabled || !url) return { available: false, identity, reason: 'Selected daemon is disabled or has no endpoint.' };
    if (!token) return { available: false, identity, reason: 'Selected daemon has no existing authentication. Connect to the daemon first.' };
    const selectedProject = projectId;
    return { available: true, identity, projectId: selectedProject, bind: onUnavailable => {
      const sdk = createGoodVibesSdk({ baseUrl: url, authToken: token });
      return { available: true, client: createOperatorWorkLedgerReadClient(sdk.operator, selectedProject, { onUnavailable }) };
    } };
  };
  const discoverProject = async (): Promise<boolean> => {
    const before = readSelection();
    if (projectId) return true;
    const url = resolveControlPlaneBaseUrl(deps.configManager); const token = readToken();
    if (!url || !token || !resolveDaemonEnabled(deps.configManager)) return true;
    try {
      // Passive host identity discovery, using only the existing read:knowledge grant.
      const sdk = createGoodVibesSdk({ baseUrl: url, authToken: token });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      let status: { readonly ok: boolean; readonly projectId: string };
      try { status = await sdk.operator.invoke('projectPlanning.status', {}, { signal: controller.signal }); }
      finally { clearTimeout(timeout); }
      if (readSelection().identity !== before.identity) return false;
      if (!status.ok || typeof status.projectId !== 'string') throw new Error('Host project identity unavailable.');
      selectProject(status.projectId);
      return true;
    } catch {
      if (readSelection().identity !== before.identity) return false;
      discoveryReason = 'Host project discovery unavailable or not permitted. Select an exact daemon project with /work <project-id>.';
      return true;
    }
  };
  return { readSelection, selectProject, discoverProject };
}

export function registerNativeWorkLedgerCommand(registry: CommandRegistry, selectProject: (id: string) => void, discoverProject: () => Promise<boolean>): void {
  registry.register({ name: 'work', description: 'Read native work, intent, attention and evidence; /work <daemon-project-id> selects a project.',
    handler: async (args, ctx) => {
      if (args.length > 1) { ctx.print('Usage: /work [exact-daemon-project-id]'); return; }
      if (args[0]) { try { selectProject(args[0]); } catch (error) { ctx.print(String(error)); return; } }
      else if (!await discoverProject()) return;
      if (!ctx.openModal) { ctx.print('Native work view is unavailable in this shell.'); return; }
      ctx.openModal('native-work-ledger-modal');
    },
  });
}
