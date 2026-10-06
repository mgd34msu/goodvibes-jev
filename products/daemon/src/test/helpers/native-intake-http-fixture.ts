/** Owned synthetic semantic endpoints around the real daemon, auth and intake routes. */
import { spyOn } from 'bun:test';
import { withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { BenchmarkStore, ProviderRegistry, type ChatRequest, type ChatResponse, type LLMProvider, type ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';
import { WorkspaceRegistrationStore, sharedWorkspaceRegisterPath, legacyWorkspaceRegisterPath } from '@goodvibes-jev/engine/sdk/platform/workspace';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { WEBUI_METHOD_ROUTES } from '@goodvibes-jev/engine/contracts/generated/webui-facade';
import { startDaemonFixture } from '../../testing/daemon-fixture.js';
import { makeOwnedTempDir } from './owned-temp.js';

export type NativeIntakeHttpOperation = 'capture' | 'get' | 'admit' | 'resume' | 'cancel';
export type NativeIntakeHttpMethod = `workLedger.intake.${NativeIntakeHttpOperation}` | 'control.auth.current' | 'workLedger.project';
export interface NativeIntakeHttpWire {
  readonly methodId: NativeIntakeHttpMethod;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly requestBody?: unknown;
  /** Exact Response.text(), never normalized or reconstructed. */
  readonly body: string;
}
export const intakeProposalResponse = (content: string): ChatResponse => ({ content, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'completed' });
export function intakeBarrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

export async function createNativeIntakeHttpFixture(options: {
  readonly route?: 'contract' | 'converse';
  readonly final?: 'act' | 'reject';
  readonly propose?: (request: ChatRequest, attempt: number) => Promise<ChatResponse>;
} = {}) {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const restoreDiscovery = () => { identities.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore(); };
  let daemon: Awaited<ReturnType<typeof startDaemonFixture>>;
  try {
    daemon = await startDaemonFixture({ root: makeOwnedTempDir('native-intake-http'),
      inboxFactory: (context, _routing, settings) => registerInboxSurface(context, { ...settings, adapters: new Map() }) });
  } catch (error) { restoreDiscovery(); throw error; }
  const fake = fakePort((name, question) => {
    if (name === 'route') return choiceAnswer(question, options.route ?? 'contract', 0.99);
    if (name === 'relation') return choiceAnswer(question, 'supports', 0.99);
    if (name.startsWith('part_')) return noulAnswer(0.01);
    if (name === 'refuse') return noulAnswer(0.99);
    return choiceAnswer(question, options.final ?? 'act', 0.99);
  });
  const recorded = withDecisionLog(fake.port, daemon.services.judgment.decisionLog);
  const read = spyOn(daemon.services.judgment.port, 'ask').mockImplementation(request => recorded.ask(request));
  const requests: ChatRequest[] = [];
  const provider: LLMProvider = { name: 'native-intake-http-fixture', models: ['model'], credentialAuthority: 'anonymous',
    modelSource: { kind: 'dated-static', asOf: '2026-01-01' }, isConfigured: () => true,
    async chat(request) {
      requests.push(request);
      if (options.propose) return options.propose(request, requests.length);
      return fullInputProposal(request);
    } };
  const model = { id: 'model', provider: provider.name, registryKey: `${provider.name}:model`, displayName: 'Owned intake HTTP fixture', description: 'Synthetic model',
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false }, contextWindow: 100000, selectable: true, tier: 'standard' } as ModelDefinition;
  daemon.services.providerRegistry.registerRuntimeProvider({ provider, models: [model], replace: true });
  daemon.services.providerRegistry.setCurrentModel(model.registryKey);
  const paths = daemon.services.shellPaths;
  const scopes = new WorkspaceRegistrationStore({ path: sharedWorkspaceRegisterPath(paths), fallbackReadPath: legacyWorkspaceRegisterPath(paths),
    homeDir: daemon.homeDirectory, daemonStateDir: paths.resolveUserPath() });
  await scopes.add(daemon.workingDirectory);
  const paired = daemon.services.pairingTokens.mint({ name: 'Owned native intake browser capture' });
  async function wire(methodId: NativeIntakeHttpMethod, body?: unknown, token: string | null = paired.token): Promise<NativeIntakeHttpWire> {
    const route = WEBUI_METHOD_ROUTES[methodId];
    const response = await fetch(`${daemon.baseUrl}${route.path}`, { method: route.method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { methodId, method: route.method, path: route.path, status: response.status,
      ...(body === undefined ? {} : { requestBody: body }), body: await response.text() };
  }
  return { daemon, paired, fake, requests, wire, scopes,
    async stop() { try { await daemon.stop(); } finally { read.mockRestore(); restoreDiscovery(); } },
  };
}

export function fullInputProposal(request: ChatRequest): ChatResponse {
  const input = JSON.parse(String(request.messages[0]!.content)) as { sourceRevision: string; content: { parts: { text: string }[] } };
  return intakeProposalResponse(JSON.stringify({ sourceRevision: input.sourceRevision, spans: [{ partId: 'input', start: 0, end: input.content.parts[0]!.text.length }] }));
}
