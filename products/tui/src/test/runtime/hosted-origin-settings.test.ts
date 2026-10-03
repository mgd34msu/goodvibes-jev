import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createHostedSessionRuntime, type CreateHostedSessionInput, type HostedSessionRuntime } from '@goodvibes-jev/engine/sdk/platform/hosted-sessions';
import { createClientRuntimeServices, type ClientRuntimeServices } from '@goodvibes-jev/engine/sdk/platform/runtime/client-services';
import { createRuntimeStore, RuntimeEventBus } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { createHostedSessionsClient } from '../../runtime/client/hosted-sessions.ts';
import type { DaemonVerbCaller } from '../../runtime/client/operator-endpoint.ts';

const KEY = 'voice.wake.enabled';

test('the TUI client origin routes real hosted settings to the TUI owner across service recreation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tui-hosted-origin-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const ownerPath = join(home, '.goodvibes', 'tui', 'settings.json');
  const hostPath = join(home, '.goodvibes', 'daemon', 'settings.json');
  let services: ClientRuntimeServices | undefined;
  let session: HostedSessionRuntime | undefined;
  let received: CreateHostedSessionInput | undefined;
  let approvalRequests = 0;

  function config(surfaceRoot: string): ConfigManager {
    return new ConfigManager({ surfaceRoot, homeDir: home, workingDir: workspace });
  }

  function compose(input: CreateHostedSessionInput): void {
    services = createClientRuntimeServices({
      configManager: config('daemon'),
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      surfaceRoot: 'daemon', workingDir: workspace, homeDirectory: home,
      requestApproval: async () => { approvalRequests += 1; return { approved: false }; },
      modelDiscovery: 'skip',
    });
    session = createHostedSessionRuntime({
      sessionId: 'hosted-tui-owner', workspaceRoot: input.workspaceRoot,
      floor: { services, contractRunner: services.contractRunner, dispose: () => services?.dispose() },
      systemPrompt: 'local settings ownership fixture',
      ...(input.originSurface === undefined ? {} : { originSurface: input.originSurface }),
    });
  }

  async function execute(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await session!.toolRegistry.execute(`owner-${tool}`, tool, args);
    expect(result.success, result.error).toBe(true);
    return JSON.parse(String(result.output)) as Record<string, unknown>;
  }

  try {
    // Deliberately disagree with the owner after its write: using the host's
    // ConfigManager would give a plausible success while changing the wrong file.
    config('daemon').set(KEY, false);
    config('tui').set(KEY, false);
    const hostBefore = readFileSync(hostPath, 'utf8');
    const verbs: DaemonVerbCaller = {
      probe: () => ({ available: false, reason: 'in-process settings fixture' }),
      invoke: async <T,>(methodId: string, input?: unknown): Promise<T> => {
        expect(methodId).toBe('sessions.hosted.create');
        received = input as CreateHostedSessionInput;
        compose(received);
        return { session: { id: session!.sessionId } } as T;
      },
    };
    await createHostedSessionsClient(verbs).create({ workspaceRoot: workspace, originSurface: 'tui' });

    const written = await execute('goodvibes_settings', { mode: 'set', key: KEY, value: true, confirm: true });
    expect(written).toMatchObject({ current: true, persistedTo: ownerPath, owner: 'client', verifiedInOwningStore: true });
    expect(config('tui').get(KEY)).toBe(true);
    expect(readFileSync(hostPath, 'utf8')).toBe(hostBefore);

    // Drop all in-memory settings and tool state. The same origin emitted by
    // the product must still resolve the owning file in a fresh composition.
    session!.dispose();
    session = undefined;
    services!.dispose();
    services = undefined;
    compose(received!);
    const read = await execute('goodvibes_context', { mode: 'config_get', key: KEY, includeSchema: false });
    expect(read['settings']).toMatchObject([{ key: KEY, value: true, source: ownerPath }]);
    const rewritten = await execute('goodvibes_settings', { mode: 'set', key: KEY, value: false, confirm: true });
    expect(rewritten).toMatchObject({ previous: true, current: false, persistedTo: ownerPath });
    expect(config('tui').get(KEY)).toBe(false);
    expect(readFileSync(hostPath, 'utf8')).toBe(hostBefore);
    expect(approvalRequests).toBe(0);
  } finally {
    session?.dispose();
    services?.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});
