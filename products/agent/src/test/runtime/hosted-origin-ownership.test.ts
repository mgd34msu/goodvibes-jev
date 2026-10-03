import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createClientRuntimeServices } from '@goodvibes-jev/engine/sdk/platform/runtime/client-services';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeStore } from '@goodvibes-jev/engine/sdk/platform/runtime/store';
import { createHostedSessionRuntime, type HostedSessionRuntime } from '@goodvibes-jev/engine/sdk/platform/hosted-sessions';
import type { DaemonVerbCaller } from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import { createRemoteConversationRouter } from '../../runtime/client/remote-conversation.ts';
import { createHostedConversationHandoff } from '../../runtime/client/hosted-handoff.ts';
import { ConnectedHostVerbError } from '../../runtime/client/daemon-verbs.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { seedProviderMetadataCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';

const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); });

for (const surface of ['composer', 'inbound'] as const) {
  test(`${surface} initial and recreated sessions write only Agent-owned settings`, async () => {
    const home = makeProjectTempDir('agent-hosted-origin');
    const workspace = join(home, 'workspace'); mkdirSync(workspace);
    const hostDir = join(home, '.goodvibes', 'goodvibes'); mkdirSync(hostDir, { recursive: true });
    const agentDir = join(home, '.goodvibes', 'agent'); mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(hostDir, 'settings.json'), JSON.stringify({ voice: { wake: { enabled: false } } }));
    const agentPath = join(agentDir, 'settings.json');
    writeFileSync(agentPath, JSON.stringify({ voice: { wake: { enabled: false } } }));
    const configManager = new ConfigManager({ surfaceRoot: 'goodvibes', configDir: hostDir, homeDir: home, workingDir: workspace });
    seedProviderMetadataCacheFixture({ configManager, homeDirectory: home, workingDirectory: workspace, surfaceRoot: 'goodvibes' });
    const services = createClientRuntimeServices({ configManager, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), surfaceRoot: 'goodvibes', workingDir: workspace, homeDirectory: home, requestApproval: async () => ({ approved: false }), modelDiscovery: 'skip' });
    disposals.push(() => services.dispose());
    const sessions: HostedSessionRuntime[] = [];
    let stale = false;
    const verbs: DaemonVerbCaller = {
      probe: () => ({ available: true }),
      invoke: async <T,>(method: string, raw?: unknown): Promise<T> => {
        const input = raw as { originSurface?: string; workspaceRoot: string };
        if (method === 'sessions.hosted.create') {
          const session = createHostedSessionRuntime({ sessionId: `hosted-${sessions.length}`, workspaceRoot: input.workspaceRoot, originSurface: input.originSurface, floor: { services, contractRunner: services.contractRunner, dispose() {} }, systemPrompt: 'Synthetic ownership test; no model turn runs.' });
          sessions.push(session); disposals.push(() => session.dispose());
          return { session: { id: session.sessionId } } as T;
        }
        if (method === 'sessions.steer' && stale) { stale = false; throw new ConnectedHostVerbError('gone', 404); }
        return {} as T;
      },
    };
    const router = createRemoteConversationRouter({ verbs, configManager, resolveConnection: () => ({ baseUrl: 'http://127.0.0.1:1', token: 'synthetic' }), workspaceRoot: workspace, clientId: 'agent:ownership', conversation: { addAssistantMessage() {}, addToolResults() {}, addSystemMessage() {}, startStreamingBlock() {}, updateStreamingBlock() {}, finalizeStreamingBlock() {} }, requestRender() {}, fetchImpl: Object.assign(async () => new Response(new ReadableStream({ start(controller) { controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } }), { preconnect() {} }), reconnect: { enabled: false } });
    disposals.push(() => router.dispose());
    const handoff = createHostedConversationHandoff({ verbs, isEnabled: () => true, workspaceRoot: () => workspace, clientId: 'agent:ownership' });
    const submit = async () => surface === 'composer' ? router.submit('synthetic input') : handoff.promote({ sessionId: 'inbound-1', task: 'synthetic input', body: 'synthetic input' });
    await submit();
    expect(sessions).toHaveLength(1);
    for (const iteration of [0, 1]) {
      if (iteration) { stale = true; await submit(); expect(sessions).toHaveLength(2); }
      writeFileSync(agentPath, JSON.stringify({ voice: { wake: { enabled: false } } }));
      const hostPath = configManager.getConfigPath();
      const hostBefore = readFileSync(hostPath, 'utf8');
      const result = await sessions[iteration]!.toolRegistry.execute(`write-${iteration}`, 'goodvibes_settings', { mode: 'set', key: 'voice.wake.enabled', value: true, confirm: true });
      expect(result.success).toBe(true);
      expect(JSON.parse(result.output!)).toMatchObject({ persistedTo: agentPath, current: true, verifiedInOwningStore: true });
      expect(JSON.parse(readFileSync(agentPath, 'utf8')).voice.wake.enabled).toBe(true);
      expect(readFileSync(hostPath, 'utf8')).toBe(hostBefore);
    }
  });
}
