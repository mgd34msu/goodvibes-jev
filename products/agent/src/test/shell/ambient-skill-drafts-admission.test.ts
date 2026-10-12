import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, createPermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer, scoreAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createShellPathService } from '@/runtime/index.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { AgentNoteRegistry } from '../../agent/note-registry.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { readSkillDraftLedger } from '../../agent/skill-draft-runner.ts';
import { buildSkillDraftProposer, createAutonomySurfacing } from '../../shell/autonomy-surfacing.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';

function barrier() { const p = Promise.withResolvers<void>(); return { promise: p.promise, release: () => p.resolve() }; }
function fixture(settings: { held?: boolean; suspend?: boolean } = {}) {
  const root = makeProjectTempDir('ambient-native-skill-draft');
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, 'config') });
  const manager = new PermissionManager(undefined, createPermissionConfigReader(config), new PolicyRuntimeState());
  const registry = new ToolRegistry(manager);
  bindAgentResearchSourceOwner(registry, ordinaryResearchOwner());
  const context = {
    workspace: { shellPaths: paths }, platform: { configManager: config },
    session: { runtime: { sessionId: 'ambient-native-fixture' } }, clients: {}, extensions: {},
  } as unknown as CommandContext;
  registerAgentHarnessTool(registry, new CommandRegistry(), context);
  const body = 'Restore in isolation, verify all rows, then switch traffic after the restore has passed.';
  const notes = AgentNoteRegistry.fromShellPaths(paths);
  const note = notes.create({ title: 'Restore verification', body }); notes.markReviewed(note.id);
  const entered = barrier(), released = barrier();
  let paused = false;
  const scripted = fakePort((name, question) => {
    if (question.type === 'score') return scoreAnswer(question, name === 'link' ? 0 : 3, 0.9999);
    if (question.type === 'noul') return noulAnswer(name === 'mutates' ? 0.999 : 0.001);
    const value = name === 'target' ? 'skill' : name === 'disposition' ? settings.held ? 'reject' : 'act'
      : name === 'kind' ? 'write' : name === 'family' || name === 'capability' ? 'generic'
        : name === 'hazard' ? 'none' : undefined;
    if (!value) throw new Error(`Unspecified ambient question: ${name}`);
    return choiceAnswer(question, value, 0.9999);
  });
  const pendingReads = new Set<Promise<unknown>>();
  const raw: JudgmentPort = { model: scripted.port.model, ask(request) {
    const work = (async () => {
      if (settings.suspend && !paused && Object.hasOwn(request.questions, 'target')) {
        paused = true; entered.release(); await released.promise;
      }
      return scripted.port.ask(request);
    })();
    pendingReads.add(work); void work.then(() => pendingReads.delete(work), () => pendingReads.delete(work));
    return work;
  } };
  const log = new SqliteDecisionLog(':memory:');
  const previous = installJudgmentPort(withDecisionLog(raw, log));
  const host = { services: { permissionManager: manager, configManager: config }, commandContext: context, toolRegistry: registry };
  const propose = buildSkillDraftProposer(registry, host);
  const controller = new AbortController();
  const skills = AgentSkillRegistry.fromShellPaths(paths);
  return { paths, config, host, context, body, entered: entered.promise, release: released.release, propose, controller, skills,
    requests: scripted.requests,
    async close() { controller.abort(); released.release(); await Promise.allSettled([...pendingReads]); installJudgmentPort(previous); log[Symbol.dispose](); await cleanupResearchScreeningFixtures(); },
  };
}

test('actual registered ambient route obtains native admission and persists a disabled draft', async () => {
  const f = fixture();
  try {
    expect(await f.propose(f.controller.signal)).toBe(1);
    const skill = f.skills.list()[0];
    expect(skill?.enabled).toBe(false); expect(skill?.reviewState).toBe('fresh'); expect(skill?.procedure).toContain(f.body);
    expect(readSkillDraftLedger(f.skills)[0]?.skillId).toBe(skill?.id);
    const request = f.requests.find(value => Object.hasOwn(value.questions, 'disposition'));
    expect(request).toBeDefined();
    expect(JSON.stringify(request?.state)).toContain('away digest');
    expect(JSON.stringify(request?.state)).not.toContain('explicitUserRequest');
  } finally { await f.close(); }
});

test('native held ambient admission makes no draft or ledger effect', async () => {
  const f = fixture({ held: true });
  try { expect(await f.propose(f.controller.signal)).toBe(0); expect(f.skills.list()).toEqual([]); expect(readSkillDraftLedger(f.skills)).toEqual([]); }
  finally { await f.close(); }
});

test.each(['configuration', 'host', 'session'])('original ambient $s retirement prevents a pending draft', async kind => {
  const f = fixture({ suspend: true }); const work = f.propose(f.controller.signal);
  try {
    await f.entered;
    if (kind === 'configuration') f.config.reset();
    else if (kind === 'host') f.host.services = { ...f.host.services };
    else Object.defineProperty(f.context.session.runtime, 'sessionId', { value: 'replacement-session', configurable: true });
    f.release(); await expect(work).rejects.toBeDefined();
    expect(f.skills.list()).toEqual([]); expect(readSkillDraftLedger(f.skills)).toEqual([]);
  } finally { f.release(); await work.catch(() => {}); await f.close(); }
});

test('the real away-digest owner aborts and drains its pending registered draft call', async () => {
  const f = fixture({ suspend: true });
  const surfaced: string[] = [];
  const owner = createAutonomySurfacing({ shellPaths: f.paths,
    listAutomationJobs: () => [], listAutomationRunsSince: async () => ({ runs: [], deliveries: [] }),
    listApprovals: () => [], getTasksSnapshot: () => [], render: () => {},
    router: { high: () => {}, getFeed: () => ({ push: text => { surfaced.push(text); } }) }, onAwayDigest: f.propose,
  });
  try {
    owner.announceAwayDigest(); await f.entered;
    const stopped = owner.stop(); let settled = false; void stopped.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    f.release(); await stopped;
    expect(f.skills.list()).toEqual([]); expect(readSkillDraftLedger(f.skills)).toEqual([]);
    expect(surfaced.some(line => line.includes('Drafted'))).toBe(false);
  } finally { f.release(); await owner.stop(); await f.close(); }
});
