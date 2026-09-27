import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { ToolRegistry } from '../../sdk/src/platform/tools/registry.js';
import {
  channelTargetNamedIds,
  createTaskRouteTool,
  modelProviderNamedIds,
  normalizeRouteAction,
  planTaskRoute,
  registerTaskRouteTool,
  TASK_ROUTES,
  taskRouteRegistry,
  type ReadyPlan,
  type TaskRouteCandidate,
  type TaskRouteDeps,
} from '../../sdk/src/platform/routing/task-routes/index.js';

/**
 * What the scripted port answers. `pick` is the route selection's choice
 * (catalog id or 'none'); `fits` the fit probability per catalog id (a picked
 * route fits at 0.95 unless given, the rest at 0.05); `slots` the yes
 * probability per yes/no slot (default 0.05); `choices` the slot choices;
 * `named` the id each named-id selection picks.
 */
interface Script {
  readonly pick?: string;
  readonly pickConfidence?: number;
  readonly fits?: Readonly<Record<string, number>>;
  readonly slots?: Readonly<Record<string, number>>;
  readonly choices?: Readonly<Record<string, string>>;
  readonly named?: Readonly<{ modelProvider?: string; memoryProvider?: string; channelTarget?: string }>;
  readonly namedConfidence?: number;
}

const KIND_KEYS: Readonly<Record<string, 'modelProvider' | 'memoryProvider' | 'channelTarget'>> = {
  'model provider': 'modelProvider',
  'external memory provider': 'memoryProvider',
  'messaging channel or notification target': 'channelTarget',
};

const CHOICE_DEFAULTS: Readonly<Record<string, string>> = { lane: 'none', channelTask: 'status', policyTarget: 'none' };

interface SelectionState {
  readonly context: { readonly request: string; readonly kind?: string };
  readonly candidates: readonly { readonly id: string }[];
}

function scriptedPort(script: Script) {
  return fakePort((name: string, question: Question, state: EntryType) => {
    const selection = state as unknown as SelectionState;
    if (selection.candidates !== undefined) {
      const kind = selection.context.kind === undefined ? undefined : KIND_KEYS[selection.context.kind];
      const chosen = kind === undefined ? (script.pick ?? 'none') : (script.named?.[kind] ?? 'none');
      if (name === 'pick') return choiceAnswer(question, chosen, kind === undefined ? (script.pickConfidence ?? 0.9) : (script.namedConfidence ?? 0.9));
      const id = selection.candidates[Number(name.slice('fits_'.length))]!.id;
      if (kind !== undefined) return noulAnswer(id === chosen ? 0.95 : 0.05);
      return noulAnswer(script.fits?.[id] ?? (id === chosen ? 0.95 : 0.05));
    }
    if (question.type === 'choice') return choiceAnswer(question, script.choices?.[name] ?? CHOICE_DEFAULTS[name]!);
    return noulAnswer(script.slots?.[name] ?? 0.05);
  });
}

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  previous = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previous);
});

/** Listings shaped as the live sources produce them (a provider registry, the channel adapters, a product's memory providers). */
const LISTINGS: NonNullable<TaskRouteDeps['namedIds']> = {
  modelProvider: () => modelProviderNamedIds({
    listProviders: () => [{ name: 'openrouter' }, { name: 'ollama' }],
    getConfiguredProviderIds: () => ['openrouter', 'zenmux'],
    getRawCatalogModels: () => [{ providerId: 'openrouter', provider: 'OpenRouter' }, { providerId: 'zenmux', provider: 'ZenMux' }],
  }),
  memoryProvider: () => [{ id: 'supermemory', names: ['Supermemory'] }, { id: 'mem0', names: ['Mem0'] }],
  channelTarget: () => channelTargetNamedIds({
    listDescriptors: () => [{ surface: 'slack', displayName: 'Slack' }, { surface: 'discord', displayName: 'Discord' }, { surface: 'telegram', displayName: 'Telegram' }],
  }),
};

async function plan(query: string, script: Script, extra: { includeParameters?: boolean; limit?: unknown } = {}, deps: TaskRouteDeps = { namedIds: LISTINGS }): Promise<ReadyPlan> {
  installJudgmentPort(scriptedPort(script).port);
  const result = await planTaskRoute({ query, ...extra }, deps);
  if (result.status !== 'ready') throw new Error(`expected a ready plan, got ${result.status}`);
  return result;
}

describe('judgment port', () => {
  test('planning with no port installed is an error, never a keyword guess', async () => {
    await expect(planTaskRoute({ query: 'check daemon health' })).rejects.toThrow(JudgmentPortMissingError);
    const tool = createTaskRouteTool();
    await expect(tool.execute({ action: 'plan', query: 'check daemon health' })).rejects.toThrow(JudgmentPortMissingError);
  });

  test('one planning pass asks the selection, the slots and one named id per listing together', async () => {
    const { port, requests } = scriptedPort({ pick: 'host-runtime-diagnostics' });
    installJudgmentPort(port);
    await planTaskRoute({ query: 'check daemon health' }, { namedIds: LISTINGS });
    expect(requests).toHaveLength(5);
    const pick = requests.find((request) => Object.keys(request.questions).length === TASK_ROUTES.length + 1);
    expect(pick).toBeDefined();
    expect(requests.every((request) => request.context?.site === 'routing.task-route.plan')).toBe(true);
  });

  test('named-id candidates are the live listings, and a kind with no listing asks nothing', async () => {
    const { port, requests } = scriptedPort({ pick: 'host-runtime-diagnostics' });
    installJudgmentPort(port);
    await planTaskRoute({ query: 'connect my ZenMux key' }, { namedIds: { modelProvider: LISTINGS.modelProvider } });
    expect(requests).toHaveLength(3);
    const providerRequest = requests.find((request) => (request.state as unknown as SelectionState).context?.kind === 'model provider')!;
    const offered = (providerRequest.state as { candidates: { id: string; content: { names: string[] } }[] }).candidates;
    // A configured provider no builtin list names is offered, under its catalog name.
    expect(offered.map((candidate) => candidate.id)).toEqual(['ollama', 'openrouter', 'zenmux']);
    expect(offered.find((candidate) => candidate.id === 'zenmux')!.content.names).toEqual(['ZenMux', 'zenmux']);
  });

  test('with no listings at all only the selection and the slots are asked', async () => {
    const { port, requests } = scriptedPort({ pick: 'host-runtime-diagnostics' });
    installJudgmentPort(port);
    await planTaskRoute({ query: 'check daemon health' });
    expect(requests).toHaveLength(2);
  });

  test('the registry holds every task route decision', () => {
    expect(taskRouteRegistry.list().map((decision) => decision.name)).toEqual([
      'routing.task-route.named-id',
      'routing.task-route.pick',
      'routing.task-route.slots',
    ]);
  });
});

describe('missing request', () => {
  test('returns the usage, examples and policy without asking anything', async () => {
    const result = await planTaskRoute({ query: '   ' });
    expect(result).toEqual({
      status: 'missing_request',
      usage: 'Use route action:"plan" query:"<user task>" to get the preferred GoodVibes Agent route, alternatives, missing fields, and confirmation boundary.',
      examples: [
        'Fix the failing tests in this repo.',
        'Triage my inbox and draft replies.',
        'Run a weekly source-backed research report.',
        'Why would settings action:set need confirmation?',
      ],
      policy: 'Route planning is read-only. It never runs tools, creates jobs, sends messages, changes settings, or opens UI surfaces.',
    });
  });

  test('target stands in for query', async () => {
    installJudgmentPort(scriptedPort({ pick: 'host-runtime-diagnostics' }).port);
    const result = await planTaskRoute({ target: 'check daemon health' });
    expect(result.status).toBe('ready');
  });
});

describe('preferred route and alternatives', () => {
  test('the pick is preferred; other fitting routes follow best first', async () => {
    const body = await plan('triage my inbox and draft replies', {
      pick: 'personal-ops-intake-route',
      fits: { 'personal-ops-intake-route': 0.9, 'personal-ops-review-queue': 0.58, 'personal-ops-daily-briefing': 0.8, 'channels': 0.3 },
      choices: { lane: 'inbox' },
    });
    expect(body.preferred).toMatchObject({
      id: 'personal-ops-intake-route',
      confidence: 'high',
      modelRoute: 'personal_ops action:"intake" query:"triage my inbox and draft replies" includeParameters:true',
      inspectRoute: 'personal_ops action:"lane" laneId:"inbox" includeParameters:true',
      userSurface: 'Personal Ops workspace',
      requiresConfirmation: false,
    });
    expect(body.alternatives.map((route) => [route.id, route.confidence])).toEqual([
      ['personal-ops-daily-briefing', 'high'],
      ['personal-ops-review-queue', 'medium'],
    ]);
    expect(body.routesConsidered).toBe(3);
    expect(body.note).toBeUndefined();
    expect(body.preferred.score).toBeUndefined();
  });

  test('a limit cuts the list and says how many routes it ranked', async () => {
    const script = { pick: 'personal-ops-intake-route', fits: { 'personal-ops-daily-briefing': 0.8, 'personal-ops-review-queue': 0.7 } };
    const body = await plan('triage my inbox and draft replies', script, { limit: '1' });
    expect(body.alternatives).toHaveLength(0);
    expect(body.routesConsidered).toBe(3);
    expect(body.note).toBe('Showing the 1 highest-scoring of 3 candidate routes; raise limit to see the rest.');
  });

  test('includeParameters shows each fit probability as the score', async () => {
    const body = await plan('compare models for this document', {
      pick: 'documents-artifacts-compare',
      fits: { 'documents-artifacts-compare': 0.92, 'model-route-readiness': 0.7 },
    }, { includeParameters: true });
    expect(body.preferred.score).toBe(0.92);
    expect(body.alternatives[0]).toMatchObject({ id: 'model-route-readiness', score: 0.7 });
  });

  test('a pick of none prefers the main conversation and keeps fitting routes as alternatives', async () => {
    const body = await plan('what is the capital of France?', { pick: 'none', fits: { 'agent-knowledge': 0.62 } });
    expect(body.preferred).toMatchObject({
      id: 'main-conversation-first',
      label: 'Main conversation first',
      confidence: 'high',
      modelRoute: 'main conversation',
      inspectRoute: 'workspace action:"actions" query:"what is the capital of France?"',
      requiresConfirmation: false,
      supportingRoutes: [
        'route action:"plan" query:"what is the capital of France?"',
        'workspace action:"actions" query:"what is the capital of France?"',
      ],
    });
    expect(body.alternatives.map((route) => route.id)).toEqual(['agent-knowledge']);
    expect(body.routesConsidered).toBe(2);
  });

  test('a picked route that does not read as fitting is not preferred', async () => {
    const body = await plan('check daemon health', { pick: 'host-runtime-diagnostics', fits: { 'host-runtime-diagnostics': 0.2 } });
    expect(body.preferred.id).toBe('main-conversation-first');
    expect(body.preferred.confidence).toBe('low');
  });

  test('a weak pick is preferred with low confidence', async () => {
    const body = await plan('check daemon health', { pick: 'host-runtime-diagnostics', pickConfidence: 0.5 });
    expect(body.preferred).toMatchObject({ id: 'host-runtime-diagnostics', confidence: 'low' });
  });

  test('the request preview is cut to 120 characters, 220 with parameters', async () => {
    const long = `${'word '.repeat(60)}end`;
    const compact = await plan(long, { pick: 'none' });
    expect(compact.request.length).toBe(120);
    expect(compact.request.endsWith('...')).toBe(true);
    const detailed = await plan(long, { pick: 'none' }, { includeParameters: true });
    expect(detailed.request.length).toBe(220);
  });

  test('nextAction follows the preferred route\'s confirmation boundary', async () => {
    const readOnly = await plan('check daemon health', { pick: 'host-runtime-diagnostics' });
    expect(readOnly.nextAction).toStartWith('Use the preferred read-only route first');
    const confirmed = await plan('generate an image', { pick: 'media-generation-artifact' });
    expect(confirmed.nextAction).toStartWith('Inspect the preferred route, collect missing fields');
  });
});

describe('slot readings shape the route', () => {
  const settings = (changes: number) => plan('change the theme setting', { pick: 'agent-settings-configuration', slots: { changes } });

  test('a change asks for confirmation and lists the missing fields', async () => {
    const body = await settings(0.9);
    expect(body.preferred).toMatchObject({
      modelRoute: 'settings action:"list" query:"change the theme setting" includeParameters:true',
      requiresConfirmation: true,
      missingFields: ['setting key', 'new value or reset target', 'confirmation'],
    });
  });

  test('a clear no leaves the route read-only; an unsure reading keeps the boundary', async () => {
    const readOnly = await settings(0.1);
    expect(readOnly.preferred.requiresConfirmation).toBe(false);
    expect(readOnly.preferred.missingFields).toBeUndefined();
    const unsure = await settings(0.5);
    expect(unsure.preferred.requiresConfirmation).toBe(true);
  });

  test('channel task and target pick the channel variant and its route strings', async () => {
    const setup = await plan('set up Slack notifications', { pick: 'channels', choices: { channelTask: 'setup' }, named: { channelTarget: 'slack' } });
    expect(setup.preferred).toMatchObject({
      id: 'channel-setup-route',
      label: 'Channel setup guide',
      modelRoute: 'channels action:"setup" target:"slack" includeParameters:true',
      inspectRoute: 'channels action:"triage" includeParameters:true',
      requiresConfirmation: true,
      missingFields: ['channel/account target', 'configuration or credential route', 'confirmation before mutating channel setup'],
    });
    const triage = await plan('triage failed Discord delivery retries', { pick: 'channels', choices: { channelTask: 'triage' }, named: { channelTarget: 'discord' } });
    expect(triage.preferred).toMatchObject({
      id: 'channel-triage-route',
      modelRoute: 'channels action:"triage" includeParameters:true',
      inspectRoute: 'channels action:"status" includeParameters:true',
      requiresConfirmation: false,
    });
    const receipts = await plan('show recent delivery receipts', { pick: 'channels', choices: { channelTask: 'receipts' } });
    expect(receipts.preferred).toMatchObject({ id: 'channel-delivery-receipts', modelRoute: 'channels action:"deliveries" limit:10 includeParameters:true' });
    const send = await plan('send message to Telegram', { pick: 'channels', choices: { channelTask: 'send' }, named: { channelTarget: 'telegram' } });
    expect(send.preferred).toMatchObject({
      id: 'channel-delivery-boundary',
      modelRoute: 'channels action:"channel" target:"telegram" includeParameters:true',
      requiresConfirmation: true,
      missingFields: ['configured target', 'message text', 'confirmation'],
    });
    const status = await plan('are my channels ready?', { pick: 'channels' });
    expect(status.preferred).toMatchObject({
      id: 'channel-readiness-route',
      label: 'Channel readiness',
      modelRoute: 'channels action:"status" query:"are my channels ready?" includeParameters:true',
      requiresConfirmation: false,
    });
    expect(status.preferred.supportingRoutes?.[0]).toBe('channels action:"setup" includeParameters:true');
  });

  test('a named model provider fills the provider route; a weak reading keeps the generic one', async () => {
    const named = await plan('connect OpenRouter subscription', { pick: 'model-provider-account-posture', slots: { changes: 0.9 }, named: { modelProvider: 'openrouter' } });
    expect(named.preferred).toMatchObject({
      modelRoute: 'models action:"provider" providerId:"openrouter" includeParameters:true',
      requiresConfirmation: true,
    });
    const weak = await plan('connect OpenRouter subscription', {
      pick: 'model-provider-account-posture',
      named: { modelProvider: 'openrouter' },
      namedConfidence: 0.5,
    });
    expect(weak.preferred.modelRoute).toBe('models action:"providers" query:"connect OpenRouter subscription" includeParameters:true');
  });

  test('external memory provider routes carry the named provider or ask for one', async () => {
    const named = await plan('connect Supermemory as an external memory provider', {
      pick: 'external-memory-provider-posture',
      slots: { changes: 0.9 },
      named: { memoryProvider: 'supermemory' },
    });
    expect(named.preferred).toMatchObject({
      modelRoute: 'memory action:"provider" providerId:"supermemory" includeParameters:true',
      inspectRoute: 'host action:"capability" query:"supermemory memory provider"',
      requiresConfirmation: true,
    });
    expect(named.preferred.missingFields).toEqual([
      'published setup/status/read/write/receipt contract before external memory is considered ready',
      'confirmation for any provider write, sync, import, export, or credential effect',
    ]);
    const generic = await plan('what external memory backends exist?', { pick: 'external-memory-provider-posture' });
    expect(generic.preferred.modelRoute).toBe('memory action:"status" query:"external memory provider" includeParameters:true');
    expect(generic.preferred.missingFields).toEqual([
      'provider id or backend name',
      'published setup/status/read/write/receipt contract before external memory is considered ready',
    ]);
  });

  test('the policy target fills the explanation route', async () => {
    const targeted = await plan('why was that terminal command blocked', { pick: 'security-policy-explanation', choices: { policyTarget: 'terminal' } });
    expect(targeted.preferred).toMatchObject({
      modelRoute: 'security action:"explain" target:"terminal" toolArgs:{...} includeParameters:true',
      requiresConfirmation: false,
      missingFields: ['arguments or action details to explain'],
    });
    const open = await plan('why was that blocked?', { pick: 'security-policy-explanation' });
    expect(open.preferred).toMatchObject({
      modelRoute: 'security action:"explain" toolName:"..." toolArgs:{...} includeParameters:true',
      missingFields: ['tool name or route id', 'arguments or action details to explain'],
    });
  });

  test('the delegated slot picks delegated build work over local-first execution', async () => {
    const delegated = await plan('fix the failing tests in parallel', { pick: 'build-work', slots: { delegated: 0.9 } });
    expect(delegated.preferred).toMatchObject({
      id: 'delegated-build-work',
      modelRoute: 'delegation action:"status" includeParameters:true',
      requiresConfirmation: true,
    });
    const local = await plan('Fix the failing tests in this repo.', { pick: 'build-work' });
    expect(local.preferred).toMatchObject({ id: 'local-first-execution', requiresConfirmation: false, modelRoute: 'execution action:"status" includeParameters:true' });
  });

  test('the device and evidence slots pick their variants', async () => {
    const device = await plan('can you use my phone camera?', { pick: 'capability-map', slots: { device: 0.9 } });
    expect(device.preferred).toMatchObject({ id: 'device-voice-capability', modelRoute: 'device action:"status" includeParameters:true' });
    const computer = await plan('what desktop capabilities do you have?', { pick: 'capability-map' });
    expect(computer.preferred).toMatchObject({ id: 'browser-computer-capability', userSurface: 'Connected browser cockpit' });
    const evidence = await plan('inspect release evidence artifact live verification', { pick: 'release-audit', slots: { evidence: 0.9 } });
    expect(evidence.preferred).toMatchObject({
      id: 'release-evidence-route',
      modelRoute: 'audit action:"evidence" query:"inspect release evidence artifact live verification" includeParameters:true',
    });
    const readiness = await plan('show release readiness inventory', { pick: 'release-audit' });
    expect(readiness.preferred).toMatchObject({ id: 'release-readiness-route', inspectRoute: 'audit action:"readiness" includeParameters:true' });
  });

  test('reminder and lifecycle readings pick the schedule label and missing fields', async () => {
    const reminder = await plan('remind me tomorrow to stretch', { pick: 'direct-schedule-route', slots: { reminder: 0.9 } });
    expect(reminder.preferred).toMatchObject({
      label: 'Reminder scheduling route',
      modelRoute: 'schedule action:"list" query:"remind me tomorrow to stretch" limit:5',
      requiresConfirmation: true,
      missingFields: ['reminder message', 'time or cadence', 'confirmation'],
    });
    const lifecycle = await plan('pause the nightly backup schedule', { pick: 'direct-schedule-route', slots: { controls: 0.9 } });
    expect(lifecycle.preferred).toMatchObject({ label: 'Schedule management route', missingFields: ['schedule id', 'exact lifecycle action', 'confirmation'] });
    const listing = await plan('show my scheduled work', { pick: 'direct-schedule-route' });
    expect(listing.preferred.requiresConfirmation).toBe(false);
  });

  test('process readings split starting, acting on and checking on a process', async () => {
    const starting = await plan('run pytest in background', { pick: 'local-background-process', slots: { starts: 0.9 } });
    expect(starting.preferred).toMatchObject({ requiresConfirmation: true, missingFields: ['command', 'working directory when not the current workspace', 'confirmation'] });
    const checking = await plan('show the logs of the build process', { pick: 'local-background-process', slots: { existing: 0.9 } });
    expect(checking.preferred).toMatchObject({ requiresConfirmation: false, missingFields: ['process id or session id'] });
    const listing = await plan('list processes', { pick: 'local-background-process' });
    expect(listing.preferred.missingFields).toBeUndefined();
  });

  test('personality and project context read different files', async () => {
    const files = await plan('show the AGENTS.md project instructions', { pick: 'personality-and-context', slots: { instructionFiles: 0.9 } });
    expect(files.preferred.modelRoute).toBe('context action:"files" includeParameters:true');
    const vibe = await plan('make your tone warmer', { pick: 'personality-and-context', slots: { changes: 0.9 } });
    expect(vibe.preferred).toMatchObject({ modelRoute: 'vibe action:"status" includeParameters:true', requiresConfirmation: true });
  });

  test('the visual report asks for the rendering route only when something is opened', async () => {
    const rendered = await plan('render the visual research report in the browser', { pick: 'research-visual-report-workflow', slots: { opensUi: 0.9 } });
    expect(rendered.preferred.requiresConfirmation).toBe(true);
    expect(rendered.preferred.missingFields).toContain('published browser/PWA report-rendering route before live browser rendering is considered ready');
    const planned = await plan('plan a visual research report', { pick: 'research-visual-report-workflow' });
    expect(planned.preferred).toMatchObject({ requiresConfirmation: false, missingFields: ['reviewed source bundle or saved report artifact id'] });
  });

  test('personal ops lanes fill the lane and queue routes', async () => {
    const queue = await plan('show my saved inbox review queue', { pick: 'personal-ops-review-queue', choices: { lane: 'inbox' } });
    expect(queue.preferred).toMatchObject({
      modelRoute: 'personal_ops action:"queue" query:"inbox" includeParameters:true',
      inspectRoute: 'personal_ops action:"lane" laneId:"inbox" includeParameters:true',
    });
    const noLane = await plan('show my saved review queue', { pick: 'personal-ops-review-queue' });
    expect(noLane.preferred).toMatchObject({
      modelRoute: 'personal_ops action:"queue" includeParameters:true',
      inspectRoute: 'personal_ops action:"status" includeParameters:true',
    });
    const fresh = await plan('refresh my Gmail inbox', { pick: 'personal-ops-intake-route', slots: { freshRead: 0.9 }, choices: { lane: 'inbox' } });
    expect(fresh.preferred).toMatchObject({ requiresConfirmation: true });
    expect(fresh.preferred.missingFields).toBeUndefined();
  });
});

describe('product catalogs', () => {
  test('matches come from the injected catalogs, 3 by default and 6 with parameters', async () => {
    const limits: number[] = [];
    const deps: TaskRouteDeps = {
      workspaceMatches: (_request, limit) => {
        limits.push(limit);
        return Array.from({ length: 10 }, (_, index) => ({ id: `action-${index}` }));
      },
      modeMatches: async (_request, limit) => {
        limits.push(limit);
        return [{ id: 'document_ops' }];
      },
    };
    const compact = await plan('compare models for this document', { pick: 'documents-artifacts-compare' }, {}, deps);
    expect(compact.workspaceMatches).toHaveLength(3);
    expect(compact.harnessModeMatches).toEqual([{ id: 'document_ops' }]);
    await plan('compare models for this document', { pick: 'documents-artifacts-compare' }, { includeParameters: true }, deps);
    expect(limits).toEqual([3, 3, 6, 6]);
  });

  test('absent or failing catalogs give empty lists', async () => {
    const absent = await plan('check daemon health', { pick: 'host-runtime-diagnostics' });
    expect(absent.workspaceMatches).toEqual([]);
    expect(absent.harnessModeMatches).toEqual([]);
    const failing = await plan('check daemon health', { pick: 'host-runtime-diagnostics' }, {}, {
      workspaceMatches: () => {
        throw new Error('catalog unavailable');
      },
    });
    expect(failing.workspaceMatches).toEqual([]);
  });
});

describe('route tool', () => {
  const parse = (output: string | undefined): Record<string, unknown> => JSON.parse(output ?? '') as Record<string, unknown>;

  test('the definition matches the agent route adapter', () => {
    const { definition } = createTaskRouteTool();
    expect(definition.name).toBe('route');
    expect(definition.description).toBe('Choose the best visible route for a user task.');
    expect(definition.sideEffects).toEqual([]);
    expect(definition.concurrency).toBe('parallel');
    expect(Object.keys((definition.parameters as { properties: Record<string, unknown> }).properties)).toEqual([
      'action', 'mode', 'query', 'target', 'includeParameters', 'limit',
    ]);
  });

  test('no arguments return the usage status without a port', async () => {
    const result = await createTaskRouteTool().execute({});
    expect(result.success).toBe(true);
    const body = parse(result.output);
    expect(body['status']).toBe('ready');
    expect(body['usage']).toBe('Use route action:"plan" query:"<user task>" before choosing a specialized GoodVibes Agent surface.');
    expect(body['actions']).toEqual(['plan', 'status']);
    expect(body['examples']).toHaveLength(16);
  });

  test('action aliases', () => {
    for (const word of ['plan', 'route', 'decide', 'decision', 'task', 'intake', 'PLAN']) expect(normalizeRouteAction(word)).toBe('plan');
    for (const word of ['status', 'summary', 'help', 'usage', ' Help ']) expect(normalizeRouteAction(word)).toBe('status');
    expect(normalizeRouteAction('launch')).toBeNull();
    expect(normalizeRouteAction(3)).toBeNull();
  });

  test('mode stands in for action, a status action wins over a query, and a query alone plans', async () => {
    installJudgmentPort(scriptedPort({ pick: 'host-runtime-diagnostics' }).port);
    const tool = createTaskRouteTool();
    expect(parse((await tool.execute({ mode: 'help', query: 'check daemon health' })).output)['usage']).toBeDefined();
    const planned = parse((await tool.execute({ query: 'check daemon health' })).output);
    expect((planned['preferred'] as TaskRouteCandidate).id).toBe('host-runtime-diagnostics');
    const byMode = parse((await tool.execute({ mode: 'decide', target: 'check daemon health' })).output);
    expect(byMode['status']).toBe('ready');
    expect(byMode['routesConsidered']).toBe(1);
  });

  test('registers once', () => {
    const registry = new ToolRegistry();
    registerTaskRouteTool(registry);
    registerTaskRouteTool(registry);
    expect(registry.getToolDefinitions().filter((definition) => definition.name === 'route')).toHaveLength(1);
  });
});
