import { agentOrchestrationSummary, describeAgentOrchestrationAgent } from '../../tools/agent-harness-agent-orchestration.ts';
import { remoteReadModelSnapshot, captureNativeRemoteReadModelSnapshot, settleNativeRemotePublisherSemantics, currentNativeRemoteReadModelSnapshot } from '../../tools/agent-harness-remote-read-models.ts';
import { captureCatalogMethods } from '../../tools/agent-harness-catalog-ranking.ts';
import { protectPersonalOpsData } from '../../tools/agent-harness-personal-ops-source.ts';
import { projectSetupSmokeEvidenceFull } from '../../tools/agent-harness-setup-smoke.ts';
import { exactSensitiveSpans, researchScreeningFixture } from '../helpers/research-screening.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import { resetAgentMcpCallRouteForTests } from '../../tools/agent-mcp-call-route.ts';
import { judgmentInputCardProblem } from '@goodvibes-jev/engine/sdk/platform/gate';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { join } from 'node:path';
import { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { createHarnessArtifactStore, makeFixture, registerStubTool, executeHarnessJson, PROVIDER_AUTH_ENV_KEYS, withClearedEnv, withPairedHost, writeConnectedHostOperatorToken, createHarnessFixtureReadings } from "./agent-harness-tool-fixture.ts";


afterAll(cleanupResearchScreeningFixtures);

describe('agent_harness tool', () => {
let previousPort: JudgmentPort | undefined;
let fixtureLog: SqliteDecisionLog;
beforeEach(() => {
    resetAgentMcpCallRouteForTests();
    fixtureLog = new SqliteDecisionLog(':memory:');
    previousPort = installJudgmentPort(withDecisionLog(createHarnessFixtureReadings(), fixtureLog));
  });
afterEach(() => { resetAgentMcpCallRouteForTests(); installJudgmentPort(previousPort); fixtureLog[Symbol.dispose](); });


  function makeOrchestrationQueryFixture() {
    const fixture = makeFixture();
    const clock = 1_770_000_000_001;
    expect(judgmentInputCardProblem(clock)).toBeUndefined();
    const agents = [
      { id: 'agent-alpha', task: 'An authored semantic match', template: 'engineer', status: 'running', startedAt: clock, tools: ['read'] },
      { id: 'agent-beta', task: 'auth lexical decoy', template: 'researcher', status: 'completed', startedAt: clock, tools: ['read'] },
    ];
    const outcome = { id: 'query-private-source', runnerId: 'agent-alpha', kind: 'capture', status: 'succeeded',
      task: 'Complete native auth evidence', summary: 'Native auth result token=ORCHESTRATION_SYNTHETIC_PRIVATE; Literal marker <redacted> is quoted here.',
      completedAt: clock, schemaStatus: 'certified', schemaVersion: 'goodvibes.remote-runtime.outcome.v1',
      publicationGuarantee: 'Native remote outcome source', publisher: 'goodvibes-daemon', receiptId: 'query-private-receipt' };
    const snapshot = { records: [outcome] }, readModel = { getSnapshot: () => snapshot };
    const remoteReadModels = { captureOutcomes: readModel };
    Object.defineProperty(fixture.context.ops, 'agentManager', { value: { exportState: () => agents }, configurable: true });
    Object.defineProperty(fixture.context.platform, 'readModels', { value: { remoteRuntime: remoteReadModels }, configurable: true });
    registerStubTool(fixture.toolRegistry, 'agent');
    return { fixture, agents, outcome, snapshot, readModel, remoteReadModels };
  }


  test.each(['callback', 'registration', 'repeated-key-first', 'repeated-key-last'] as const)('a remote publisher token rejects a source write at the final %s boundary before normalization', async boundary => {
    const f = makeOrchestrationQueryFixture();
    f.outcome.summary = 'Ordinary complete remote observation.';
    const original = judgmentPort('remote-publisher-final-callback-control');
    const semantic = fakePort((name, question) => name === 'certified_schema' ? noulAnswer(0.999)
      : name === 'outcome_kind' ? choiceAnswer(question, 'capture', 0.999) : (() => { throw new Error(name); })());
    installJudgmentPort({ ...original, ask: request => request.context?.battery === 'agent.remote-publisher.schema-status'
      || request.context?.battery === 'agent.remote-publisher.outcome-kind' ? semantic.port.ask(request) : original.ask(request) });
    const methods = captureCatalogMethods(f.readModel, ['getSnapshot']);
    const nativeRoot = captureCatalogMethods(f.fixture.context.platform, ['readModels']);
    const assertNative = () => { methods(); nativeRoot(); };
    let armed = false, accessorReads = 0;
    const retainedWrite = () => {
      if (armed) f.outcome.summary = 'Changed after the final arbitrary callback.';
    };
    try {
      const owned = captureNativeRemoteReadModelSnapshot(f.fixture.context);
      const settlement = settleNativeRemotePublisherSemantics(owned.token, {
        sourceOwner: ordinaryResearchOwner(), assertCurrent: assertNative, assertSourceCurrent: assertNative,
        retainCurrent: (_guard, key) => {
          if (boundary === 'registration' && key === 'agent.remote-publisher.native-capture') {
            Object.defineProperty(f.outcome, 'summary', { configurable: true, enumerable: true, get() {
              accessorReads += 1; return 'Changed during arbitrary guard registration.';
            } });
          }
        },
      }, {
        projectText: projectSetupSmokeEvidenceFull, projectPath: projectSetupSmokeEvidenceFull,
        protectFields: async (value, current) => {
          if (boundary === 'repeated-key-last') current.retainCurrent?.(() => {}, 'remote-publisher-final-callback-control');
          current.retainCurrent?.(retainedWrite, 'remote-publisher-final-callback-control');
          if (boundary === 'repeated-key-first') current.retainCurrent?.(() => {}, 'remote-publisher-final-callback-control');
          return protectPersonalOpsData(value, current);
        },
      });
      if (boundary === 'registration') {
        await expect(settlement).rejects.toThrow();
        expect(accessorReads).toBe(0);
        return;
      }
      const settled = await settlement;
      expect(settled.outcomes[0]?.kind).toBe('capture');
      expect(currentNativeRemoteReadModelSnapshot(f.fixture.context, owned.token).outcomes[0]?.kind).toBe('capture');
      armed = true;
      expect(() => currentNativeRemoteReadModelSnapshot(f.fixture.context, owned.token)).toThrow();
      expect(f.outcome.summary).toBe('Changed after the final arbitrary callback.');
    } finally { f.fixture.cleanup(); }
  }, 60_000);


  test('remote publisher meanings follow canonical evidence before the actual no-query live trail is published', async () => {
    const f = makeOrchestrationQueryFixture();
    const original = judgmentPort('remote-publisher-original-route-control');
    const requests: Parameters<JudgmentPort['ask']>[0][] = [];
    Object.assign(f.outcome, { id: 'remote-publisher-opposition', kind: 'capture only; export and closeout are separate examples',
      schemaStatus: 'certified', summary: 'The previous schema certificate was revoked. Capture is the actual operation.' });
    installJudgmentPort({ ...original, async ask(request) { requests.push(request); return original.ask(request); } });
    try {
      const result = await agentOrchestrationSummary(f.fixture.context, f.fixture.toolRegistry, { includeParameters: true }, { sourceOwner: ordinaryResearchOwner() });
      expect<unknown>(result.agents).toMatchObject([
        { agentId: 'agent-alpha', managedPlanCard: { liveOutcomeTrail: [{ id: 'remote-publisher-opposition', kind: 'capture', certification: { schemaStatus: 'legacy' } }] } },
        { agentId: 'agent-beta' },
      ]);
      expect<unknown>(result.managedExecutionPlan).toMatchObject({ remoteEvidence: { liveOutcomes: [{ id: 'remote-publisher-opposition', kind: 'capture', certification: { schemaStatus: 'legacy' } }] } });
      expect(requests.filter(request => request.context?.battery === 'agent.remote-publisher.schema-status')).toHaveLength(1);
      expect(requests.filter(request => request.context?.battery === 'agent.remote-publisher.outcome-kind')).toHaveLength(1);
      expect(JSON.stringify(requests)).toContain('previous schema certificate was revoked');
      expect(f.outcome.schemaStatus).toBe('certified');
    } finally { f.fixture.cleanup(); }
  }, 60_000);


  test('the actual exact-ID remote trail accepts a paraphrase outside the former substring and synonym lists', async () => {
    const f = makeOrchestrationQueryFixture();
    Object.assign(f.outcome, { id: 'remote-publisher-paraphrase', kind: 'Finalize runner work with its completion report.',
      schemaStatus: 'The published record passed schema validation.' });
    try {
      const result = await describeAgentOrchestrationAgent(f.fixture.context, { agentId: 'agent-alpha', includeParameters: true }, { sourceOwner: ordinaryResearchOwner() });
      expect(result.status).toBe('found');
      if (result.status !== 'found') throw new Error('Missing native exact-ID remote result');
      expect<unknown>(result.agent).toMatchObject({ managedPlanCard: { liveOutcomeTrail: [{ id: 'remote-publisher-paraphrase', kind: 'closeout', certification: { schemaStatus: 'certified' } }] } });
      expect(f.outcome.kind).toBe('Finalize runner work with its completion report.');
    } finally { f.fixture.cleanup(); }
  }, 60_000);


  test.each(['agent.remote-publisher.schema-status', 'agent.remote-publisher.outcome-kind'])('an unresolved %s reading blocks the actual native return rather than reviving text fallback', async battery => {
    const f = makeOrchestrationQueryFixture();
    const original = judgmentPort('remote-publisher-unknown-control');
    installJudgmentPort({ ...original, async ask(request) {
      if (request.context?.battery !== battery) return original.ask(request);
      return fakePort((name, question) => name === 'certified_schema' ? noulAnswer(0.5)
        : name === 'outcome_kind' ? choiceAnswer(question, 'export', 0.2) : (() => { throw new Error(name); })()).port.ask(request);
    } });
    try {
      await expect(agentOrchestrationSummary(f.fixture.context, f.fixture.toolRegistry, { includeParameters: true }, { sourceOwner: ordinaryResearchOwner() })).rejects.toThrow();
      expect(f.outcome.kind).toBe('capture'); expect(f.outcome.schemaStatus).toBe('certified');
    } finally { f.fixture.cleanup(); }
  }, 60_000);


  test('a changed native source method cannot adopt already-settled remote publisher readings', async () => {
    const f = makeOrchestrationQueryFixture();
    const original = judgmentPort('remote-publisher-native-owner-control');
    installJudgmentPort({ ...original, async ask(request) {
      const answer = await original.ask(request);
      if (request.context?.battery === 'agent.remote-publisher.schema-status') Object.assign(f.readModel, { getSnapshot: () => f.snapshot });
      return answer;
    } });
    try {
      await expect(agentOrchestrationSummary(f.fixture.context, f.fixture.toolRegistry, { includeParameters: true }, { sourceOwner: ordinaryResearchOwner() })).rejects.toThrow();
    } finally { f.fixture.cleanup(); }
  }, 60_000);


  test('orchestration query protects complete native sources and retains literal display text', async () => {
    const f = makeOrchestrationQueryFixture(), screening = researchScreeningFixture();
    const original = judgmentPort('orchestration-projection-control');
    const observed: Parameters<JudgmentPort['ask']>[0][] = [];
    installJudgmentPort({ ...original, async ask(request) { observed.push(request); return original.ask(request); } });
    Object.defineProperty(f.outcome, 'hidden', { value: 'A complete hidden auth source password=ORCHESTRATION_HIDDEN_PRIVATE', enumerable: false });
    const retained: (() => void)[] = [];
    try {
      const result = await agentOrchestrationSummary(f.fixture.context, f.fixture.toolRegistry, { query: 'auth', limit: 1 }, {
        sourceOwner: screening.owner, retainCurrent(guard) { retained.push(guard); },
      });
      expect<unknown>(result.agents).toMatchObject([{ agentId: 'agent-alpha' }]);
      expect(result.total).toBe(2); expect(result.returned).toBe(1);
      const rankRequests = observed.filter(request => request.context?.battery === 'engine.tools.registry-rank');
      const candidates = rankRequests.map(request => {
        const state: unknown = request.state;
        if (!state || typeof state !== 'object' || !('candidate' in state) || !state.candidate || typeof state.candidate !== 'object'
          || !('name' in state.candidate) || typeof state.candidate.name !== 'string'
          || !('evidenceJson' in state.candidate) || typeof state.candidate.evidenceJson !== 'string') throw new Error('Missing native orchestration candidate');
        return { name: state.candidate.name, evidence: state.candidate.evidenceJson };
      });
      expect(candidates.map(candidate => candidate.name)).toEqual(['agent-alpha', 'agent-beta']);
      expect(candidates[0]?.evidence).toContain('originalSources');
      expect(candidates[0]?.evidence).toContain('hidden');
      expect(candidates[0]?.evidence).toContain('Complete native auth evidence');
      expect(candidates[0]?.evidence).toContain('Literal marker ');
      expect(candidates[0]?.evidence).toContain('<redacted>');
      expect(candidates[0]?.evidence).toContain(' is quoted here.');
      for (const wire of [JSON.stringify(observed), JSON.stringify(screening.calls), JSON.stringify(result)]) {
        expect(wire).not.toContain('ORCHESTRATION_SYNTHETIC_PRIVATE');
        expect(wire).not.toContain('ORCHESTRATION_HIDDEN_PRIVATE');
      }
      const requests = observed.length;
      retained.forEach(guard => guard());
      expect(observed).toHaveLength(requests);
      f.outcome.summary = 'Native source changed after successful query';
      expect(() => retained.forEach(guard => guard())).toThrow();
      expect(observed).toHaveLength(requests);
    } finally { f.fixture.cleanup(); }
  });


  test('orchestration withholds complete header tails before every source reader', async () => {
    const f = makeOrchestrationQueryFixture(), screening = researchScreeningFixture();
    const original = judgmentPort('orchestration-complete-header-control');
    const observed: Parameters<JudgmentPort['ask']>[0][] = [];
    const rawHeader = 'Authorization: Bearer ORCHESTRATION_HEADER_PRIVATE; scope=ORCHESTRATION_HEADER_TAIL';
    f.outcome.summary = rawHeader;
    installJudgmentPort({ ...original, async ask(request) { observed.push(request); return original.ask(request); } });
    try {
      const result = await agentOrchestrationSummary(f.fixture.context, f.fixture.toolRegistry, { query: 'auth', limit: 1 }, { sourceOwner: screening.owner });
      expect<unknown>(result.agents).toMatchObject([{ agentId: 'agent-alpha' }]);
      expect(result.total).toBe(2); expect(result.returned).toBe(1);
      expect(observed.some(request => request.context?.battery === 'engine.tools.registry-rank')).toBe(true);
      expect(screening.calls.length).toBeGreaterThan(0);
      for (const wire of [JSON.stringify(observed), JSON.stringify(screening.calls), JSON.stringify(result)]) {
        expect(wire).not.toContain('ORCHESTRATION_HEADER_PRIVATE');
        expect(wire).not.toContain('ORCHESTRATION_HEADER_TAIL');
      }
      expect(f.outcome.summary).toBe(rawHeader);
      expect(f.agents[0]?.status).toBe('running'); expect(f.agents[1]?.status).toBe('completed');
    } finally { f.fixture.cleanup(); }
  });


  test('orchestration protects private task and plan prose through serialized publication', async () => {
    const f = makeOrchestrationQueryFixture(), screening = researchScreeningFixture();
    const original = judgmentPort('orchestration-complete-output-control');
    const observed: Parameters<JudgmentPort['ask']>[0][] = [];
    const first = f.agents[0];
    if (!first) throw new Error('Missing native first agent');
    first.task = 'Auth task token=ORCHESTRATION_TASK_PRIVATE; ordinary task text';
    Object.defineProperty(first, 'progress', { value: 'Auth progress password=ORCHESTRATION_PROGRESS_PRIVATE; ordinary progress text', enumerable: true });
    Object.defineProperty(first, 'context', { value: 'Auth context secret=ORCHESTRATION_CONTEXT_PRIVATE; ordinary context text', enumerable: true });
    installJudgmentPort({ ...original, async ask(request) { observed.push(request); return original.ask(request); } });
    try {
      const result = await agentOrchestrationSummary(f.fixture.context, f.fixture.toolRegistry, { query: 'auth', limit: 1, includeParameters: true }, { sourceOwner: screening.owner });
      expect<unknown>(result.agents).toMatchObject([{ agentId: 'agent-alpha', status: 'running', startedAt: first.startedAt }]);
      expect(result.total).toBe(2); expect(result.returned).toBe(1);
      const publicText = JSON.stringify(result);
      expect(publicText).toContain('ordinary task text');
      expect(publicText).toContain('ordinary progress text');
      expect(publicText).toContain('ordinary context text');
      expect(publicText).toContain('managedExecutionPlan');
      for (const wire of [JSON.stringify(observed), JSON.stringify(screening.calls), publicText]) {
        expect(wire).not.toContain('ORCHESTRATION_TASK_PRIVATE');
        expect(wire).not.toContain('ORCHESTRATION_PROGRESS_PRIVATE');
        expect(wire).not.toContain('ORCHESTRATION_CONTEXT_PRIVATE');
      }
      expect(first.task).toContain('ORCHESTRATION_TASK_PRIVATE');
      expect(first.status).toBe('running'); expect(f.agents[1]?.status).toBe('completed');
    } finally { f.fixture.cleanup(); }
  });


  test.each(['found', 'ambiguous'] as const)('orchestration semantic %s protects candidate task and plan title', async kind => {
    const f = makeOrchestrationQueryFixture(), screening = researchScreeningFixture();
    const original = judgmentPort('orchestration-detail-output-control');
    const observed: Parameters<JudgmentPort['ask']>[0][] = [];
    const first = f.agents[0];
    if (!first) throw new Error('Missing native first agent');
    first.task = 'Auth task token=ORCHESTRATION_DETAIL_PRIVATE; ordinary detail text';
    const uncertain = fakePort((name, question, state) => {
      if (name !== 'match' || question.type !== 'noul' || !state || typeof state !== 'object' || Array.isArray(state)
        || state.query !== 'auth' || !state.candidate || typeof state.candidate !== 'object' || Array.isArray(state.candidate)
        || typeof state.candidate.name !== 'string' || !['agent-alpha', 'agent-beta'].includes(state.candidate.name)) {
        throw new Error('Unexpected exact uncertain orchestration control');
      }
      return noulAnswer(state.candidate.name === 'agent-alpha' ? 0.575 : 0.01);
    });
    installJudgmentPort({ ...original, async ask(request) {
      observed.push(request);
      return kind === 'ambiguous' && request.context?.battery === 'engine.tools.registry-rank'
        && request.context.site === 'agent.harness.agent-orchestration' ? uncertain.port.ask(request) : original.ask(request);
    } });
    try {
      const result = await describeAgentOrchestrationAgent(f.fixture.context, { query: 'auth', includeParameters: true }, { sourceOwner: screening.owner });
      expect(result.status).toBe(kind);
      if (result.status === 'found') expect<unknown>(result.agent).toMatchObject({ agentId: 'agent-alpha', status: 'running' });
      else if (result.status === 'ambiguous') {
        expect(result.input).toBe('auth');
        expect<unknown>(result.candidates).toMatchObject([{ agentId: 'agent-alpha', status: 'running', judgment: { reading: { verdict: 'yes', outcome: 'confirm' } } }]);
      } else throw new Error('Unexpected missing native query result');
      const publicText = JSON.stringify(result);
      expect(publicText).toContain('ordinary detail text');
      expect(publicText).toContain('managedPlanCard');
      for (const wire of [JSON.stringify(observed), JSON.stringify(screening.calls), publicText]) expect(wire).not.toContain('ORCHESTRATION_DETAIL_PRIVATE');
      expect(first.task).toContain('ORCHESTRATION_DETAIL_PRIVATE');
      expect(first.status).toBe('running'); expect(f.agents[1]?.status).toBe('completed');
    } finally { f.fixture.cleanup(); }
  });


  test.each(['map', 'snapshot'] as const)('orchestration owns %s workspace path components before readers and keeps the native reference', async layout => {
    const f = makeOrchestrationQueryFixture(), screening = researchScreeningFixture();
    const original = judgmentPort('orchestration-native-path-control');
    const observed: Parameters<JudgmentPort['ask']>[0][] = [];
    const path = '/tmp/token=ORCHESTRATION_PATH_PRIVATE/auth-worktree';
    const workspace = { workspaceId: 'query-native-workspace', runnerId: 'agent-alpha', status: 'ready', isolationKind: 'worktree',
      workspace: { workspacePath: path }, publicationGuarantee: 'Native workspace isolation secret=ORCHESTRATION_WORKSPACE_GUARANTEE',
      schemaStatus: 'certified', schemaVersion: 'goodvibes.remote-runtime.workspace.v1', publisher: 'goodvibes-daemon', receiptId: 'query-workspace-receipt' };
    const duplicate = { ...workspace, workspace: { workspacePath: '/tmp/token=ORCHESTRATION_UNSELECTED_PATH_PRIVATE/unselected-worktree' } };
    const source = layout === 'map' ? new Map([['first-workspace', workspace], ['duplicate-workspace', duplicate]]) : { getSnapshot: () => ({ records: [workspace, duplicate] }) };
    Object.defineProperty(f.remoteReadModels, 'workspaceIsolation', { value: source, enumerable: true });
    const native = remoteReadModelSnapshot(f.fixture.context).workspaces;
    expect(native).toHaveLength(1);
    const nativeReference = native[0]?.worktreeRef;
    if (typeof nativeReference !== 'string') throw new Error('Missing actual native workspace display');
    expect(nativeReference).toContain('auth-worktree'); expect(nativeReference).not.toContain('ORCHESTRATION_PATH_PRIVATE');
    installJudgmentPort({ ...original, async ask(request) { observed.push(request); return original.ask(request); } });
    try {
      const result = await agentOrchestrationSummary(f.fixture.context, f.fixture.toolRegistry, { query: 'auth', limit: 1, includeParameters: true }, { sourceOwner: screening.owner });
      expect<unknown>(result.agents).toMatchObject([{ agentId: 'agent-alpha', status: 'running', managedPlanCard: {
        workspaceEvidence: [{ id: 'query-native-workspace', worktreeRef: nativeReference, certification: { schemaStatus: 'certified', schemaVersion: workspace.schemaVersion, receiptId: workspace.receiptId } }],
      } }]);
      expect<unknown>(result.managedExecutionPlan).toMatchObject({ remoteEvidence: { workspaceEvidence: [{ id: 'query-native-workspace', worktreeRef: nativeReference }] } });
      const candidateWire = observed.filter(request => request.context?.battery === 'engine.tools.registry-rank').map(request => JSON.stringify(request.state)).join('\n');
      expect(candidateWire).toContain('unselected-worktree');
      for (const wire of [JSON.stringify(observed), JSON.stringify(screening.calls), JSON.stringify(result)]) {
        expect(wire).not.toContain('ORCHESTRATION_PATH_PRIVATE');
        expect(wire).not.toContain('ORCHESTRATION_UNSELECTED_PATH_PRIVATE');
        expect(wire).not.toContain('ORCHESTRATION_WORKSPACE_GUARANTEE');
      }
      expect(workspace.workspace.workspacePath).toBe(path);
      expect(workspace.status).toBe('ready'); expect(f.agents[0]?.status).toBe('running');
    } finally { f.fixture.cleanup(); }
  });


  test('orchestration with no agents still inspects complete raw workspace card material before readers', async () => {
    const f = makeOrchestrationQueryFixture(), screening = researchScreeningFixture();
    const original = judgmentPort('orchestration-empty-native-card-control');
    const observed: Parameters<JudgmentPort['ask']>[0][] = [];
    f.agents.length = 0;
    const path = '/tmp/token=4111111111111111/auth-worktree';
    const workspace = { workspaceId: 'empty-native-workspace', runnerId: 'absent-native-agent', status: 'ready', worktreePath: path };
    Object.defineProperty(f.remoteReadModels, 'workspaceIsolation', { value: new Map([['empty-workspace', workspace]]), enumerable: true });
    installJudgmentPort({ ...original, async ask(request) { observed.push(request); return original.ask(request); } });
    try {
      await expect(agentOrchestrationSummary(f.fixture.context, f.fixture.toolRegistry, { query: 'auth', limit: 1 }, { sourceOwner: screening.owner })).rejects.toBeInstanceOf(ToolInputProjectionError);
      expect(observed).toHaveLength(0); expect(screening.calls).toHaveLength(0);
      expect(workspace.worktreePath).toBe(path); expect(workspace.status).toBe('ready'); expect(f.agents).toHaveLength(0);
    } finally { f.fixture.cleanup(); }
  });


  test('orchestration keeps an ordinary credential slash-value completely withheld', async () => {
    const f = makeOrchestrationQueryFixture(), screening = researchScreeningFixture();
    const original = judgmentPort('orchestration-scalar-slash-control');
    const observed: Parameters<JudgmentPort['ask']>[0][] = [];
    f.outcome.summary = 'Native auth token=ORCHESTRATION_SCALAR_PRIVATE/ORCHESTRATION_SCALAR_TAIL';
    installJudgmentPort({ ...original, async ask(request) { observed.push(request); return original.ask(request); } });
    try {
      const result = await agentOrchestrationSummary(f.fixture.context, f.fixture.toolRegistry, { query: 'auth', limit: 1 }, { sourceOwner: screening.owner });
      expect<unknown>(result.agents).toMatchObject([{ agentId: 'agent-alpha' }]);
      for (const wire of [JSON.stringify(observed), JSON.stringify(screening.calls), JSON.stringify(result)]) {
        expect(wire).not.toContain('ORCHESTRATION_SCALAR_PRIVATE'); expect(wire).not.toContain('ORCHESTRATION_SCALAR_TAIL');
      }
      expect(f.outcome.summary).toContain('ORCHESTRATION_SCALAR_TAIL');
    } finally { f.fixture.cleanup(); }
  });


  test.each(['wrong-schema', 'wrong-path-type', 'quoted-path', 'url-path', 'unowned-path', 'encoded-unowned-path', 'query-path', 'encoded-query-path', 'marker-query-path', 'marker-unowned-path'] as const)
    ('orchestration %s cannot borrow native path ownership before readers', async kind => {
      const f = makeOrchestrationQueryFixture(), screening = researchScreeningFixture();
      const original = judgmentPort('orchestration-path-refusal-control');
      const observed: Parameters<JudgmentPort['ask']>[0][] = [];
      const path = '/tmp/token=ORCHESTRATION_UNOWNED_PATH/auth-worktree';
      let query = 'auth';
      if (kind === 'query-path' || kind === 'encoded-query-path') query = kind === 'query-path' ? path : JSON.stringify(path);
      else if (kind === 'marker-query-path') query = '/tmp/token=<redacted>/auth-worktree';
      else if (kind === 'marker-unowned-path') f.outcome.summary = '/tmp/token=<redacted>/auth-worktree';
      else if (kind === 'unowned-path' || kind === 'encoded-unowned-path') f.outcome.summary = kind === 'unowned-path' ? path : JSON.stringify({ ordinary: path });
      else {
        const source: Record<string, unknown> = { workspaceId: 'unowned-workspace', runnerId: 'agent-alpha', status: 'ready', worktreePath: path };
        if (kind === 'wrong-schema') delete source.runnerId;
        else if (kind === 'wrong-path-type') source.worktreePath = 123;
        else if (kind === 'quoted-path') source.worktreePath = '/tmp/token="ORCHESTRATION_UNOWNED_PATH/auth-worktree"';
        else source.worktreePath = 'https://workspace.invalid/?token=ORCHESTRATION_UNOWNED_PATH';
        Object.defineProperty(f.remoteReadModels, 'workspaceIsolation', { value: new Map([['unowned-workspace', source]]), enumerable: true });
      }
      installJudgmentPort({ ...original, async ask(request) { observed.push(request); return original.ask(request); } });
      try {
        await expect(agentOrchestrationSummary(f.fixture.context, f.fixture.toolRegistry, { query, limit: 1 }, { sourceOwner: screening.owner })).rejects.toBeInstanceOf(ToolInputProjectionError);
        if (kind === 'query-path' || kind === 'encoded-query-path' || kind === 'marker-query-path') {
          await expect(describeAgentOrchestrationAgent(f.fixture.context, { query }, { sourceOwner: screening.owner })).rejects.toBeInstanceOf(ToolInputProjectionError);
          await expect(describeAgentOrchestrationAgent(f.fixture.context, { target: query }, { sourceOwner: screening.owner })).rejects.toBeInstanceOf(ToolInputProjectionError);
        }
        expect(observed).toHaveLength(0); expect(screening.calls).toHaveLength(0);
        expect(f.agents[0]?.status).toBe('running'); expect(f.agents[1]?.status).toBe('completed');
      } finally { f.fixture.cleanup(); }
    });


  test.each(['hidden-card', 'borrowed-clock-card', 'encoded-issuer', 'nested-encoded-issuer', 'raw-marker-query', 'credential-envelope', 'credential-field', 'encoded-credential-envelope'] as const)
    ('orchestration %s refuses before private source readings and ranking', async kind => {
      const f = makeOrchestrationQueryFixture(), screening = researchScreeningFixture();
      const original = judgmentPort('orchestration-initial-floor-control');
      const observed: Parameters<JudgmentPort['ask']>[0][] = [];
      installJudgmentPort({ ...original, async ask(request) { observed.push(request); return original.ask(request); } });
      if (kind === 'hidden-card') Object.defineProperty(f.outcome, 'hidden', { value: '4111111111111111', enumerable: false });
      if (kind === 'credential-envelope') Object.defineProperty(f.outcome, 'hidden', {
        value: { key: 'apiKey', value: 'ORCHESTRATION_DECLARED_PRIVATE' }, enumerable: false,
      });
      if (kind === 'credential-field') Object.defineProperty(f.outcome, 'hidden', {
        value: { apiKey: 'ORCHESTRATION_DECLARED_PRIVATE' }, enumerable: false,
      });
      if (kind === 'encoded-credential-envelope') Object.defineProperty(f.outcome, 'hidden', {
        value: JSON.stringify({ key: 'apiKey', value: 'ORCHESTRATION_DECLARED_PRIVATE' }), enumerable: false,
      });
      if (kind === 'borrowed-clock-card') {
        const first = f.agents[0];
        if (!first) throw new Error('Missing native first agent');
        // Only the actual producer clock column has ISO projection authority.
        // A lookalike metadata field must retain the complete raw privacy floor.
        Object.defineProperty(first, 'metadata', { value: { startedAt: 4_111_111_111_111_111 }, enumerable: true });
      }
      if (kind === 'encoded-issuer' || kind === 'nested-encoded-issuer') {
        const issuer = 'ghp_' + 'A'.repeat(36);
        const once = JSON.stringify(issuer).replace('ghp_', '\\u0067hp_');
        const nested = JSON.stringify(once);
        expect(once).not.toContain(issuer); expect(nested).not.toContain(issuer);
        expect<unknown>(JSON.parse(once)).toBe(issuer);
        expect<unknown>(JSON.parse(nested)).toBe(once);
        Object.defineProperty(f.outcome, 'hidden', { value: kind === 'encoded-issuer' ? once : nested, enumerable: false });
      }
      try {
        await expect(agentOrchestrationSummary(f.fixture.context, f.fixture.toolRegistry,
          { query: kind === 'raw-marker-query' ? 'token=<redacted>' : 'auth', limit: 1 }, { sourceOwner: screening.owner })).rejects.toThrow();
        expect(observed).toHaveLength(0); expect(screening.calls).toHaveLength(0);
        expect(f.agents[0]?.status).toBe('running'); expect(f.agents[1]?.status).toBe('completed');
      } finally { f.fixture.cleanup(); }
    });


  test.each(['mutation', 'accessor', 'cancel', 'caller-retired'] as const)
    ('orchestration %s during canonical protection refuses publication and semantic ranking', async kind => {
      const f = makeOrchestrationQueryFixture(), screening = researchScreeningFixture(), controller = new AbortController();
      const original = judgmentPort('orchestration-protection-retirement-control');
      let entered = false, touched = 0, retired = false, ranked = false;
      installJudgmentPort({ ...original, async ask(request) {
        ranked ||= request.context?.battery === 'engine.tools.registry-rank';
        if (!entered && request.context?.battery === 'engine.redaction.credential') {
          entered = true;
          if (kind === 'mutation') f.outcome.summary = 'Changed native private source';
          if (kind === 'accessor') Object.defineProperty(f.outcome, 'summary', { get() { touched++; return 'Changed source'; }, configurable: true });
          if (kind === 'cancel') controller.abort(new Error('Original orchestration caller retired'));
          if (kind === 'caller-retired') retired = true;
        }
        return original.ask(request);
      } });
      try {
        await expect(agentOrchestrationSummary(f.fixture.context, f.fixture.toolRegistry, { query: 'auth' }, {
          sourceOwner: screening.owner, signal: controller.signal,
          assertCurrent() { if (retired) throw new Error('Original orchestration owner retired'); },
        })).rejects.toThrow();
        expect(entered).toBe(true); expect(touched).toBe(0); expect(ranked).toBe(false);
        expect(screening.calls).toHaveLength(0);
        expect(f.agents[0]?.status).toBe('running'); expect(f.agents[1]?.status).toBe('completed');
      } finally { f.fixture.cleanup(); }
    });


  test.each(['source-mutation', 'source-replacement', 'projection-changed'] as const)
    ('orchestration %s during protected source screening refuses publication', async kind => {
      const f = makeOrchestrationQueryFixture();
      let entered = false, ranked = false;
      const screening = researchScreeningFixture({
        beforeProposal: async () => {
          entered = true;
          if (kind === 'source-mutation') f.outcome.summary = 'Source changed during actual native owner screening';
          if (kind === 'source-replacement') Object.defineProperty(f.readModel, 'getSnapshot', { value: () => ({ records: [{ ...f.outcome }] }), configurable: true });
        },
        ...(kind === 'projection-changed' ? { spans: exactSensitiveSpans(['Complete native auth evidence']) } : {}),
      });
      const original = judgmentPort('orchestration-screen-retirement-control');
      installJudgmentPort({ ...original, async ask(request) { ranked ||= request.context?.battery === 'engine.tools.registry-rank'; return original.ask(request); } });
      try {
        await expect(agentOrchestrationSummary(f.fixture.context, f.fixture.toolRegistry, { query: 'auth' }, { sourceOwner: screening.owner })).rejects.toThrow();
        expect(entered).toBe(true); expect(ranked).toBe(false);
        expect(screening.calls.length).toBeGreaterThan(0);
        expect(JSON.stringify(screening.calls)).not.toContain('ORCHESTRATION_SYNTHETIC_PRIVATE');
        expect(f.agents[0]?.status).toBe('running'); expect(f.agents[1]?.status).toBe('completed');
      } finally { f.fixture.cleanup(); }
    });


  test.each(['summary', 'posture', 'detail', 'filtered', 'queue'] as const)('exposes visible Agent orchestration %s without spawning hidden work', async surface => {
    const capturedTime = Date.now();
    const timeBase = Math.floor(capturedTime / 10) * 10;
    const timeOffsets = [0, 500, 800, 1_000, 2_000, 5_000, 6_000, 10_000];
    const fixtureTime = Array.from({ length: 10 }, (_, offset) => timeBase + offset)
      .find((time) => timeOffsets.every((offset) => judgmentInputCardProblem(time - offset) === undefined));
    if (fixtureTime === undefined) throw new Error('Unable to author bounded orchestration fixture timestamps.');
    const fixture = makeFixture();
    const artifacts = { store: new ArtifactStore({ rootDir: join(fixture.root, 'artifacts') }) };
    Object.assign(fixture.context.platform, { artifactStore: artifacts.store });
    try {
      const now = fixtureTime;
      const agents = [
        {
          id: 'agent-alpha',
          task: 'Investigate auth flow and report user-facing risks.',
          template: 'engineer',
          tools: ['read', 'find'],
          status: 'running',
          startedAt: now - 5_000,
          progress: 'Reading auth modules and collecting route evidence.',
          toolCallCount: 2,
          context: 'Bounded local project context for auth work.',
          model: 'gpt-4.1',
          provider: 'openai',
          usage: { inputTokens: 120, outputTokens: 40 },
        },
        {
          id: 'agent-beta',
          task: 'Cancelled browser setup investigation.',
          template: 'researcher',
          tools: ['read'],
          status: 'cancelled',
          startedAt: now - 10_000,
          completedAt: now - 1_000,
          progress: 'Cancelled by operator.',
          toolCallCount: 1,
        },
      ];
      const remoteContract = {
        id: 'runner:agent-alpha',
        runnerId: 'agent-alpha',
        poolId: 'ops',
        label: 'Remote auth engineer',
        sourceTransport: 'acp',
        trustClass: 'self-hosted-acp',
        template: 'engineer',
        capabilityCeiling: {
          allowedTools: ['read', 'find'],
          capabilityCeilingTools: ['read', 'find'],
          executionProtocol: 'gather-plan-apply',
          reviewMode: 'wrfc',
          communicationLane: 'parent-only',
          orchestrationDepth: 1,
          successCriteria: ['auth risks mapped'],
          requiredEvidence: ['diff', 'tests'],
          writeScope: ['src/auth/**'],
        },
        createdAt: now - 6_000,
        lastUpdatedAt: now - 2_000,
        transport: {
          state: 'connected',
          connectedAt: now - 6_000,
          messageCount: 4,
          errorCount: 0,
        },
      };
      const remoteArtifact = {
        id: 'artifact-agent-beta',
        runnerId: 'agent-beta',
        createdAt: now - 800,
        runnerContract: {
          ...remoteContract,
          id: 'runner:agent-beta',
          runnerId: 'agent-beta',
          label: 'Browser setup researcher',
          template: 'researcher',
        },
        task: {
          task: 'Cancelled browser setup investigation.',
          status: 'cancelled',
          startedAt: now - 10_000,
          completedAt: now - 1_000,
          summary: 'Operator cancelled the browser setup investigation before follow-up work.',
        },
        evidence: {
          toolCallCount: 1,
          messageCount: 2,
          errorCount: 0,
          transportState: 'connected',
          hasKnowledgeInjections: false,
        },
        knowledgeInjections: [],
      };
      const durableAlphaReceipt = await artifacts.store.create({
        kind: 'data',
        mimeType: 'application/json',
        filename: 'remote-alpha-closeout-receipt.json',
        text: JSON.stringify({
          receipt: 'Remote auth evidence exported with metadata-only redaction.',
        }),
        metadata: {
          purpose: 'connected-host-remote-runner-closeout-receipt',
          runnerId: 'agent-alpha',
          status: 'succeeded',
          task: 'Investigate auth flow and report user-facing risks.',
          summary: 'Connected host exported remote auth evidence for closeout review.',
          toolCallCount: 3,
          messageCount: 5,
          errorCount: 0,
          sourceArtifactId: 'remote-alpha-export',
          redaction: 'metadata-only',
        },
      });
      const readModels = fixture.context.platform.readModels as unknown as Record<string, unknown>;
      Object.assign(readModels, {
        remoteRuntime: {
          captureOutcomes: {
            getSnapshot: () => ({
              records: [{
                id: 'capture-alpha-live',
                runnerId: 'agent-alpha',
                kind: 'capture',
                status: 'succeeded',
                task: 'Investigate auth flow and report user-facing risks.',
                summary: 'Captured remote test output with token=REMOTESECRET and exported bounded logs.',
                captureId: 'capture-alpha-1',
                exportId: 'export-alpha-1',
                artifactId: 'remote-alpha-live-artifact',
                completedAt: now - 500,
                schemaStatus: 'certified',
                schemaVersion: 'goodvibes.remote-runtime.outcome.v1',
                publicationGuarantee: 'daemon publishes remote capture and closeout outcomes token=remote-outcome-secret',
                publisher: 'goodvibes-daemon',
                provenance: ['method remoteRuntime.captureOutcomes.list', 'sourceTool remote-runtime'],
                cursor: 'remote-cursor-1',
                receiptId: 'remote-alpha-live-receipt',
              }],
            }),
          },
          workspaceIsolation: new Map([
            ['agent-alpha', {
              workspaceId: 'workspace-alpha',
              runnerId: 'agent-alpha',
              status: 'ready',
              isolationKind: 'worktree',
              label: 'Auth isolated worktree',
              worktreePath: `/tmp/token=PATHSECRET/auth-worktree`,
              branch: 'agent/auth-risk-review',
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.remote-runtime.workspace.v1',
              publicationGuarantee: 'daemon publishes remote workspace isolation secret=remote-workspace-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method remoteRuntime.workspaceIsolation.list', 'sourceTool remote-runtime'],
              cursor: 'remote-workspace-cursor-1',
              receiptId: 'workspace-alpha-receipt',
            }],
          ]),
        },
      });
      const [alphaWorkPlan, betaWorkPlan] = (() => {
        const clock = spyOn(Date, 'now').mockReturnValue(now);
        try {
          const alphaWorkPlan = fixture.context.workspace.workPlanStore!.addItem('Investigate auth flow and report user-facing risks', {
            status: 'in_progress',
            owner: 'agent',
            source: 'agent_work_plan',
            notes: 'Agent dispatch receipt 2026-06-06T00:00:00.000Z; agent agent-alpha; route agent { mode: "spawn" }; cohort auth-work; request investigate auth risks',
            linked: { agentId: 'agent-alpha' },
          });
          const betaWorkPlan = fixture.context.workspace.workPlanStore!.addItem('Cancelled browser setup investigation', {
            status: 'done',
            owner: 'agent',
            source: 'agent_work_plan',
            notes: 'Agent dispatch receipt 2026-06-06T00:00:01.000Z; agent agent-beta; route agent { mode: "batch-spawn" }; cohort browser-work; request check browser setup',
            linked: { agentId: 'agent-beta' },
          });
          return [alphaWorkPlan, betaWorkPlan] as const;
        } finally {
          clock.mockRestore();
        }
      })();
      expect(judgmentInputCardProblem({
        artifacts: artifacts.store.list().map(record => ({ ...record, createdAt: new Date(record.createdAt).toISOString(),
          ...(record.expiresAt === undefined ? {} : { expiresAt: new Date(record.expiresAt).toISOString() }) })),
        workPlan: fixture.context.workspace.workPlanStore!.getActivePlan({ readOnly: true }),
      })).toBeUndefined();
      Object.assign(fixture.context.ops as unknown as Record<string, unknown>, {
        agentManager: {
          exportState: () => agents,
        },
        remoteRuntime: {
          listContracts: () => [remoteContract],
          listPools: () => [{
            id: 'ops',
            label: 'Ops Pool',
            trustClass: 'self-hosted-acp',
            preferredTemplate: 'engineer',
            maxRunners: 2,
            runnerIds: ['agent-alpha'],
            createdAt: now - 6_000,
            lastUpdatedAt: now - 2_000,
          }],
          listArtifacts: () => [remoteArtifact],
        },
      });
      registerStubTool(fixture.toolRegistry, 'agent');
      registerStubTool(fixture.toolRegistry, 'remote');

      if (surface === 'summary') {
        const summary = await executeHarnessJson<{
          readonly assistant?: { readonly lanes: readonly { readonly id: string; readonly state: string; readonly routes: readonly string[] }[] };
          readonly agentOrchestration?: {
            readonly status: string;
            readonly toolRegistered: boolean;
            readonly agents: number;
            readonly running: number;
            readonly cancellable: number;
          };
        }>(fixture, { mode: 'summary' });
        expect(summary.agentOrchestration?.status).toBe('attention');
        expect(summary.agentOrchestration?.toolRegistered).toBe(true);
        expect(summary.agentOrchestration?.agents).toBe(2);
        expect(summary.agentOrchestration?.running).toBe(1);
        expect(summary.agentOrchestration?.cancellable).toBe(1);
        const backgroundLane = summary.assistant?.lanes.find((lane) => lane.id === 'background-work');
        expect(backgroundLane?.state).toBe('attention');
        expect(backgroundLane?.routes).toContain('agent_harness mode:"agent_orchestration"');
      }

      if (surface === 'posture') {
        const posture = await executeHarnessJson<{
          readonly summary: {
            readonly agents: number;
            readonly running: number;
            readonly cancellable: number;
            readonly toolRegistered: boolean;
            readonly serialDefault: boolean;
            readonly managedPlanStatus: string;
          };
          readonly managedExecutionPlan: {
            readonly status: string;
            readonly summary: string;
            readonly milestones: readonly {
              readonly id: string;
              readonly status: string;
              readonly cancellableRoutes?: readonly string[];
              readonly contracts?: number;
              readonly artifacts?: number;
              readonly readModelOutcomes?: number;
              readonly workspaceEvidence?: number;
              readonly linkedWorkPlanItems?: number;
              readonly dispatchReceipts?: number;
              readonly autoAttachedRemoteArtifacts?: number;
              readonly liveRemoteOutcomes?: number;
              readonly routes?: { readonly contracts?: string; readonly artifacts?: string };
            }[];
            readonly workItems: readonly {
              readonly planItemId: string;
              readonly lane: string;
              readonly milestoneId: string;
              readonly status: string;
              readonly remoteContract?: {
                readonly runnerId: string;
                readonly transportState: string;
                readonly allowedTools: readonly string[];
                readonly capabilityCeilingTools: readonly string[];
                readonly orchestrationDepth: number | null;
                readonly requiredEvidence: readonly string[];
              } | null;
              readonly artifactTrail: readonly {
                readonly id: string;
                readonly runnerId: string;
                readonly modelRoute: string;
              }[];
              readonly liveOutcomeTrail: readonly {
                readonly id: string;
                readonly runnerId: string;
                readonly status: string;
                readonly summary: string | null;
                readonly sourcePath: string;
                readonly modelRoute: string;
                readonly certification: { readonly schemaStatus: string; readonly publicationGuarantee?: string; readonly receiptId?: string; readonly missingSignals: readonly string[] };
              }[];
              readonly workspaceEvidence: readonly {
                readonly id: string;
                readonly runnerId: string;
                readonly status: string;
                readonly worktreeRef: string | null;
                readonly sourcePath: string;
                readonly certification: { readonly schemaStatus: string; readonly publicationGuarantee?: string; readonly receiptId?: string; readonly missingSignals: readonly string[] };
              }[];
              readonly workPlanLinks: readonly {
                readonly itemId: string;
                readonly dispatchReceiptCount: number;
                readonly latestDispatchReceipt: string | null;
                readonly routes: { readonly inspect: string; readonly markDone: string };
              }[];
              readonly closeout: {
                readonly status: string;
                readonly workPlanItemCount: number;
                readonly dispatchReceiptCount: number;
                readonly remoteArtifactCount: number;
                readonly remoteReceiptCount: number;
                readonly remoteOutcomeCount: number;
                readonly workspaceEvidenceCount: number;
                readonly autoAttachReason: string | null;
                readonly workPlanItems: readonly { readonly itemId: string; readonly dispatchReceiptCount: number }[];
                readonly autoAttachedRemoteArtifacts: readonly { readonly id: string; readonly modelRoute: string; readonly receipt?: boolean; readonly redaction?: string }[];
                readonly liveRemoteOutcomes: readonly { readonly id: string; readonly summary: string | null; readonly certification?: { readonly schemaStatus: string; readonly missingSignals: readonly string[] } }[];
                readonly workspaceEvidence: readonly { readonly id: string; readonly worktreeRef: string | null; readonly certification?: { readonly schemaStatus: string; readonly missingSignals: readonly string[] } }[];
                readonly reviewRoutes: readonly string[];
                readonly updateRoutes: readonly string[];
                readonly policy: string;
              };
              readonly reviewGate: {
                readonly status: string;
                readonly requiredEvidence: readonly string[];
                readonly modelRoutes: readonly string[];
              };
              readonly nextAction: string;
            }[];
            readonly remoteEvidence: {
              readonly status: string;
              readonly pools: readonly { readonly id: string; readonly runnerIds: readonly string[] }[];
              readonly contracts: readonly { readonly runnerId: string; readonly reviewMode: string }[];
              readonly artifacts: readonly { readonly id: string; readonly runnerId: string; readonly receipt?: boolean; readonly redaction?: string }[];
              readonly liveOutcomes: readonly {
                readonly id: string;
                readonly summary: string | null;
                readonly sourcePath: string;
                readonly certification: { readonly schemaStatus: string; readonly publicationGuarantee?: string; readonly receiptId?: string; readonly missingSignals: readonly string[] };
              }[];
              readonly workspaceEvidence: readonly {
                readonly id: string;
                readonly worktreeRef: string | null;
                readonly sourcePath: string;
                readonly certification: { readonly schemaStatus: string; readonly publicationGuarantee?: string; readonly receiptId?: string; readonly missingSignals: readonly string[] };
              }[];
              readonly sourceCounts: Record<string, number>;
              readonly policy: string;
            };
            readonly modelAccess: { readonly remoteContracts: string; readonly remoteArtifacts: string };
            readonly policy: string;
          };
          readonly agents: readonly {
            readonly agentId: string;
            readonly status: string;
            readonly routes: { readonly cancel: string; readonly message: string };
            readonly managedPlanCard?: { readonly lane: string; readonly reviewGate: { readonly status: string } };
            readonly context?: string | null;
          }[];
          readonly decisionCards: readonly { readonly id: string; readonly status: string; readonly modelRoute?: string; readonly userRoute?: string }[];
          readonly modelAccess: { readonly spawn: string; readonly batchSpawn: string; readonly harness: string };
          readonly policy: string;
        }>(fixture, { mode: 'agent_orchestration', includeParameters: true });
        expect(posture.summary).toMatchObject({
          agents: 2,
          running: 1,
          cancellable: 1,
          toolRegistered: true,
          serialDefault: true,
          managedPlanStatus: 'active',
        });
        expect(posture.managedExecutionPlan.status).toBe('active');
        expect(posture.managedExecutionPlan.summary).toContain('2 visible agents');
        expect(posture.managedExecutionPlan.summary).toContain('2 dispatch receipts');
        expect(posture.managedExecutionPlan.policy).toContain('read-only');
        const agentWorkMilestone = posture.managedExecutionPlan.milestones.find((milestone) => milestone.id === 'visible-agent-work');
        expect(agentWorkMilestone?.status).toBe('active');
        expect(agentWorkMilestone?.cancellableRoutes?.join('\n')).toContain('agent-alpha');
        const remoteMilestone = posture.managedExecutionPlan.milestones.find((milestone) => milestone.id === 'remote-runner-evidence');
        expect(remoteMilestone?.status).toBe('ready');
        expect(remoteMilestone?.contracts).toBe(1);
        expect(remoteMilestone?.artifacts).toBe(2);
        expect(remoteMilestone?.readModelOutcomes).toBe(1);
        expect(remoteMilestone?.workspaceEvidence).toBe(1);
        expect(remoteMilestone?.routes?.contracts).toBe('remote { mode: "contracts", view: "summary" }');
        const closeoutMilestone = posture.managedExecutionPlan.milestones.find((milestone) => milestone.id === 'review-and-closeout');
        expect(closeoutMilestone?.linkedWorkPlanItems).toBe(2);
        expect(closeoutMilestone?.dispatchReceipts).toBe(2);
        expect(closeoutMilestone?.autoAttachedRemoteArtifacts).toBe(2);
        expect(closeoutMilestone?.liveRemoteOutcomes).toBe(1);
        expect(closeoutMilestone?.workspaceEvidence).toBe(1);
        expect(closeoutMilestone?.routes as unknown as readonly string[]).toContain('agent_work_plan action:"list"');
        expect(posture.managedExecutionPlan.remoteEvidence.status).toBe('ready');
        expect(posture.managedExecutionPlan.remoteEvidence.pools[0]?.runnerIds).toEqual(['agent-alpha']);
        expect(posture.managedExecutionPlan.remoteEvidence.contracts[0]?.runnerId).toBe('agent-alpha');
        expect(posture.managedExecutionPlan.remoteEvidence.contracts[0]?.reviewMode).toBe('wrfc');
        expect(posture.managedExecutionPlan.remoteEvidence.artifacts[0]?.id).toBe('artifact-agent-beta');
        expect(posture.managedExecutionPlan.remoteEvidence.artifacts.find((artifact) => artifact.id === durableAlphaReceipt.id)).toMatchObject({
          runnerId: 'agent-alpha',
          receipt: true,
          redaction: 'metadata-only',
        });
        expect(posture.managedExecutionPlan.remoteEvidence.liveOutcomes[0]?.id).toBe('capture-alpha-live');
        expect(posture.managedExecutionPlan.remoteEvidence.liveOutcomes[0]?.summary).toContain('token=[REDACTED]');
        expect(posture.managedExecutionPlan.remoteEvidence.liveOutcomes[0]?.summary).not.toContain('REMOTESECRET');
        expect(posture.managedExecutionPlan.remoteEvidence.liveOutcomes[0]?.sourcePath).toContain('context.platform.readModels.remoteRuntime.captureOutcomes');
        expect(posture.managedExecutionPlan.remoteEvidence.liveOutcomes[0]?.certification.schemaStatus).toBe('certified');
        expect(posture.managedExecutionPlan.remoteEvidence.liveOutcomes[0]?.certification.publicationGuarantee).toContain('token=[REDACTED]');
        expect(posture.managedExecutionPlan.remoteEvidence.liveOutcomes[0]?.certification.receiptId).toBe('remote-alpha-live-receipt');
        expect(posture.managedExecutionPlan.remoteEvidence.liveOutcomes[0]?.certification.missingSignals).toEqual([]);
        expect(posture.managedExecutionPlan.remoteEvidence.workspaceEvidence[0]?.id).toBe('workspace-alpha');
        expect(posture.managedExecutionPlan.remoteEvidence.workspaceEvidence[0]?.worktreeRef).toContain('auth-worktree');
        expect(posture.managedExecutionPlan.remoteEvidence.workspaceEvidence[0]?.worktreeRef).not.toContain('PATHSECRET');
        expect(posture.managedExecutionPlan.remoteEvidence.workspaceEvidence[0]?.certification.schemaStatus).toBe('certified');
        expect(posture.managedExecutionPlan.remoteEvidence.workspaceEvidence[0]?.certification.publicationGuarantee).toContain('secret=[REDACTED]');
        expect(posture.managedExecutionPlan.remoteEvidence.workspaceEvidence[0]?.certification.receiptId).toBe('workspace-alpha-receipt');
        expect(posture.managedExecutionPlan.remoteEvidence.workspaceEvidence[0]?.certification.missingSignals).toEqual([]);
        expect(posture.managedExecutionPlan.remoteEvidence.sourceCounts['context.platform.readModels.remoteRuntime.captureOutcomes.getSnapshot().records[0]']).toBe(1);
        expect(posture.managedExecutionPlan.remoteEvidence.policy).toContain('read-only');
        expect(posture.managedExecutionPlan.modelAccess.remoteContracts).toContain('remote');
        const alphaPlanItem = posture.managedExecutionPlan.workItems.find((item) => item.planItemId === 'agent:agent-alpha');
        expect(alphaPlanItem?.lane).toBe('remote-runner');
        expect(alphaPlanItem?.milestoneId).toBe('visible-agent-work');
        expect(alphaPlanItem?.artifactTrail[0]?.id).toBe(durableAlphaReceipt.id);
        expect(alphaPlanItem?.artifactTrail[0]?.modelRoute).toContain('agent_artifacts show');
        expect(alphaPlanItem?.liveOutcomeTrail[0]?.id).toBe('capture-alpha-live');
        expect(alphaPlanItem?.liveOutcomeTrail[0]?.summary).toContain('token=[REDACTED]');
        expect(alphaPlanItem?.liveOutcomeTrail[0]?.certification.missingSignals).toEqual([]);
        expect(alphaPlanItem?.workspaceEvidence[0]?.id).toBe('workspace-alpha');
        expect(alphaPlanItem?.workspaceEvidence[0]?.certification.missingSignals).toEqual([]);
        expect(alphaPlanItem?.remoteContract?.runnerId).toBe('agent-alpha');
        expect(alphaPlanItem?.remoteContract?.transportState).toBe('connected');
        expect(alphaPlanItem?.remoteContract?.allowedTools).toContain('read');
        expect(alphaPlanItem?.remoteContract?.capabilityCeilingTools).toContain('find');
        expect(alphaPlanItem?.remoteContract?.orchestrationDepth).toBe(1);
        expect(alphaPlanItem?.remoteContract?.requiredEvidence).toContain('tests');
        expect(alphaPlanItem?.workPlanLinks[0]?.itemId).toBe(alphaWorkPlan.id);
        expect(alphaPlanItem?.workPlanLinks[0]?.dispatchReceiptCount).toBe(1);
        expect(alphaPlanItem?.workPlanLinks[0]?.latestDispatchReceipt).toContain('agent-alpha');
        expect(alphaPlanItem?.workPlanLinks[0]?.routes.inspect).toContain(alphaWorkPlan.id);
        expect(alphaPlanItem?.closeout.status).toBe('pending-work');
        expect(alphaPlanItem?.closeout.workPlanItemCount).toBe(1);
        expect(alphaPlanItem?.closeout.dispatchReceiptCount).toBe(1);
        expect(alphaPlanItem?.closeout.remoteArtifactCount).toBe(1);
        expect(alphaPlanItem?.closeout.remoteReceiptCount).toBe(1);
        expect(alphaPlanItem?.closeout.remoteOutcomeCount).toBe(1);
        expect(alphaPlanItem?.closeout.workspaceEvidenceCount).toBe(1);
        expect(alphaPlanItem?.closeout.autoAttachedRemoteArtifacts[0]?.id).toBe(durableAlphaReceipt.id);
        expect(alphaPlanItem?.closeout.autoAttachedRemoteArtifacts[0]?.modelRoute).toContain('agent_artifacts show');
        expect(alphaPlanItem?.closeout.autoAttachedRemoteArtifacts[0]?.redaction).toBe('metadata-only');
        expect(alphaPlanItem?.closeout.liveRemoteOutcomes[0]?.id).toBe('capture-alpha-live');
        expect(alphaPlanItem?.closeout.liveRemoteOutcomes[0]?.certification?.schemaStatus).toBe('certified');
        expect(alphaPlanItem?.closeout.workspaceEvidence[0]?.id).toBe('workspace-alpha');
        expect(alphaPlanItem?.closeout.workspaceEvidence[0]?.certification?.schemaStatus).toBe('certified');
        expect(alphaPlanItem?.closeout.reviewRoutes.join('\n')).toContain(alphaWorkPlan.id);
        expect(alphaPlanItem?.closeout.reviewRoutes.join('\n')).toContain(`agent_artifacts show artifactId:"${durableAlphaReceipt.id}"`);
        expect(alphaPlanItem?.closeout.reviewRoutes.join('\n')).toContain('agent_orchestration_agent');
        expect(alphaPlanItem?.reviewGate.status).toBe('pending-work');
        expect(alphaPlanItem?.reviewGate.requiredEvidence).toContain('diff');
        expect(alphaPlanItem?.reviewGate.requiredEvidence).toContain('workspace/worktree isolation evidence');
        expect(alphaPlanItem?.reviewGate.requiredEvidence).toContain('live remote capture/export outcome evidence');
        expect(alphaPlanItem?.nextAction).toContain('wait/status');
        const betaPlanItem = posture.managedExecutionPlan.workItems.find((item) => item.planItemId === 'agent:agent-beta');
        expect(betaPlanItem?.lane).toBe('visible-agent');
        expect(betaPlanItem?.milestoneId).toBe('review-and-closeout');
        expect(betaPlanItem?.artifactTrail[0]?.id).toBe('artifact-agent-beta');
        expect(betaPlanItem?.artifactTrail[0]?.modelRoute).toContain('remote { mode: "review"');
        expect(betaPlanItem?.workPlanLinks[0]?.itemId).toBe(betaWorkPlan.id);
        expect(betaPlanItem?.closeout.status).toBe('evidence-ready');
        expect(betaPlanItem?.closeout.dispatchReceiptCount).toBe(1);
        expect(betaPlanItem?.closeout.remoteArtifactCount).toBe(1);
        expect(betaPlanItem?.closeout.autoAttachReason).toContain('runnerId');
        expect(betaPlanItem?.closeout.autoAttachedRemoteArtifacts[0]?.id).toBe('artifact-agent-beta');
        expect(betaPlanItem?.closeout.autoAttachedRemoteArtifacts[0]?.modelRoute).toContain('remote { mode: "review"');
        expect(betaPlanItem?.closeout.reviewRoutes.join('\n')).toContain('artifact-agent-beta');
        expect(betaPlanItem?.closeout.reviewRoutes.join('\n')).toContain(betaWorkPlan.id);
        expect(betaPlanItem?.closeout.updateRoutes.join('\n')).toContain('status:"done"');
        expect(betaPlanItem?.closeout.policy).toContain('read-only');
        expect(betaPlanItem?.reviewGate.status).toBe('artifact-ready');
        expect(betaPlanItem?.reviewGate.modelRoutes.join('\n')).toContain('artifact-agent-beta');
        expect(posture.modelAccess.spawn).toBe('agent { mode: "spawn" }');
        expect(posture.modelAccess.batchSpawn).toBe('agent { mode: "batch-spawn" }');
        expect(posture.modelAccess.harness).toBe('agent_harness mode:"agent_orchestration"');
        expect(posture.decisionCards.find((card) => card.id === 'visible-batch-spawn')?.status).toBe('ready');
        expect(posture.decisionCards.find((card) => card.id === 'managed-multi-runner-plan')?.status).toBe('ready');
        expect(posture.decisionCards.find((card) => card.id === 'managed-multi-runner-plan')?.userRoute).toContain('/work submit-file');
        expect(posture.decisionCards.find((card) => card.id === 'hidden-fanout-blocked')?.status).toBe('blocked');
        expect(posture.agents[0]?.routes.cancel).toBe('agent { mode: "cancel", agentId: "agent-alpha" }');
        expect(posture.agents[0]?.routes.message).toBe('agent { mode: "message", agentId: "agent-alpha" }');
        expect(posture.agents[0]?.managedPlanCard?.lane).toBe('remote-runner');
        expect(posture.agents[0]?.managedPlanCard?.reviewGate.status).toBe('pending-work');
        expect(posture.agents[0]?.context).toContain('project context');
        expect(posture.policy).toContain('hidden fanout is blocked');
        expect(JSON.stringify(posture)).not.toContain('remote-outcome-secret');
        expect(JSON.stringify(posture)).not.toContain('remote-workspace-secret');
      }

      if (surface === 'detail') {
        const detail = await executeHarnessJson<{
          readonly agentId: string;
          readonly status: string;
          readonly task: string;
          readonly routes: { readonly inspect: string; readonly wait: string };
          readonly tools: readonly string[];
          readonly usage: { readonly inputTokens: number };
          readonly managedPlanCard?: {
            readonly lane: string;
            readonly remoteContract?: { readonly runnerId: string; readonly transportState: string } | null;
            readonly liveOutcomeTrail: readonly { readonly id: string; readonly summary: string | null; readonly certification?: { readonly missingSignals: readonly string[] } }[];
            readonly workspaceEvidence: readonly { readonly id: string; readonly worktreeRef: string | null; readonly certification?: { readonly missingSignals: readonly string[] } }[];
            readonly workPlanLinks: readonly { readonly itemId: string; readonly latestDispatchReceipt: string | null }[];
            readonly closeout: { readonly dispatchReceiptCount: number; readonly remoteReceiptCount: number; readonly remoteOutcomeCount: number; readonly workspaceEvidenceCount: number; readonly reviewRoutes: readonly string[] };
          };
        }>(fixture, { mode: 'agent_orchestration_agent', agentId: 'agent-alpha' });
        expect(detail.agentId).toBe('agent-alpha');
        expect(detail.status).toBe('running');
        expect(detail.task).toContain('auth flow');
        expect(detail.routes.inspect).toBe('agent { mode: "get", agentId: "agent-alpha" }');
        expect(detail.routes.wait).toBe('agent { mode: "wait", agentId: "agent-alpha" }');
        expect(detail.tools).toEqual(['read', 'find']);
        expect(detail.usage.inputTokens).toBe(120);
        expect(detail.managedPlanCard?.lane).toBe('remote-runner');
        expect(detail.managedPlanCard?.remoteContract?.runnerId).toBe('agent-alpha');
        expect(detail.managedPlanCard?.remoteContract?.transportState).toBe('connected');
        expect(detail.managedPlanCard?.liveOutcomeTrail[0]?.id).toBe('capture-alpha-live');
        expect(detail.managedPlanCard?.liveOutcomeTrail[0]?.certification?.missingSignals).toEqual([]);
        expect(detail.managedPlanCard?.workspaceEvidence[0]?.id).toBe('workspace-alpha');
        expect(detail.managedPlanCard?.workspaceEvidence[0]?.certification?.missingSignals).toEqual([]);
        expect(detail.managedPlanCard?.workPlanLinks[0]?.itemId).toBe(alphaWorkPlan.id);
        expect(detail.managedPlanCard?.workPlanLinks[0]?.latestDispatchReceipt).toContain('agent-alpha');
        expect(detail.managedPlanCard?.closeout.dispatchReceiptCount).toBe(1);
        expect(detail.managedPlanCard?.closeout.remoteReceiptCount).toBe(1);
        expect(detail.managedPlanCard?.closeout.remoteOutcomeCount).toBe(1);
        expect(detail.managedPlanCard?.closeout.workspaceEvidenceCount).toBe(1);
        expect(detail.managedPlanCard?.closeout.reviewRoutes.join('\n')).toContain(alphaWorkPlan.id);
        expect(detail.managedPlanCard?.closeout.reviewRoutes.join('\n')).toContain(`agent_artifacts show artifactId:"${durableAlphaReceipt.id}"`);
        expect(JSON.stringify(detail)).not.toContain('remote-outcome-secret');
        expect(JSON.stringify(detail)).not.toContain('remote-workspace-secret');
      }

      if (surface === 'filtered') {
        const filtered = await executeHarnessJson<{
          readonly returned: number;
          readonly agents: readonly { readonly agentId: string }[];
        }>(fixture, { mode: 'agent_orchestration', query: 'auth' });
        expect(filtered.returned).toBe(1);
        expect(filtered.agents[0]?.agentId).toBe('agent-alpha');
      }

      if (surface === 'queue') {
        const queue = await executeHarnessJson<{
          readonly queue: readonly {
            readonly queueItemId: string;
            readonly modelRoute: string;
            readonly inspectRoute: string;
            readonly cancelRoute?: string;
            readonly createRoute?: string;
            readonly batchCreateRoute?: string;
          }[];
        }>(fixture, { mode: 'autonomy_queue', query: 'subagent', includeParameters: true });
        const subagents = queue.queue.find((item) => item.queueItemId === 'delegated-subagents');
        expect(subagents?.modelRoute).toBe('agent_harness mode:"agent_orchestration"');
        expect(subagents?.inspectRoute).toBe('agent_harness mode:"agent_orchestration"');
        expect(subagents?.cancelRoute).toBe('agent { mode: "cancel", agentId: "..." }');
        expect(subagents?.createRoute).toContain('agent { mode: "spawn"');
        expect(subagents?.batchCreateRoute).toContain('agent { mode: "batch-spawn"');
      }
    } finally {
      fixture.cleanup();
    }
  });


  test('saves redacted setup smoke evidence artifacts when user-run output is provided', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1760000000008);
    const fixture = makeFixture();
    const artifacts = { store: new ArtifactStore({ rootDir: join(fixture.root, 'artifacts') }) };
    Object.assign(fixture.context.platform, { artifactStore: artifacts.store });
    try {
      const smokeRun = await executeHarnessJson<{
        readonly status: string;
        readonly artifact: {
          readonly status: string;
          readonly artifactId?: string;
          readonly filename?: string;
          readonly purpose?: string;
          readonly evidenceFields?: readonly { readonly id: string; readonly preview: string }[];
          readonly inspectRoute?: string;
        };
      }>(fixture, {
        mode: 'run_setup_smoke',
        setupItemId: 'install-smoke',
        confirm: true,
        explicitUserRequest: 'Save the redacted setup smoke evidence.',
        fields: {
          agentBinaryOutput: 'goodvibes-agent 1.0.0\nAuthorization: Bearer binary-secret',
          statusJson: '{"connectedHost":{"token":"host-secret"},"ok":true}',
          firstAssistantTurn: 'Ready. apiKey=assistant-secret',
          notes: 'Operator saw token=query-secret in https://example.test/status?token=query-secret',
        },
      });

      expect(smokeRun.status).toBe('executed');
      expect(smokeRun.artifact.status).toBe('saved');
      const artifactId = artifacts.store.list(1)[0]?.id;
      expect(artifactId).toBeDefined();
      expect(smokeRun.artifact.artifactId).toBe(artifactId);
      expect(smokeRun.artifact.filename).toContain('setup-smoke-');
      expect(smokeRun.artifact.purpose).toBe('agent-setup-smoke-evidence');
      expect(smokeRun.artifact.inspectRoute).toContain('agent_artifacts');
      expect(smokeRun.artifact.evidenceFields?.map((field) => field.id)).toEqual([
        'agentBinaryOutput',
        'statusJson',
        'firstAssistantTurn',
        'notes',
      ]);
      expect(JSON.stringify(smokeRun)).not.toContain('binary-secret');
      expect(JSON.stringify(smokeRun)).not.toContain('host-secret');
      expect(JSON.stringify(smokeRun)).not.toContain('assistant-secret');
      expect(JSON.stringify(smokeRun)).not.toContain('query-secret');

      const artifact = artifacts.store.list(1)[0];
      expect(artifact?.metadata).toMatchObject({
        purpose: 'agent-setup-smoke-evidence',
        source: 'agent-harness-run-setup-smoke',
        smokeStatus: 'blocked',
        evidenceFields: ['agentBinaryOutput', 'statusJson', 'firstAssistantTurn', 'notes'],
      });
      expect(JSON.stringify(artifact?.metadata)).not.toContain('binary-secret');
      expect(JSON.stringify(artifact?.metadata)).not.toContain('host-secret');
      expect(JSON.stringify(artifact?.metadata)).not.toContain('assistant-secret');
      expect(JSON.stringify(artifact?.metadata)).not.toContain('query-secret');
      const saved = await artifacts.store.readContent(artifactId!);
      const content = saved.buffer.toString('utf-8');
      expect(content).toContain('GoodVibes Agent Setup Smoke Evidence');
      expect(content).toContain('Agent binary output');
      expect(content).toContain('<redacted>');
      expect(content).not.toContain('binary-secret');
      expect(content).not.toContain('host-secret');
      expect(content).not.toContain('assistant-secret');
      expect(content).not.toContain('query-secret');

      const summary = await executeHarnessJson<{
        readonly assistant?: {
          readonly lanes?: readonly {
            readonly id: string;
            readonly summary: string;
            readonly nextAction: string;
          }[];
        };
        readonly setupPosture?: {
          readonly setupSmokeEvidence?: {
            readonly status: string;
            readonly artifactId: string;
            readonly result: string;
            readonly evidenceFields: readonly string[];
            readonly inspectRoute: string;
          };
          readonly setupSmokeHistory?: {
            readonly status: string;
            readonly total: number;
            readonly trend: string;
            readonly latestResult: string;
            readonly resultCounts: Record<string, number>;
            readonly blockedCheckFrequency: readonly { readonly checkId: string; readonly count: number }[];
            readonly recent: readonly { readonly artifactId: string; readonly result: string }[];
          };
          readonly setupWizard?: {
            readonly currentStepId: string;
            readonly currentStepLabel: string;
            readonly _diagnostic: {
              readonly repeatedBlocker?: {
                readonly setupItemId: string;
                readonly checkId: string;
                readonly count: number;
              } | null;
              readonly smokeHistory: {
                readonly status: string;
                readonly total: number;
                readonly latestResult: string;
              };
            };
          };
        };
      }>(fixture, { mode: 'summary' });
      expect(summary.setupPosture?.setupSmokeEvidence).toMatchObject({
        status: 'saved',
        artifactId,
        result: 'blocked',
        evidenceFields: ['agentBinaryOutput', 'statusJson', 'firstAssistantTurn', 'notes'],
      });
      expect(summary.setupPosture?.setupSmokeEvidence?.inspectRoute).toContain('agent_artifacts');
      expect(summary.setupPosture?.setupSmokeHistory).toMatchObject({
        status: 'available',
        total: 1,
        trend: 'first-run',
        latestResult: 'blocked',
      });
      expect(summary.setupPosture?.setupSmokeHistory?.resultCounts.blocked).toBe(1);
      expect(summary.setupPosture?.setupSmokeHistory?.blockedCheckFrequency.map((entry) => entry.checkId)).toContain('connected-host-auth');
      expect(summary.setupPosture?.setupSmokeHistory?.recent[0]).toMatchObject({
        artifactId,
        result: 'blocked',
      });
      expect(summary.setupPosture?.setupWizard?.currentStepId).toBe('connected-host-auth');
      expect(summary.setupPosture?.setupWizard?.currentStepLabel).toBe('Connected-host auth');
      expect(summary.setupPosture?.setupWizard?._diagnostic.repeatedBlocker).toMatchObject({
        setupItemId: 'connected-host-auth',
        checkId: 'connected-host-auth',
        count: 1,
      });
      expect(summary.setupPosture?.setupWizard?._diagnostic.smokeHistory).toMatchObject({
        status: 'available',
        total: 1,
        latestResult: 'blocked',
      });
      const setupLane = summary.assistant?.lanes?.find((lane) => lane.id === 'setup');
      expect(setupLane?.summary).toContain('Last smoke blocked');
      expect(setupLane?.summary).toContain('Trend first-run');
      expect(setupLane?.nextAction).toContain('saved smoke artifact');
    } finally {
      clock.mockRestore(); fixture.cleanup();
    }
  });


  test('promotes ready setup smoke evidence into a confirmed setup closeout path', async () => {
    await withPairedHost(async (port) => {
      const artifacts = createHarnessArtifactStore();
      const fixture = makeFixture({ artifactStore: artifacts.store, controlPlaneEnabled: true, controlPlanePort: port });
      try {
        if (!fixture.secretsManager) throw new Error('Expected fixture secrets manager.');
        await fixture.secretsManager.set('OPENAI_API_KEY', 'provider-secret-for-closeout');
        writeConnectedHostOperatorToken(fixture);

        const smokeRun = await executeHarnessJson<{
          readonly result: string;
          readonly smokeStatus: string;
          readonly blockedChecks: readonly string[];
          readonly artifact: { readonly status: string; readonly artifactId?: string };
        }>(fixture, {
          mode: 'run_setup_smoke',
          setupItemId: 'install-smoke',
          confirm: true,
          explicitUserRequest: 'Save final setup smoke evidence for closeout.',
          fields: {
            agentBinaryOutput: 'goodvibes-agent 1.0.0\nstatus ok',
            statusJson: '{"connectedHost":{"reachable":true},"provider":"openai"}',
            setupPostureOutput: 'setup posture reviewed; no critical blockers',
            firstAssistantTurn: 'Ready. Active model route is openai/gpt-4.1.',
          },
        });
        expect(smokeRun.result).toBe('ready-for-user-run');
        expect(smokeRun.smokeStatus).toBe('ready-to-run');
        expect(smokeRun.blockedChecks).toEqual([]);
        expect(smokeRun.artifact.status).toBe('saved');

        const posture = await executeHarnessJson<{
          readonly setupCloseout: {
            readonly status: string;
            readonly label: string;
            readonly primaryStepId: string | null;
            readonly modelRoute: string;
            readonly userRoute: string;
            readonly requiresConfirmation: boolean;
            readonly evidence: readonly string[];
          };
          readonly setupWizard: {
            readonly _diagnostic: {
              readonly closeout: {
                readonly status: string;
                readonly primaryStepId: string | null;
                readonly modelRoute: string;
              };
            };
          };
          readonly readinessPlan: readonly { readonly setupItemId: string; readonly status: string; readonly blocksAutonomy: boolean }[];
        }>(fixture, { mode: 'setup_posture', includeParameters: true });

        expect(posture.readinessPlan
          .filter((item) => item.blocksAutonomy)
          .every((item) => item.status !== 'blocked')).toBe(true);
        expect(posture.setupCloseout).toMatchObject({
          status: 'ready-to-finish',
          label: 'Finish setup',
          primaryStepId: 'finish-onboarding',
          requiresConfirmation: true,
        });
        expect(posture.setupCloseout.modelRoute).toContain('setup action:"finish"');
        expect(posture.setupCloseout.userRoute).toContain('Finish');
        expect(posture.setupCloseout.evidence.join('\n')).toContain('latest setup smoke: ready-for-user-run');
        expect(posture.setupWizard._diagnostic.closeout.status).toBe('ready-to-finish');
        expect(posture.setupWizard._diagnostic.closeout.modelRoute).toContain('setup action:"finish"');

        const finished = await executeHarnessJson<{
          readonly status: string;
          readonly checkMarker: { readonly exists: boolean; readonly source: string | null; readonly mode: string | null };
          readonly completionMarker: { readonly exists: boolean; readonly source: string | null; readonly mode: string | null };
          readonly policy: { readonly effect: string; readonly boundary: string };
        }>(fixture, {
          mode: 'run_workspace_action',
          actionId: 'onboarding-apply-close',
          confirm: true,
          explicitUserRequest: 'Finish Agent onboarding after setup smoke evidence is ready.',
        });
        expect(finished.status).toBe('onboarding_completed');
        expect(finished.checkMarker).toMatchObject({ exists: true, source: 'wizard', mode: 'new' });
        expect(finished.completionMarker).toMatchObject({ exists: true, source: 'wizard', mode: 'new' });
        expect(finished.policy.effect).toBe('confirmed-onboarding-marker-write');
        expect(finished.policy.boundary).toContain('does not mutate provider credentials');

        const after = await executeHarnessJson<{
          readonly setupCloseout: { readonly status: string; readonly label: string; readonly requiresConfirmation: boolean };
        }>(fixture, { mode: 'setup_posture' });
        expect(after.setupCloseout).toMatchObject({
          status: 'complete',
          label: 'Setup complete',
          requiresConfirmation: false,
        });
      } finally {
        fixture.cleanup();
      }
    });
  });


  test('verified native auth does not upgrade an unconfigured provider', async () => {
    await withClearedEnv(PROVIDER_AUTH_ENV_KEYS, () => withPairedHost(async (port) => {
      const fixture = makeFixture({ controlPlaneEnabled: true, controlPlanePort: port });
      try {
        writeConnectedHostOperatorToken(fixture);
        const posture = await executeHarnessJson<{
          readonly readinessPlan: readonly { readonly setupItemId: string; readonly status: string }[];
          readonly setupCloseout: { readonly status: string; readonly primaryStepId: string };
        }>(fixture, { mode: 'setup_posture', includeParameters: true });
        const plan = new Map(posture.readinessPlan.map(item => [item.setupItemId, item.status]));
        expect(plan.get('connected-host-auth')).toBe('ready');
        expect(plan.get('provider-access')).toBe('blocked');
        expect(posture.setupCloseout).toMatchObject({ status: 'blocked', primaryStepId: 'provider-access' });
      } finally { fixture.cleanup(); }
    }));
  });


  test('uses live service probes before recommending connected-host lifecycle repair', async () => {
    const fixture = makeFixture({ controlPlaneEnabled: true, controlPlanePort: 1 });
    try {
      const hostItem = await executeHarnessJson<{
        readonly setupItemId: string;
        readonly status: string;
        readonly signals?: readonly string[];
        readonly recommendedRepairCards?: readonly string[];
        readonly bootstrapPlan?: { readonly status: string; readonly recommendedWhen: string };
        readonly serviceProbe?: {
          readonly status: string;
          readonly enabled: boolean;
          readonly binding: string;
          readonly diagnosticRoute: string;
          readonly issues: readonly string[];
        };
        readonly serviceLifecycleDecision?: {
          readonly status: string;
          readonly recommendedAction: string;
          readonly modelRoute: string;
          readonly reason: string;
          readonly receiptRules: readonly string[];
          readonly blockedMutations: readonly string[];
        };
        readonly repairCards?: readonly {
          readonly id: string;
          readonly state: string;
          readonly recommendation: string;
          readonly liveEvidence?: { readonly probeStatus: string; readonly summary: string };
          readonly outcome?: {
            readonly target: string;
            readonly successCriteria: readonly string[];
            readonly evidenceFields: readonly string[];
            readonly verificationRoute: string;
            readonly recoveryRoute: string;
          };
        }[];
      }>(fixture, { mode: 'setup_item', setupItemId: 'connected-host-readiness' });

      expect(hostItem.setupItemId).toBe('connected-host-readiness');
      expect(hostItem.status).toBe('blocked');
      expect(hostItem.serviceProbe).toMatchObject({
        status: 'unreachable',
        enabled: true,
        binding: '127.0.0.1:1',
      });
      expect(hostItem.serviceProbe?.diagnosticRoute).toContain('host action:"service"');
      expect(hostItem.signals?.join('\n')).toContain('runtime connection probe: unreachable 127.0.0.1:1');
      expect(hostItem.serviceLifecycleDecision?.status).toBe('needs-status-receipt');
      expect(hostItem.serviceLifecycleDecision?.recommendedAction).toBe('read-services-status');
      expect(hostItem.serviceLifecycleDecision?.modelRoute).toContain('services.status');
      expect(hostItem.serviceLifecycleDecision?.reason).toContain('status receipt first');
      expect(hostItem.serviceLifecycleDecision?.receiptRules.join('\n')).toContain('running:false');
      expect(hostItem.serviceLifecycleDecision?.blockedMutations.join('\n')).toContain('services.restart');
      expect(hostItem.recommendedRepairCards).toContain('connected-host-status');
      expect(hostItem.recommendedRepairCards).toContain('service-posture');
      expect(hostItem.recommendedRepairCards).toContain('service-status');
      expect(hostItem.recommendedRepairCards).not.toContain('service-install');
      expect(hostItem.recommendedRepairCards).not.toContain('service-start');
      expect(hostItem.recommendedRepairCards).not.toContain('service-restart');
      expect(hostItem.bootstrapPlan?.status).toBe('recommended');
      expect(hostItem.bootstrapPlan?.recommendedWhen).toContain('runtime connection is enabled but unreachable');

      const start = hostItem.repairCards?.find((card) => card.id === 'service-start');
      const install = hostItem.repairCards?.find((card) => card.id === 'service-install');
      const restart = hostItem.repairCards?.find((card) => card.id === 'service-restart');
      expect(start?.state).toBe('available');
      expect(start?.recommendation).toBe('inspect-first');
      expect(start?.liveEvidence?.probeStatus).toBe('unreachable');
      expect(start?.liveEvidence?.summary).toContain('service status');
      expect(start?.outcome?.target).toBe('running-service');
      expect(start?.outcome?.successCriteria.join('\n')).toContain('running:true');
      expect(start?.outcome?.evidenceFields).toContain('actionError');
      expect(start?.outcome?.verificationRoute).toContain('services.status');
      expect(install?.recommendation).toBe('inspect-first');
      expect(install?.outcome?.target).toBe('installed-service');
      expect(restart?.recommendation).toBe('inspect-first');
      expect(restart?.outcome?.target).toBe('restarted-running-service');
    } finally {
      fixture.cleanup();
    }
  });
});
