/** Real paired source admission and the production native execution graph; owned synthetic model readings only. */
import { spyOn } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withDecisionLog, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { BenchmarkStore, ProviderRegistry, type ChatRequest, type ChatResponse, type LLMProvider, type ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';
import { WorkspaceRegistrationStore, sharedWorkspaceRegisterPath, legacyWorkspaceRegisterPath } from '@goodvibes-jev/engine/sdk/platform/workspace';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import type { MintedPairingToken } from '@goodvibes-jev/engine/sdk/platform/pairing';
import { WEBUI_METHOD_ROUTES } from '@goodvibes-jev/engine/contracts/generated/webui-facade';
import { startDaemonFixture } from '../../testing/daemon-fixture.js';
import * as nativeComposition from '../../runtime/native-work-execution-composition.js';
import { makeOwnedTempDir } from './owned-temp.js';
import { intakeProposalResponse, fullInputProposal, type NativeIntakeHttpMethod } from './native-intake-http-fixture.js';

export type NativeIntakeExecutionHttpMethod = NativeIntakeHttpMethod | `workLedger.execution.${'start' | 'status' | 'cancel' | 'resume'}`;
export interface NativeIntakeExecutionHttpWire {
  readonly methodId: NativeIntakeExecutionHttpMethod;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly requestBody?: unknown;
  /** Exact serialized request and Response.text() bytes, with no rewritten IDs or projections. */
  readonly requestJson?: string;
  readonly body: string;
}

export async function createNativeIntakeExecutionHttpFixture(options: {
  readonly root?: string;
  readonly paired?: MintedPairingToken;
  /** Owned recorded provider plan for an already-admitted source after restart. */
  readonly resumedSourceText?: string;
  readonly beforeJudgment?: (request: JudgmentRequest<Questions>) => Promise<void>;
  readonly execute?: (request: ChatRequest) => Promise<ChatResponse>;
} = {}) {
  const root = options.root ?? makeOwnedTempDir('native-intake-execution-http');
  const workingDirectory = join(root, 'workspace');
  // Establish the real repository before constructing any runtime service or
  // watcher. Leave .goodvibes unignored, as user repositories may do.
  mkdirSync(workingDirectory, { recursive: true });
  if (!existsSync(join(workingDirectory, '.git'))) {
    writeFileSync(join(workingDirectory, 'README.md'), '# Owned native execution fixture\n');
    for (const args of [['init', '-q'], ['add', 'README.md'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Owned fixture']]) {
      if (spawnSync('git', args, { cwd: workingDirectory }).status !== 0) throw new Error('Owned fixture git initialization failed');
    }
  }
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const compose = nativeComposition.createDaemonNativeWorkExecutionServices;
  let native: Awaited<ReturnType<typeof compose>> | undefined;
  // Observe the real graph for assertions/diagnostics; replace no owner, runner,
  // route, authority check, storage method or execution operation.
  const composition = spyOn(nativeComposition, 'createDaemonNativeWorkExecutionServices').mockImplementation(async options => {
    native = await compose(options); return native;
  });
  const restoreDiscovery = () => { composition.mockRestore(); identities.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore(); };
  let daemon: Awaited<ReturnType<typeof startDaemonFixture>>;
  try {
    daemon = await startDaemonFixture({ root,
      inboxFactory: (context, _routing, settings) => registerInboxSurface(context, { ...settings, adapters: new Map() }) });
  } catch (error) { restoreDiscovery(); throw error; }
  const controls: { refuseExecution: boolean; failSettlement: boolean; route: 'contract' | 'converse' } = { refuseExecution: false, failSettlement: false, route: 'contract' };
  const fake = fakePort((name, question) => {
    if (question.type === 'noul') return noulAnswer(name === 'forbids_delegation' || name === 'checkable' || name.startsWith('fit') ? 0.99 : 0.01);
    if (question.type === 'score') return scoreAnswer(question, 0, 0.99);
    const choices = Object.keys(question.criteria);
    const preferred: Record<string, string> = { route: controls.route, disposition: 'act', relation: 'supports', role: 'research', tier: 'standard', intent: 'chat', strategy: 'single', category: 'unknown', connection_failure: 'none' };
    const pick = preferred[name];
    return choiceAnswer(question, pick && choices.includes(pick) ? pick : choices.find(key => key !== 'none')!, 0.99);
  });
  const refused = fakePort((_name, question) => choiceAnswer(question, 'reject', 0.99));
  const recorded = withDecisionLog(fake.port, daemon.services.judgment.decisionLog);
  const recordedRefusal = withDecisionLog(refused.port, daemon.services.judgment.decisionLog);
  const judgmentRequests: JudgmentRequest<Questions>[] = [];
  const judgmentErrors: unknown[] = [];
  let delivered = false;
  const read = spyOn(daemon.services.judgment.port, 'ask').mockImplementation(async request => {
    judgmentRequests.push(request);
    await options.beforeJudgment?.(request);
    if (request.context?.site === 'contract.check.deliverable-judge') delivered = true;
    // A second, host-owned verification follows the genuine runner checks.
    // The fault affects only that verification, never the executing unit.
    if (controls.failSettlement && delivered && request.context?.site === 'contract.check.unit-judge') throw new Error('Owned synthetic unavailable settlement');
    try { return await (controls.refuseExecution && request.context?.site === 'work-ledger.native-start' ? recordedRefusal : recorded).ask(request); }
    catch (error) { judgmentErrors.push(error); throw error; }
  });
  const requests: ChatRequest[] = [];
  let originalText: string | undefined = options.resumedSourceText;
  const provider: LLMProvider = { name: 'native-intake-execution-fixture', models: ['model'], credentialAuthority: 'anonymous',
    modelSource: { kind: 'dated-static', asOf: '2026-01-01' }, isConfigured: () => true,
    async chat(request) {
      requests.push(request);
      if (request.systemPrompt?.includes('You plan a contract')) {
        if (originalText === undefined) throw new Error('Planning cannot precede actual original-source admission');
        const criterion = { id: 'c1', text: originalText, quote: originalText };
        const plan = { goal: originalText, criteria: [criterion], groups: [{ id: 'g1', title: 'Answer', goal: originalText,
          kind: 'work', dependsOn: [], criteria: [], units: [{ id: 'u1', title: 'Answer', goal: originalText, role: 'research',
            brief: 'Say native execution is complete.', dependsOn: [], files: [], criteria: [{ id: 'u1.c1', text: originalText, serves: ['c1'] }] }] }] };
        return intakeProposalResponse(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``);
      }
      if (request.systemPrompt?.includes('Execute this existing native work unit yourself')) {
        return options.execute ? options.execute(request) : intakeProposalResponse('native execution is complete');
      }
      // The sole other provider operation is the real source-range proposer.
      const input = JSON.parse(String(request.messages[0]!.content)) as { content: { parts: { text: string }[] } };
      originalText = input.content.parts[0]!.text;
      return fullInputProposal(request);
    } };
  const model = { id: 'model', provider: provider.name, registryKey: `${provider.name}:model`, displayName: 'Owned intake and execution fixture', description: 'Synthetic model',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 100000, selectable: true, tier: 'standard' } as ModelDefinition;
  daemon.services.providerRegistry.registerRuntimeProvider({ provider, models: [model], replace: true });
  // No built-in proxy, live model discovery or user endpoint may be selected.
  const catalog = spyOn(daemon.services.providerRegistry, 'listModels').mockReturnValue([model]);
  daemon.services.providerRegistry.setCurrentModel(model.registryKey);
  const paths = daemon.services.shellPaths;
  const scopes = new WorkspaceRegistrationStore({ path: sharedWorkspaceRegisterPath(paths), fallbackReadPath: legacyWorkspaceRegisterPath(paths),
    homeDir: daemon.homeDirectory, daemonStateDir: paths.resolveUserPath() });
  await scopes.add(daemon.workingDirectory);
  const paired = options.paired ?? daemon.services.pairingTokens.mint({ name: 'Owned source-to-execution browser capture' });
  async function wire(methodId: NativeIntakeExecutionHttpMethod, body?: unknown, token: string | null = paired.token): Promise<NativeIntakeExecutionHttpWire> {
    const route = WEBUI_METHOD_ROUTES[methodId];
    const requestJson = body === undefined ? undefined : JSON.stringify(body);
    const response = await fetch(`${daemon.baseUrl}${route.path}`, { method: route.method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(requestJson === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(requestJson === undefined ? {} : { body: requestJson }) });
    return { methodId, method: route.method, path: route.path, status: response.status,
      ...(requestJson === undefined ? {} : { requestBody: body, requestJson }), body: await response.text() };
  }
  let stopping: Promise<void> | undefined;
  return { root, daemon, paired, requests, judgmentRequests, judgmentErrors, controls, scopes, wire,
    contracts: () => native?.runner.list({ includeTerminal: true }) ?? [],
    stop() { return stopping ??= daemon.stop().finally(() => { catalog.mockRestore(); read.mockRestore(); restoreDiscovery(); }); },
  };
}
