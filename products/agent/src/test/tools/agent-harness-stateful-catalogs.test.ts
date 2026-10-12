import { SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { captureNativeReadRestrictions } from '../../runtime/read-restrictions.ts';
import { captureSetupReadSource } from '../../tools/agent-harness-setup-read-source.ts';
import { setupPostureSummary } from '../../tools/agent-harness-setup-posture.ts';
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { estimateTokens, LIMITS, validateContextBudget, type JudgmentPort } from '@goodvibes-jev/judgment';
import { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { createShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { SandboxSessionRegistry } from '@goodvibes-jev/engine/sdk/platform/runtime/sandbox';
import { registryCatalogGroupFit, ToolRegistry, ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { VoiceProviderRegistry, VoiceService, type VoiceDescriptor } from '@goodvibes-jev/engine/sdk/platform/voice';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { ConversationManager } from '../../core/conversation.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { buildAgentSetupWizard } from '../../agent/setup-wizard.ts';
import { supportBundleSummary } from '../../tools/agent-harness-security-posture.ts';
import { setupRepairTarget } from '../../tools/agent-harness-setup-describe.ts';
import type { SetupPlanItem } from '../../tools/agent-harness-setup-posture-types.ts';
import { listHarnessUiSurfaces, describeHarnessUiSurface, openHarnessUiSurface, totalHarnessUiSurfaces } from '../../tools/agent-harness-ui-surface-metadata.ts';
import { AGENT_WORKSPACE_CATEGORIES, allWorkspaceActions, listWorkspaceActions, resolveWorkspaceActionDetail, resolveWorkspaceActionIdentity } from '../../tools/agent-harness-workspace-actions.ts';
import { selectHarnessCatalog, selectHarnessCatalogGroup } from '../../tools/agent-harness-catalog-selection.ts';
import { captureCatalogSnapshot, rankHarnessCatalog } from '../../tools/agent-harness-catalog-ranking.ts';
import { describeHarnessServiceEndpoint } from '../../tools/agent-harness-service-posture.ts';
import { captureCatalogFile } from '../../tools/agent-harness-stateful-catalog-source.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { createTestProviderRegistry } from '../helpers/test-managers.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures, researchScreeningFixture, exactSensitiveSpans } from '../helpers/research-screening.ts';

function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected complete authored catalog data');
  return Object.fromEntries(Object.entries(value));
}
function nativeId(value: unknown): string {
  const row = fields(value);
  if (typeof row.id === 'string') return row.id;
  if (typeof row.bundleType === 'string') return row.bundleType;
  for (const key of ['record', 'entry', 'action', 'item']) if (row[key] !== undefined) return nativeId(row[key]);
  throw new Error('Original native row identity is missing');
}
function deferred<T>() {
  let finish: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => { finish = resolve; });
  return { promise, resolve(value: T) { if (!finish) throw new Error('Original deferred reader missing'); finish(value); } };
}
function catalogPort(query: string, chosen: string | null, probability: (id: string) => number,
  beforeSelection?: () => Promise<void>, group: {
    readonly probability?: (id: string) => number;
    readonly beforeRead?: () => Promise<void>;
    readonly deferIndex?: number;
  } = {}) {
  const fake = fakePort((name, question, raw) => {
    const state = fields(raw);
    if (name === 'match' && question.type === 'noul') {
      const candidate = fields(state.candidate);
      const lookup = typeof state.query === 'string' ? state.query : fields(state.query);
      if ((typeof lookup === 'string' ? lookup !== query : lookup.query !== query
        || Object.keys(lookup).length !== 2 || typeof lookup.contextJson !== 'string')
        || typeof candidate.evidenceJson !== 'string') throw new Error('Unexpected native rank request');
      const evidence: unknown = JSON.parse(candidate.evidenceJson);
      const record = fields(evidence).record;
      if (record !== undefined && Array.isArray(fields(record).actions)) {
        if (!group.probability) throw new Error('Unspecified native category-fit reading');
        return noulAnswer(group.probability(nativeId(record)));
      }
      return noulAnswer(probability(nativeId(evidence)));
    }
    const context = fields(state.context);
    if (context.query !== query || !Array.isArray(state.candidates)) throw new Error('Unexpected native choice request');
    const candidates = state.candidates.map(rawCandidate => {
      const candidate = fields(rawCandidate);
      if (typeof candidate.id !== 'string' || typeof candidate.content !== 'string') throw new Error('Original selection frame missing');
      const content: unknown = JSON.parse(candidate.content);
      return { id: candidate.id, native: nativeId(fields(content).record) };
    });
    if (name === 'pick' && question.type === 'choice') {
      const selected = candidates.find(candidate => candidate.native === chosen);
      if (chosen !== null && !selected) throw new Error('Authored native choice absent from complete candidates');
      return choiceAnswer(question, selected?.id ?? 'none', .999);
    }
    const fit = /^fits_(0|[1-9][0-9]*)$/.exec(name);
    if (!fit || question.type !== 'noul') throw new Error('Unexpected registered native choice question');
    const candidate = candidates[Number(fit[1])];
    if (!candidate) throw new Error('Original candidate index missing');
    return noulAnswer(probability(candidate.native));
  });
  if (beforeSelection || group.beforeRead) {
    const originalPort = fake.port, originalAsk = originalPort.ask.bind(originalPort);
    let groupReadDeferred = false, groupReadIndex = 0;
    originalPort.ask = async request => {
      const result = await originalAsk(request);
      if (beforeSelection && Object.hasOwn(request.questions, 'pick')) await beforeSelection();
      if (request.context?.site === 'agent.workspace.action-group') {
        const index = groupReadIndex++;
        if (group.beforeRead && !groupReadDeferred && index === (group.deferIndex ?? 0)) {
          groupReadDeferred = true; await group.beforeRead();
        }
      }
      return result;
    };
  }
  return fake;
}

function assertNativeRequestBudget(request: Parameters<JudgmentPort['ask']>[0]): void {
  validateContextBudget(request.state, request.questions);
  const state = estimateTokens(request.state);
  const questions = Object.values(request.questions).map(question => estimateTokens(question));
  expect(state + Math.max(0, ...questions)).toBeLessThanOrEqual(LIMITS.maxStateWithQuestionTokens);
  expect(state + questions.reduce((sum, tokens) => sum + tokens, 0)).toBeLessThanOrEqual(LIMITS.maxRequestTokens);
}
interface FixturePlatform {
  config: CommandContext['platform']['config'];
  configManager: ConfigManager;
  subscriptionManager?: SubscriptionManager;
  artifactStore?: ArtifactStore;
  voiceProviderRegistry?: VoiceProviderRegistry;
  voiceService?: VoiceService;
}
function fixture() {
  const root = makeProjectTempDir('stateful-native-catalog'), workspace = join(root, 'workspace'), home = join(root, 'home');
  mkdirSync(workspace); mkdirSync(home);
  const paths = createShellPathService({ workingDirectory: workspace, homeDirectory: home });
  const config = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT), workingDir: workspace, homeDir: home });
  config.setDynamic('controlPlane.enabled', false); config.setDynamic('danger.httpListener', false); config.setDynamic('web.enabled', false);
  const opened: string[] = [];
  const platform: FixturePlatform = { config: config.getAll(), configManager: config };
  const context: CommandContext = {
    print: () => {}, renderRequest: () => {}, exit: () => {},
    openSettingsModal: () => { opened.push('settings'); }, openHelpOverlay: () => { opened.push('help-overlay'); },
    workspace: { shellPaths: paths }, platform,
    session: { conversationManager: new ConversationManager(() => 80, config), runtime: {
      sessionId: 'stateful-native-catalog', model: 'fixture', provider: 'fixture', debugMode: false, systemPrompt: '', reasoningEffort: 'medium',
    } }, provider: { providerRegistry: createTestProviderRegistry() }, ops: {}, clients: {},
    extensions: { toolRegistry: new ToolRegistry(), mcpRegistry: new McpRegistry({
      hookDispatcher: { fire: async () => ({ ok: true }) }, sandboxSessions: new SandboxSessionRegistry(root),
    }) },
  };
  return { context, platform, config, opened, root, options: { sourceOwner: ordinaryResearchOwner() } };
}
const plan: readonly SetupPlanItem[] = [
  { id: 'keyword-blocker', label: 'Urgent host issue', status: 'blocked', priority: 1, blocksAutonomy: true,
    reason: 'Review unrelated network connectivity', nextAction: 'Inspect the host', userRoute: '/compat', modelRoute: 'host action:"status"' },
  { id: 'opaque-experiment', label: 'Local spoken response experiment', status: 'optional', priority: 90, blocksAutonomy: false,
    reason: 'Try a local spoken response after review', nextAction: 'Inspect audio setup', userRoute: '/voice', modelRoute: 'setup action:"item"' },
];
function wizard(items: readonly SetupPlanItem[] = plan) {
  return buildAgentSetupWizard({ items: items.map(item => ({ id: item.id, label: item.label, status: item.status,
    detail: item.reason, userRoute: item.userRoute, modelRoute: item.modelRoute })) });
}
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
afterAll(cleanupResearchScreeningFixtures);

describe('actual stateful catalog callers', () => {
  test('support route rank opposes shared words and reads all five complete routes before limit', async () => {
    const query = 'Trust bundle is irrelevant; inspect spoken provider settings';
    const fake = catalogPort(query, null, id => id === 'voice' ? .999 : .001);
    installJudgmentPort(fake.port);
    const result = await supportBundleSummary({ query, limit: 1 }, { sourceOwner: ordinaryResearchOwner() });
    expect(result.bundles).toEqual([expect.objectContaining({ bundleType: 'voice' })]);
    expect(fake.requests).toHaveLength(5);
    for (const request of fake.requests) expect(fields(fields(request.state).candidate).evidenceJson).toContain('workspaceActionIds');
  });

  test('repair rank top and blocked priority do not override explicit original optional row selection', async () => {
    const query = 'Check a spoken response while the urgent host issue is deferred';
    const fake = catalogPort(query, 'opaque-experiment', id => id === 'keyword-blocker' ? .999 : .995);
    installJudgmentPort(fake.port);
    const result = await setupRepairTarget(plan, wizard(), { query }, { sourceOwner: ordinaryResearchOwner() });
    expect('item' in result && result.item).toBe(plan[1]);
    expect(fake.requests.filter(request => 'candidate' in fields(request.state))).toHaveLength(2);
    expect(fake.requests.some(request => Object.hasOwn(request.questions, 'pick'))).toBe(true);
  });

  test('a single ranked repair still allows settled none', async () => {
    const items = plan.slice(1), query = 'Defer the spoken response experiment until later';
    const fake = catalogPort(query, null, () => .999); installJudgmentPort(fake.port);
    const result = await setupRepairTarget(items, wizard(items), { query }, { sourceOwner: ordinaryResearchOwner() });
    expect(result).toEqual({ error: { status: 'missing_lookup', usage: 'No setup repair target was selected. Use setup action:"status" to inspect the complete current plan.' } });
    expect(fake.requests.some(request => Object.hasOwn(request.questions, 'pick'))).toBe(true);
  });

  test('actual wizard current step and exact IDs retain native deterministic routing', async () => {
    const fake = fakePort(() => { throw new Error('Native identity entered free-text reading'); }); installJudgmentPort(fake.port);
    const currentWizard = wizard();
    const current = await setupRepairTarget(plan, currentWizard, {}, { sourceOwner: ordinaryResearchOwner() });
    expect<unknown>('item' in current && current.item.id).toBe(currentWizard.currentStepId);
    const exact = await setupRepairTarget(plan, currentWizard, { setupItemId: 'OPAQUE-EXPERIMENT' }, { sourceOwner: ordinaryResearchOwner() });
    expect('item' in exact && exact.item).toBe(plan[1]); expect(fake.requests).toHaveLength(0);
  });

  test('original wizard mutation while explicit choice is deferred retires the repair result', async () => {
    const entered = deferred<void>(), release = deferred<void>(), originalWizard = wizard(), query = 'Inspect spoken response settings';
    const fake = catalogPort(query, 'opaque-experiment', () => .999, async () => { entered.resolve(undefined); await release.promise; });
    installJudgmentPort(fake.port);
    const operation = setupRepairTarget(plan, originalWizard, { query }, { sourceOwner: ordinaryResearchOwner() });
    await entered.promise; expect(Reflect.set(originalWizard, 'currentStepId', 'changed-native-step')).toBe(true); release.resolve(undefined);
    await expect(operation).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  test('workspace prose selects complete original action rather than a notes token hit', async () => {
    const query = 'Notes are irrelevant; inspect approvals and running work';
    const args = { query }, nativeEntries = allWorkspaceActions();
    const intended = nativeEntries.find(entry => entry.action.id === 'assistant-work-lane');
    if (!intended) throw new Error('Original supervised work action missing');
    expect(nativeEntries.length).toBeGreaterThanOrEqual(LIMITS.maxChoiceOptions);
    const fake = catalogPort(query, 'assistant-work-lane', id => id === 'assistant-work-lane' ? .999 : .001,
      undefined, { probability: id => id === intended.category.id ? .999 : .001 }); installJudgmentPort(fake.port);
    const result = await resolveWorkspaceActionDetail(args, { sourceOwner: ordinaryResearchOwner() });
    expect(result?.status === 'found' && result.action.id).toBe('assistant-work-lane');
    expect<unknown>(result?.status === 'found' && result.action).toBe(nativeEntries.find(entry => entry.action.id === 'assistant-work-lane')?.action);
    expect(resolveWorkspaceActionIdentity({ query })).toBeNull();
    const groups = fake.requests.filter(request => request.context?.site === 'agent.workspace.action-group');
    expect(groups).toHaveLength(AGENT_WORKSPACE_CATEGORIES.length);
    expect<readonly unknown[]>(groups.map(request => {
      assertNativeRequestBudget(request);
      const state = fields(request.state), lookup = fields(state.query), candidate = fields(state.candidate);
      expect(lookup.query).toBe(query);
      if (typeof lookup.contextJson !== 'string' || typeof candidate.evidenceJson !== 'string') throw new Error('Missing original category-fit context');
      expect(JSON.parse(lookup.contextJson)).toEqual(args);
      const evidence: unknown = JSON.parse(candidate.evidenceJson);
      return fields(evidence).record;
    })).toEqual(AGENT_WORKSPACE_CATEGORIES);
    const requests = fake.requests.filter(request => request.context?.site === 'agent.workspace.action');
    expect(requests).toHaveLength(1);
    for (const request of requests) assertNativeRequestBudget(request);
    const state = fields(requests[0]?.state), context = fields(state.context);
    expect(context.query).toBe(query);
    if (typeof context.contextJson !== 'string' || !Array.isArray(state.candidates)) throw new Error('Missing original workspace context');
    const observedContext: unknown = JSON.parse(context.contextJson);
    expect(observedContext).toEqual({ category: intended.category, args });
    expect<readonly unknown[]>(state.candidates.map(candidate => {
      const row = fields(candidate);
      if (typeof row.content !== 'string') throw new Error('Missing native workspace candidate');
      const content: unknown = JSON.parse(row.content); return content;
    })).toEqual(intended.category.actions.map(action => ({ id: action.id, description: action.label, record: action })));
  });

  test('workspace settled none keeps native routes and effects unselected', async () => {
    const query = 'Do not open or run any workspace action';
    const fake = catalogPort(query, null, () => .001, undefined, { probability: () => .001 }); installJudgmentPort(fake.port);
    expect(await resolveWorkspaceActionDetail({ query }, { sourceOwner: ordinaryResearchOwner() })).toBeNull();
    expect(fake.requests.filter(request => request.context?.site === 'agent.workspace.action-group')).toHaveLength(AGENT_WORKSPACE_CATEGORIES.length);
    expect(fake.requests.filter(request => request.context?.site === 'agent.workspace.action')).toHaveLength(0);
    for (const request of fake.requests) assertNativeRequestBudget(request);
  });

  test('workspace exact native action identity needs no category or model reading', async () => {
    const original = allWorkspaceActions()[0];
    if (!original) throw new Error('Original native action missing');
    installJudgmentPort(undefined);
    const result = await resolveWorkspaceActionDetail({ actionId: original.action.id });
    expect(result?.status).toBe('found');
    expect<unknown>(result?.status === 'found' && result.action).toBe(original.action);
    expect<unknown>(result?.status === 'found' && result.category).toBe(original.category);
    expect(result?.status === 'found' && result.lookup.resolvedBy).toBe('id');
  });

  test('workspace rank preserves every original action and shared category context before limit', async () => {
    const f = fixture(), query = 'Ignore notes and inspect supervised current work', args = { query, limit: 1 };
    const nativeEntries = allWorkspaceActions();
    const fake = catalogPort(query, null, id => id === 'assistant-work-lane' ? .999 : .001); installJudgmentPort(fake.port);
    const rows = await listWorkspaceActions(f.context, args, f.options);
    expect(rows).toEqual([expect.objectContaining({ id: 'assistant-work-lane' })]);
    const requests = fake.requests.filter(request => request.context?.site === 'agent.workspace.actions');
    expect(requests).toHaveLength(nativeEntries.length);
    expect(requests.map(request => {
      assertNativeRequestBudget(request);
      const state = fields(request.state), lookup = fields(state.query), candidate = fields(state.candidate);
      expect(lookup.query).toBe(query);
      if (typeof lookup.contextJson !== 'string' || typeof candidate.evidenceJson !== 'string') throw new Error('Missing protected workspace rank context');
      const context: unknown = JSON.parse(lookup.contextJson), evidence: unknown = JSON.parse(candidate.evidenceJson);
      const native = nativeEntries.find(entry => entry.action.id === nativeId(evidence));
      if (!native) throw new Error('Ranked native action missing');
      expect(context).toEqual({ category: native.category, args });
      return evidence;
    })).toEqual(nativeEntries.map(entry => ({ record: entry.action })));
    expect(f.opened).toEqual([]);
  });

  test('workspace cross-category ambiguity keeps every affirmative category and returns none', async () => {
    const query = 'Inspect the available saved records';
    const first = AGENT_WORKSPACE_CATEGORIES[0], second = AGENT_WORKSPACE_CATEGORIES[1];
    if (!first || !second) throw new Error('Original opposing categories missing');
    const fake = catalogPort(query, null, () => .999, undefined,
      { probability: id => id === first.id ? .999 : id === second.id ? .995 : .001 }); installJudgmentPort(fake.port);
    expect(await resolveWorkspaceActionDetail({ query }, { sourceOwner: ordinaryResearchOwner() })).toBeNull();
    expect(fake.requests.filter(request => request.context?.site === 'agent.workspace.action-group')).toHaveLength(AGENT_WORKSPACE_CATEGORIES.length);
    expect(fake.requests.filter(request => request.context?.site === 'agent.workspace.action')).toHaveLength(0);
  });

  test('workspace within-category ambiguity reaches the complete original action choice and explicit none', async () => {
    const query = 'Inspect a saved record without distinguishing the alternatives';
    const category = AGENT_WORKSPACE_CATEGORIES.find(category => category.actions.length > 1);
    if (!category) throw new Error('Original multi-action category missing');
    const fake = catalogPort(query, null, () => .999, undefined,
      { probability: id => id === category.id ? .999 : .001 }); installJudgmentPort(fake.port);
    expect(await resolveWorkspaceActionDetail({ query }, { sourceOwner: ordinaryResearchOwner() })).toBeNull();
    const actions = fake.requests.filter(request => request.context?.site === 'agent.workspace.action');
    expect(actions).toHaveLength(1);
    const state = fields(actions[0]?.state);
    if (!Array.isArray(state.candidates)) throw new Error('Original category action choices missing');
    expect<readonly unknown[]>(state.candidates.map(candidate => {
      const content = fields(candidate).content;
      if (typeof content !== 'string') throw new Error('Original category action content missing');
      return fields(JSON.parse(content)).record;
    })).toEqual(category.actions);
    for (const request of actions) assertNativeRequestBudget(request);
  });

  test('workspace unresolved category fit holds even when another category is a settled yes', async () => {
    const query = 'Inspect available records while a second category remains unresolved';
    const first = AGENT_WORKSPACE_CATEGORIES[0], second = AGENT_WORKSPACE_CATEGORIES[1];
    if (!first || !second) throw new Error('Original unresolved categories missing');
    const fake = catalogPort(query, null, () => .999, undefined,
      { probability: id => id === first.id ? .999 : id === second.id ? .5 : .001 }); installJudgmentPort(fake.port);
    await expect(resolveWorkspaceActionDetail({ query }, { sourceOwner: ordinaryResearchOwner() })).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(fake.requests.filter(request => request.context?.site === 'agent.workspace.action-group')).toHaveLength(AGENT_WORKSPACE_CATEGORIES.length);
    expect(fake.requests.filter(request => request.context?.site === 'agent.workspace.action')).toHaveLength(0);
  });

  test('workspace captures the new native group reader before the first caller restriction', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(registryCatalogGroupFit, 'rerank');
    if (!descriptor || !('value' in descriptor)) throw new Error('Original native group reader descriptor missing');
    const original = registryCatalogGroupFit.rerank;
    let dispatched = 0, replaced = false;
    const replacement: typeof original = (...args) => { dispatched++; return original.call(registryCatalogGroupFit, ...args); };
    const fake = fakePort(() => { throw new Error('Replaced native group reader reached semantic dispatch'); }); installJudgmentPort(fake.port);
    try {
      await expect(resolveWorkspaceActionDetail({ query: 'Inspect approvals and running work' }, {
        sourceOwner: ordinaryResearchOwner(), assertCurrent() {
          if (!replaced) { replaced = true; expect(Reflect.set(registryCatalogGroupFit, 'rerank', replacement)).toBe(true); }
        },
      })).rejects.toBeInstanceOf(ToolInputProjectionError);
      expect(replaced).toBe(true); expect(dispatched).toBe(0); expect(fake.requests).toHaveLength(0);
    } finally { expect(Reflect.defineProperty(registryCatalogGroupFit, 'rerank', descriptor)).toBe(true); }
  });

  test('workspace native action slot either retires equal-data replacement or preserves immutable original identity', async () => {
    const query = 'Inspect pending approvals and running work', entered = deferred<void>(), release = deferred<void>();
    const intended = allWorkspaceActions().find(entry => entry.action.id === 'assistant-work-lane');
    if (!intended) throw new Error('Original supervised action missing');
    const index = intended.category.actions.indexOf(intended.action);
    const descriptor = Object.getOwnPropertyDescriptor(intended.category.actions, String(index));
    if (!descriptor || !('value' in descriptor)) throw new Error('Original action source slot missing');
    expect<unknown>(descriptor.value).toBe(intended.action);
    const replacement = { ...intended.action };
    captureCatalogSnapshot(intended.action).assertCurrent(replacement);
    expect(replacement).not.toBe(intended.action);
    const fake = catalogPort(query, intended.action.id, id => id === intended.action.id ? .999 : .001, undefined, {
      probability: id => id === intended.category.id ? .999 : .001,
      deferIndex: AGENT_WORKSPACE_CATEGORIES.length - 1,
      async beforeRead() { entered.resolve(undefined); await release.promise; },
    }); installJudgmentPort(fake.port);
    const operation = resolveWorkspaceActionDetail({ query }, { sourceOwner: ordinaryResearchOwner() });
    try {
      await entered.promise;
      expect(fake.requests.filter(request => request.context?.site === 'agent.workspace.action-group')).toHaveLength(AGENT_WORKSPACE_CATEGORIES.length);
      expect(Object.getOwnPropertyDescriptor(intended.category.actions, String(index))).toEqual(descriptor);
      expect<unknown>(intended.category.actions[index]).toBe(intended.action);
      if (descriptor.writable || descriptor.configurable) {
        if (descriptor.writable) {
          expect(Reflect.set(intended.category.actions, String(index), replacement)).toBe(true);
        } else {
          expect(Reflect.defineProperty(intended.category.actions, String(index), { ...descriptor, value: replacement })).toBe(true);
        }
        expect<unknown>(intended.category.actions[index]).toBe(replacement);
        expect(Object.getOwnPropertyDescriptor(intended.category.actions, String(index))).toEqual({ ...descriptor, value: replacement });
        release.resolve(undefined);
        await expect(operation).rejects.toBeInstanceOf(ToolInputProjectionError);
        expect(fake.requests.filter(request => request.context?.site === 'agent.workspace.action')).toHaveLength(0);
      } else {
        expect(descriptor.writable).toBe(false); expect(descriptor.configurable).toBe(false);
        expect(Reflect.set(intended.category.actions, String(index), replacement)).toBe(false);
        expect(Reflect.defineProperty(intended.category.actions, String(index), { ...descriptor, value: replacement })).toBe(false);
        expect(Object.getOwnPropertyDescriptor(intended.category.actions, String(index))).toEqual(descriptor);
        expect<unknown>(intended.category.actions[index]).toBe(intended.action); release.resolve(undefined);
        const result = await operation;
        expect(result?.status).toBe('found');
        expect<unknown>(result?.status === 'found' && result.action).toBe(intended.action);
        expect<unknown>(result?.status === 'found' && result.category).toBe(intended.category);
        expect(result?.status === 'found' && result.action).not.toBe(replacement);
        expect(Object.getOwnPropertyDescriptor(intended.category.actions, String(index))).toEqual(descriptor);
        const actionRequests = fake.requests.filter(request => request.context?.site === 'agent.workspace.action');
        expect(actionRequests).toHaveLength(1);
        for (const request of actionRequests) assertNativeRequestBudget(request);
      }
    } finally {
      expect(Reflect.defineProperty(intended.category.actions, String(index), descriptor)).toBe(true);
      release.resolve(undefined); await operation.catch(() => {});
    }
  });

  test('category fit retains complete native action source before the first callback', async () => {
    const query = 'Inspect original work';
    const action = { id: 'original-work', label: 'Original work', detail: 'Inspect original work' };
    const other = { id: 'other-work', label: 'Other work', detail: 'Inspect other work' };
    const groups = [{ id: 'original-group', label: 'Original category', actions: [action] },
      { id: 'other-group', label: 'Other category', actions: [other] }];
    const fake = fakePort(() => { throw new Error('Replaced original category reached semantic dispatch'); }); installJudgmentPort(fake.port);
    await expect(selectHarnessCatalogGroup(groups, query, group => ({ description: group.label }), {
      sourceOwner: ordinaryResearchOwner(), assertCurrent() { other.detail = 'Replacement observation'; },
    })).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(fake.requests).toHaveLength(0);
  });

  test('category fit reads sequentially and refuses source replacement during a pending reading', async () => {
    const query = 'Inspect original work', entered = deferred<void>(), release = deferred<void>();
    const action = { id: 'original-work', label: 'Original work', detail: 'Inspect original work' };
    const other = { id: 'other-work', label: 'Other work', detail: 'Inspect other work' };
    const groups = [{ id: 'original-group', label: 'Original category', actions: [action] },
      { id: 'other-group', label: 'Other category', actions: [other] }];
    const fake = catalogPort(query, null, () => .001, undefined, {
      probability: id => id === 'original-group' ? .999 : .001,
      async beforeRead() { entered.resolve(undefined); await release.promise; },
    }); installJudgmentPort(fake.port);
    const operation = selectHarnessCatalogGroup(groups, query, group => ({ description: group.label }),
      { sourceOwner: ordinaryResearchOwner() }, 'agent.workspace.action-group', { query });
    try {
      await entered.promise; expect(fake.requests).toHaveLength(1);
      other.detail = 'Replacement observation'; release.resolve(undefined);
      await expect(operation).rejects.toBeInstanceOf(ToolInputProjectionError);
      expect(fake.requests).toHaveLength(1);
    } finally { release.resolve(undefined); await operation.catch(() => {}); }
  });

  test('category fit cancellation retires a pending read without starting another category', async () => {
    const query = 'Inspect original work', entered = deferred<void>(), release = deferred<void>(), controller = new AbortController();
    const groups = [{ id: 'original-group', label: 'Original category', actions: [{ id: 'original-work', label: 'Original work' }] },
      { id: 'other-group', label: 'Other category', actions: [{ id: 'other-work', label: 'Other work' }] }];
    const fake = catalogPort(query, null, () => .001, undefined, {
      probability: id => id === 'original-group' ? .999 : .001,
      async beforeRead() { entered.resolve(undefined); await release.promise; },
    }); installJudgmentPort(fake.port);
    const operation = selectHarnessCatalogGroup(groups, query, group => ({ description: group.label }),
      { sourceOwner: ordinaryResearchOwner(), signal: controller.signal }, 'agent.workspace.action-group', { query });
    try {
      await entered.promise; expect(fake.requests).toHaveLength(1);
      const reason = new Error('Original category read cancelled'); controller.abort(reason); release.resolve(undefined);
      await expect(operation).rejects.toBe(reason);
      expect(fake.requests).toHaveLength(1);
    } finally { release.resolve(undefined); await operation.catch(() => {}); }
  });

  test('catalog selection captures its original complete shared context before the first restriction', async () => {
    const category = { id: 'native', detail: 'Original native category meaning' }, context = { categories: [category] };
    const fake = fakePort(() => { throw new Error('Retired shared context reached the reader'); }); installJudgmentPort(fake.port);
    await expect(selectHarnessCatalog([{ id: 'original', label: 'Original native row' }], 'inspect original row',
      entry => ({ id: entry.id, description: entry.label }), { sourceOwner: ordinaryResearchOwner(),
        assertCurrent() { expect(Reflect.set(category, 'detail', 'Replaced category meaning')).toBe(true); },
      }, 'agent.workspace.context-selection-control', context)).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(fake.requests).toHaveLength(0);
  });

  test('catalog rank captures its original complete shared context before the first restriction', async () => {
    const context = { args: { query: 'inspect original row', category: 'Original native category' } };
    const fake = fakePort(() => { throw new Error('Retired shared context reached the reader'); }); installJudgmentPort(fake.port);
    await expect(rankHarnessCatalog([{ id: 'original', label: 'Original native row' }], context.args.query,
      entry => ({ id: entry.id, description: entry.label, evidence: entry }), 'agent.workspace.context-rank-control',
      { sourceOwner: ordinaryResearchOwner(), requirePreservedSource: true,
        assertCurrent() { context.args.category = 'Replaced native category'; },
      }, 'engine.tools.registry-rank', context)).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(fake.requests).toHaveLength(0);
  });

  test('UI rank observes all 28 original definitions before clipping the public list', async () => {
    const f = fixture(), query = 'Ignore the settings keyword and show assistance';
    const fake = catalogPort(query, null, id => id === 'help-overlay' ? .999 : .001); installJudgmentPort(fake.port);
    const rows = await listHarnessUiSurfaces(f.context, { query, limit: 1 }, f.options);
    expect(rows).toEqual([expect.objectContaining({ id: 'help-overlay' })]); expect(totalHarnessUiSurfaces()).toBe(28);
    const requests = fake.requests.filter(request => request.context?.site === 'agent.ui.surfaces');
    expect(requests).toHaveLength(28);
    const records = requests.map(request => {
      expect(request.context).toMatchObject({ battery: 'engine.tools.registry-rank', pattern: 'rerank' });
      const state = fields(request.state), candidate = fields(state.candidate);
      expect(state.query).toBe(query);
      if (typeof candidate.evidenceJson !== 'string') throw new Error('Missing complete native UI source');
      const evidence = fields(JSON.parse(candidate.evidenceJson)), native = fields(evidence.record), context = fields(evidence.context);
      expect(context.row).toEqual(native); expect(context.args).toEqual({ query, limit: 1 });
      expect(Object.keys(native)).toEqual(['id', 'label', 'kind', 'summary', 'command', 'modelRoute', 'available',
        ...(native.id === 'connected-browser-cockpit' ? ['cockpit'] : []), 'preferredModelRoute', 'parameters', 'policy']);
      expect(candidate.description).toBe(native.label); expect(Array.isArray(native.parameters)).toBe(true);
      return native.id;
    });
    expect(records).toEqual(['agent-workspace', 'connected-browser-cockpit', 'panel-picker', 'security-panel', 'knowledge-panel',
      'subscription-panel', 'settings', 'mcp-workspace', 'model-picker', 'provider-picker', 'reasoning-effort-picker',
      'tts-provider-picker', 'tts-voice-picker', 'session-picker', 'profile-picker', 'bookmark-modal', 'context-inspector',
      'process-monitor', 'live-tail', 'conversation-search', 'prompt-history-search', 'slash-command-mode', 'command-browser',
      'file-picker', 'block-actions', 'help-overlay', 'shortcuts-overlay', 'onboarding']);
    expect(f.opened).toEqual([]);
  });

  test('UI prose routes the recorded native definition despite opposing shared words', async () => {
    const f = fixture(), query = 'Settings are irrelevant; show help';
    const fake = catalogPort(query, 'help-overlay', id => id === 'help-overlay' ? .999 : .001); installJudgmentPort(fake.port);
    const result = await openHarnessUiSurface(f.context, { query }, f.options);
    expect(result.surface).toBe('help-overlay'); expect(f.opened).toEqual(['help-overlay']);
  });

  test('UI none and uncertain fit produce zero opener effects', async () => {
    const f = fixture(), query = 'Defer opening the settings panel';
    const none = catalogPort(query, null, () => .001); installJudgmentPort(none.port);
    expect(await openHarnessUiSurface(f.context, { query }, f.options)).toMatchObject({ status: 'unknown_ui_surface' });
    const uncertain = catalogPort(query, 'settings', id => id === 'settings' ? .5 : .001); installJudgmentPort(uncertain.port);
    await expect(openHarnessUiSurface(f.context, { query }, f.options)).rejects.toBeInstanceOf(ToolInputProjectionError); expect(f.opened).toEqual([]);
  });

  test('deferred UI choice cannot invoke a replaced native opener', async () => {
    const f = fixture(), entered = deferred<void>(), release = deferred<void>(), query = 'Configure visual preferences';
    const fake = catalogPort(query, 'settings', id => id === 'settings' ? .999 : .001, async () => { entered.resolve(undefined); await release.promise; });
    installJudgmentPort(fake.port);
    const operation = openHarnessUiSurface(f.context, { query }, f.options);
    await entered.promise; f.context.openSettingsModal = () => { f.opened.push('replacement'); }; release.resolve(undefined);
    await expect(operation).rejects.toBeInstanceOf(ToolInputProjectionError); expect(f.opened).toEqual([]);
  });

  test('native config change and restore during UI choice retires the exact original source', async () => {
    const f = fixture(), entered = deferred<void>(), release = deferred<void>(), query = 'Configure visual preferences';
    const fake = catalogPort(query, 'settings', id => id === 'settings' ? .999 : .001, async () => { entered.resolve(undefined); await release.promise; });
    installJudgmentPort(fake.port);
    const operation = openHarnessUiSurface(f.context, { query }, f.options);
    await entered.promise; const original = f.config.get('tts.voice'); f.config.setDynamic('tts.voice', 'changed-native-voice'); f.config.setDynamic('tts.voice', original); release.resolve(undefined);
    await expect(operation).rejects.toThrow('CLI configuration owner changed.'); expect(f.opened).toEqual([]);
  });

  test('original cancellation retires a noncooperating deferred UI answer before effects', async () => {
    const f = fixture(), controller = new AbortController(), entered = deferred<void>(), release = deferred<void>(), query = 'Configure visual preferences';
    const fake = catalogPort(query, 'settings', id => id === 'settings' ? .999 : .001, async () => { entered.resolve(undefined); await release.promise; });
    installJudgmentPort(fake.port);
    const operation = openHarnessUiSurface(f.context, { query }, { ...f.options, signal: controller.signal });
    await entered.promise; controller.abort(); release.resolve(undefined);
    await expect(operation).rejects.toBeDefined(); expect(f.opened).toEqual([]);
  });

  test('full hidden original argument data is screened before a UI choice or opener', async () => {
    const f = fixture(), args = { query: 'Configure visual preferences' };
    Object.defineProperty(args, 'password', { value: 'synthetic-protected-ui-value', enumerable: false });
    const screening = researchScreeningFixture({ spans: exactSensitiveSpans(['synthetic-protected-ui-value']) });
    const fake = fakePort(() => { throw new Error('Protected original input reached a semantic reader'); }); installJudgmentPort(fake.port);
    const problem: unknown = await openHarnessUiSurface(f.context, args, { sourceOwner: screening.owner })
      .then(() => { throw new Error('Protected original input was accepted'); }, (error: unknown) => error);
    expect(problem).toBeInstanceOf(Error);
    expect(problem).toMatchObject({ name: 'JudgmentInputError', problem: 'credential-material' });
    expect(fake.requests).toHaveLength(0); expect(screening.calls).toHaveLength(0); expect(f.opened).toEqual([]);
  });

  test('native exact UI identity remains deterministic and read-only detail opens nothing', async () => {
    const f = fixture(), fake = fakePort(() => { throw new Error('Native UI identity entered selection'); }); installJudgmentPort(fake.port);
    expect(await describeHarnessUiSurface(f.context, { surfaceId: 'SETTINGS' }, f.options)).toMatchObject({ id: 'settings' });
    expect(f.opened).toEqual([]); expect(fake.requests).toHaveLength(0);
  });

  test('the exact disabled native cockpit opener returns its owned completed route', async () => {
    const f = fixture();
    const result = await openHarnessUiSurface(f.context, { surfaceId: 'connected-browser-cockpit' }, f.options);
    expect(result).toMatchObject({ status: 'setup_needed', surface: 'connected-browser-cockpit', route: { enabled: false, readiness: 'setup-needed' },
      descriptor: { id: 'connected-browser-cockpit', cockpit: { enabled: false, readiness: 'setup-needed' } } });
    expect(f.opened).toEqual([]);
  });

  test('actual disabled service sources are selected without opening sockets', async () => {
    const f = fixture(), query = 'Inspect the browser route while the inbound endpoint is irrelevant';
    const fake = catalogPort(query, 'web', id => id === 'web' ? .999 : .001); installJudgmentPort(fake.port);
    expect(await describeHarnessServiceEndpoint(f.context, { query }, f.options)).toMatchObject({ status: 'found', endpoint: { id: 'web', enabled: false } });
    expect(fields(fake.requests[0]?.state).candidates).toHaveLength(3);
  });

  test('missing native checkpoint creation and removal retires its original absence receipt', () => {
    const f = fixture(), path = join(f.root, 'checkpoint.json'), current = captureCatalogFile(path);
    current(); writeFileSync(path, '{}'); unlinkSync(path); expect(current).toThrow(ToolInputProjectionError);
  });

  test('native restrictions refuse an unknown thenable without invoking its getter', () => {
    let thenReads = 0;
    const returned = Object.defineProperty({}, 'then', { get() { thenReads++; throw new Error('Unexpected thenable dispatch'); } });
    const current = captureNativeReadRestrictions({ assertCurrent: () => returned });
    expect(current).toThrow('Native read currentness must be synchronous.'); expect(thenReads).toBe(0);
  });

  test('a previously exposed UI parameter array cannot change in the first restriction before selection', async () => {
    const f = fixture(), listed = await listHarnessUiSurfaces(f.context, { includeParameters: true }, f.options);
    const row = listed.find(entry => entry.id === 'settings'), parameters: unknown = row?.parameters;
    if (!Array.isArray(parameters) || typeof parameters[0] !== 'string') throw new Error('Original native settings parameters missing');
    const original = parameters[0]; let restrictions = 0;
    try {
      await expect(openHarnessUiSurface(f.context, { surfaceId: 'settings' }, { ...f.options, assertCurrent: () => {
        if (restrictions++ === 0) parameters[0] = 'synthetic-changed-parameter';
      } })).rejects.toThrow(ToolInputProjectionError);
      expect(restrictions).toBe(1); expect(f.opened).toEqual([]);
    } finally { parameters[0] = original; }
  });

  test('setup retains an existing native provider environment key boolean before the first restriction', async () => {
    const f = fixture(), key = 'OPENAI_API_KEY', previous = process.env[key]; process.env[key] = ''; let restrictions = 0;
    try {
      await expect(setupPostureSummary(f.context, {}, { ...f.options, assertCurrent: () => {
        if (restrictions++ === 0) process.env[key] = 'synthetic-present-observation';
      } })).rejects.toThrow(ToolInputProjectionError);
      expect(restrictions).toBe(1); expect(f.opened).toEqual([]);
    } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
  });

  test('setup retains the original complete native model catalog through its pure source guard', () => {
    const f = fixture(), current = captureSetupReadSource(f.context), models = f.context.provider.providerRegistry;
    const original = models.listModels;
    models.listModels = () => [];
    try { expect(current).toThrow(ToolInputProjectionError); } finally { models.listModels = original; }
  });

  test('setup refuses a replaced native Date accessor without invoking it', () => {
    const f = fixture(), current = captureSetupReadSource(f.context), original = Object.getOwnPropertyDescriptor(globalThis, 'Date');
    if (!original || !('value' in original)) throw new Error('Original native Date descriptor missing');
    let getters = 0;
    Object.defineProperty(globalThis, 'Date', { configurable: true, get() { getters++; return original.value; } });
    try { expect(current).toThrow(ToolInputProjectionError); expect(getters).toBe(0); }
    finally { Object.defineProperty(globalThis, 'Date', original); }
  });

  test('setup retains the native stored subscription freshness phase before the first restriction', async () => {
    const f = fixture(), path = join(f.root, 'native-subscriptions.json'); let now = Date.now(), restrictions = 0;
    writeFileSync(path, JSON.stringify({ version: 1, subscriptions: { fixture: {
      provider: 'fixture', accessToken: 'synthetic-local-token', tokenType: 'Bearer', expiresAt: now + 24 * 60 * 60 * 1000 + 10,
      authMode: 'oauth', overrideAmbientApiKeys: true, createdAt: now, updatedAt: now,
    } }, pending: {} }));
    f.platform.subscriptionManager = new SubscriptionManager(path);
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await expect(setupPostureSummary(f.context, {}, { ...f.options, assertCurrent: () => {
        if (restrictions++ === 0) now += 10;
      } })).rejects.toThrow(ToolInputProjectionError);
      expect(restrictions).toBe(1); expect(f.opened).toEqual([]);
    } finally { clock.mockRestore(); }
  });

  test('setup retains complete original native smoke artifact records before the first restriction', async () => {
    const f = fixture(), store = new ArtifactStore({ rootDir: join(f.root, 'artifacts') });
    const descriptor = await store.create({ kind: 'document', mimeType: 'text/plain', filename: 'synthetic-smoke.txt',
      text: 'synthetic local smoke evidence', metadata: { purpose: 'agent-setup-smoke-evidence', result: 'blocked' } });
    f.platform.artifactStore = store; let restrictions = 0;
    await expect(setupPostureSummary(f.context, {}, { ...f.options, assertCurrent: () => {
      if (restrictions++ === 0) descriptor.metadata.result = 'ready-for-user-run';
    } })).rejects.toThrow(ToolInputProjectionError);
    expect(restrictions).toBe(1); expect(f.opened).toEqual([]);
  });

  test('actual local VoiceService drains an unchanged voice list before opening the picker', async () => {
    const f = fixture(), entered = deferred<void>(), voices = deferred<readonly VoiceDescriptor[]>(), pickers: string[] = [];
    const registry = new VoiceProviderRegistry();
    registry.register({ id: 'fixture-local', label: 'Fixture local voices', capabilities: ['voice-list'], billing: 'none',
      listVoices: async () => { entered.resolve(undefined); return await voices.promise; } });
    f.platform.voiceProviderRegistry = registry; f.platform.voiceService = new VoiceService(registry);
    f.context.openSelection = title => { pickers.push(title); };
    const operation = openHarnessUiSurface(f.context, { surfaceId: 'tts-voice-picker', target: 'fixture-local' }, f.options);
    await entered.promise; expect(pickers).toEqual([]);
    voices.resolve([{ id: 'fixture-voice', label: 'Fixture voice', metadata: {} }]);
    expect(await operation).toMatchObject({ status: 'opened', surface: 'tts-voice-picker' });
    expect(pickers).toEqual(['Choose TTS Voice (fixture-local)']);
  });

  test('native provider replacement and restore during voice acquisition opens no stale picker', async () => {
    const f = fixture(), entered = deferred<void>(), voices = deferred<readonly VoiceDescriptor[]>(), pickers: string[] = [];
    const registry = new VoiceProviderRegistry();
    const original = { id: 'fixture-local', label: 'Fixture local voices', capabilities: ['voice-list'] as const, billing: 'none' as const,
      listVoices: async () => { entered.resolve(undefined); return await voices.promise; } };
    registry.register(original); f.platform.voiceProviderRegistry = registry; f.platform.voiceService = new VoiceService(registry);
    f.context.openSelection = title => { pickers.push(title); };
    const operation = openHarnessUiSurface(f.context, { surfaceId: 'tts-voice-picker', target: 'fixture-local' }, f.options);
    await entered.promise;
    registry.register({ ...original, label: 'Replacement provider' }, { replace: true }); registry.register(original, { replace: true });
    voices.resolve([{ id: 'fixture-voice', label: 'Fixture voice', metadata: {} }]);
    await expect(operation).rejects.toThrow('Security read source retired'); expect(pickers).toEqual([]);
  });

  test('the first caller restriction cannot replace and restore a voice owner before its baseline is captured', async () => {
    const f = fixture(), registry = new VoiceProviderRegistry(), pickers: string[] = []; let voiceReads = 0, restrictions = 0;
    const original = { id: 'fixture-local', label: 'Fixture local voices', capabilities: ['voice-list'] as const, billing: 'none' as const,
      listVoices: async () => { voiceReads++; return [{ id: 'fixture-voice', label: 'Fixture voice', metadata: {} }]; } };
    registry.register(original); f.platform.voiceProviderRegistry = registry; f.platform.voiceService = new VoiceService(registry);
    f.context.openSelection = title => { pickers.push(title); };
    await expect(openHarnessUiSurface(f.context, { surfaceId: 'tts-voice-picker', target: 'fixture-local' }, {
      ...f.options, assertCurrent: () => {
        if (restrictions++ === 0) {
          registry.register({ ...original, label: 'Replacement provider' }, { replace: true }); registry.register(original, { replace: true });
        }
      },
    })).rejects.toThrow('Security read source retired');
    expect(restrictions).toBe(1); expect(voiceReads).toBe(0); expect(pickers).toEqual([]);
  });

  test('cancelled noncooperating native voice acquisition drains without publishing a picker', async () => {
    const f = fixture(), entered = deferred<void>(), voices = deferred<readonly VoiceDescriptor[]>(), controller = new AbortController(), pickers: string[] = [];
    const registry = new VoiceProviderRegistry();
    registry.register({ id: 'fixture-local', label: 'Fixture local voices', capabilities: ['voice-list'], billing: 'none',
      listVoices: async () => { entered.resolve(undefined); return await voices.promise; } });
    f.platform.voiceProviderRegistry = registry; f.platform.voiceService = new VoiceService(registry);
    f.context.openSelection = title => { pickers.push(title); };
    const operation = openHarnessUiSurface(f.context, { surfaceId: 'tts-voice-picker', target: 'fixture-local' }, { ...f.options, signal: controller.signal });
    await entered.promise; controller.abort(); voices.resolve([{ id: 'fixture-voice', label: 'Fixture voice', metadata: {} }]);
    await expect(operation).rejects.toBeDefined(); expect(pickers).toEqual([]);
  });
});
