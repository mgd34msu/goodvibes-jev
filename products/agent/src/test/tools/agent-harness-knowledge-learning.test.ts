import { cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { resetAgentMcpCallRouteForTests } from '../../tools/agent-mcp-call-route.ts';
import { SqliteDecisionLog, withDecisionLog, score, type JudgmentPort } from '@goodvibes-jev/judgment';
import { join } from 'node:path';
import { AgentNoteRegistry } from '../../agent/note-registry.ts';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { AgentResearchRunRegistry } from '../../agent/research-run-registry.ts';
import { AgentResearchSourceRegistry } from '../../agent/research-source-registry.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { makeFixture, createMemoryRegistry, expectRowsHaveCompactModelRoutes, executeHarnessJson, createHarnessFixtureReadings } from "./agent-harness-tool-fixture.ts";


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


  test.each(['summary', 'curator', 'candidate', 'consolidationDetail', 'action', 'promptPlanAction', 'projectContextAction', 'projectContextFileAction'] as const)('exposes a read-only learning curator with ranked local review routes: %s', async surface => {
    setSystemTime(new Date(1_760_000_000_008));
    const fixture = makeFixture();
    try {
      const memoryRegistry = await createMemoryRegistry(fixture.paths, fixture.configManager);
      (fixture.context.clients as Record<string, unknown>).agentKnowledgeApi = { memory: memoryRegistry };
      const memory = await memoryRegistry.add({
        cls: 'fact',
        summary: 'Use the private deployment checklist before release.',
        detail: 'Checklist is useful but still needs review.',
        tags: ['release'],
        review: { state: 'fresh', confidence: 42 },
        provenance: [{ kind: 'event', ref: 'test-learning-curator' }],
      });
      await memoryRegistry.add({
        cls: 'fact',
        summary: 'Use the private deployment checklist before release.',
        detail: 'Duplicate copy adds UX inventory and package verification context.',
        tags: ['release', 'ux-inventory'],
        review: { state: 'fresh', confidence: 84 },
        provenance: [{ kind: 'event', ref: 'test-learning-curator-duplicate' }],
      });
      const noteRegistry = AgentNoteRegistry.fromShellPaths(fixture.paths);
      const sourceNote = noteRegistry.create({
        title: 'Reviewed source note',
        body: 'Durable source note for later knowledge ingest.',
        sourceUrl: 'https://example.test/research',
        tags: ['research'],
        source: 'agent',
      });
      noteRegistry.markReviewed(sourceNote.id);
      const workflowNote = noteRegistry.create({
        title: 'Release checklist workflow',
        body: 'Repeat before release: check package verification, review UX inventory, and summarize residual risks.',
        tags: ['workflow', 'learned'],
        source: 'agent',
      });
      noteRegistry.markReviewed(workflowNote.id);
      const decisionNote = noteRegistry.create({
        title: 'Renderer decision memory',
        body: 'Decision: keep the existing renderer as the Agent UI foundation.',
        tags: ['decision', 'memory'],
        source: 'agent',
      });
      noteRegistry.markReviewed(decisionNote.id);
      const completedWork = fixture.context.workspace.workPlanStore!.addItem('Release readiness workflow', {
        status: 'done',
        owner: 'agent',
        source: 'test-learning-curator',
        notes: 'Repeat before release: run package verification, check UX inventory, and summarize residual risks.',
      });
      const completedDecision = fixture.context.workspace.workPlanStore!.addItem('Renderer decision capture', {
        status: 'done',
        owner: 'agent',
        source: 'test-learning-curator',
        notes: 'Decision: use the existing renderer for the autonomous Agent harness.',
      });
      const researchRunRegistry = AgentResearchRunRegistry.fromShellPaths(fixture.paths);
      const researchRun = researchRunRegistry.create({
        title: 'Research report procedure',
        question: 'How should deep research reports stay sourced and reviewable?',
        goal: 'Define a reusable research report procedure.',
        plan: ['Review source credibility', 'Track citation coverage', 'Save report artifact'],
        provenance: 'test-learning-curator',
      });
      researchRunRegistry.start(researchRun.id, 'Started source review.');
      researchRunRegistry.checkpoint(researchRun.id, {
        phase: 'synthesizing',
        progress: 80,
        note: 'Procedure: check citation coverage before saving the report.',
        sourceIds: ['source-alpha'],
        nextSteps: ['Save report artifact'],
      });
      const completedResearch = researchRunRegistry.complete(researchRun.id, {
        note: 'Procedure: review source credibility, citation coverage, and report artifact before closing deep research.',
        reportArtifactId: 'artifact-research-1',
        sourceIds: ['source-alpha'],
      });
      const savedLearningSession = {
        name: 'session-release-review',
        title: 'Release review lesson session',
        model: 'gpt-4.1',
        provider: 'openai',
        timestamp: Date.now(),
        messageCount: 6,
        filePath: fixture.paths.resolveUserPath('sessions', 'session-release-review.json'),
      };
      (fixture.context.session as unknown as Record<string, unknown>).sessionManager = {
        list: () => [savedLearningSession],
        search: (query: string) => [savedLearningSession]
          .filter((session) => [session.name, session.title].join('\n').toLowerCase().includes(query.toLowerCase()))
          .map((session) => ({ session, matchCount: 1, snippets: ['Lesson: validate release evidence before closing.'] })),
        load: (name: string) => {
          if (name !== savedLearningSession.name) throw new Error(`Unknown session ${name}`);
          return {
            meta: { title: savedLearningSession.title },
            messages: [
              { role: 'user', content: 'Prepare the release review.' },
              { role: 'assistant', content: 'Lesson: when asked to prepare release review, run typecheck, package verification, UX inventory, and summarize residual risks.' },
            ],
          };
        },
      };
      const personaRegistry = AgentPersonaRegistry.fromShellPaths(fixture.paths);
      const persona = personaRegistry.create({
        name: 'Fresh operator persona',
        description: 'Fresh active behavior.',
        body: 'Prefer concise operational answers.',
        source: 'agent',
      });
      personaRegistry.setActive(persona.id);
      const reviewedPersona = personaRegistry.create({
        name: 'Reviewed release operator persona',
        description: 'Reviewed release behavior.',
        body: 'Keep release closeout concise and evidence-backed.',
        source: 'agent',
      });
      personaRegistry.markReviewed(reviewedPersona.id);
      personaRegistry.setActive(reviewedPersona.id);
      const skillRegistry = AgentSkillRegistry.fromShellPaths(fixture.paths);
      const firstSkill = skillRegistry.create({
        name: 'Missing command skill',
        description: 'Needs an unavailable command before use.',
        procedure: 'Run the missing command and summarize results.',
        requirements: [{ kind: 'command', name: 'definitely-missing-goodvibes-agent-test-command' }],
        enabled: true,
        source: 'agent',
      });
      const secondSkill = skillRegistry.create({
        name: 'Missing command skill!',
        description: 'Duplicate skill adds package verification and UX inventory notes.',
        procedure: 'Run package verification, check UX inventory, then summarize results.',
        triggers: ['release'],
        tags: ['release', 'verification'],
        source: 'agent',
      });

      if (surface === 'summary') {
        const summary = await executeHarnessJson<{
          readonly learningCurator?: { readonly candidates: number; readonly needsReview: number; readonly needsSetup: number; readonly needsConsolidation: number; readonly lowConfidence: number; readonly proposedBehavior: number; readonly readOnly: boolean };
        }>(fixture, { mode: 'summary' });
        expect(summary.learningCurator?.candidates).toBeGreaterThan(3);
        expect(summary.learningCurator?.needsReview).toBeGreaterThan(0);
        expect(summary.learningCurator?.needsSetup).toBeGreaterThan(0);
        expect(summary.learningCurator?.needsConsolidation).toBeGreaterThan(0);
        expect(summary.learningCurator?.lowConfidence).toBeGreaterThan(0);
        expect(summary.learningCurator?.proposedBehavior).toBeGreaterThan(5);
        expect(summary.learningCurator?.readOnly).toBe(true);
        return;
      }

      if (surface === 'curator') {
        const curator = await executeHarnessJson<{
          readonly summary: { readonly candidates: number; readonly needsReview: number; readonly needsSetup: number; readonly needsConsolidation: number; readonly lowConfidence: number; readonly proposedBehavior: number; readonly readyToPromote: number };
          readonly consolidationBatch?: {
            readonly status: string;
            readonly candidates: number;
            readonly duplicateRecords: number;
            readonly domains: readonly { readonly domain: string; readonly candidates: number; readonly duplicateRecords: number }[];
            readonly routes: { readonly reviewQueue: string; readonly candidateDetail: string; readonly survivorRecord: string };
            readonly phases: readonly { readonly id: string; readonly route: string }[];
            readonly topCandidates: readonly {
              readonly candidateId: string;
              readonly survivorId: string;
              readonly duplicateIds?: readonly string[];
              readonly diffFields: readonly string[];
              readonly detailRoute: string;
              readonly applyRoute?: string;
              readonly mergeRoute?: string;
              readonly stalePhaseRoute?: string;
              readonly deletePhaseRoute?: string;
              readonly updateRoute?: string;
              readonly staleRoutes?: readonly string[];
              readonly deleteRoutes?: readonly string[];
              readonly rollbackRoutes?: readonly string[];
            }[];
            readonly policy: string;
          };
          readonly promptPlan: {
            readonly status: string;
            readonly promptActiveCount: number;
            readonly suppressedCount: number;
            readonly proposalCount: number;
            readonly consolidationCount: number;
            readonly promptActiveRecords: readonly { readonly id: string; readonly domain: string; readonly priority: number; readonly inspectRoute: string }[];
            readonly reviewFirst: readonly { readonly candidateId: string; readonly status: string; readonly scores: { readonly risk: number }; readonly reviewRoute?: string }[];
            readonly proposalQueue: readonly { readonly candidateId: string; readonly status: string; readonly createRoute?: string }[];
            readonly consolidationQueue: readonly { readonly candidateId: string; readonly status: string; readonly updateRoute?: string }[];
            readonly suppressed: { readonly needsReview: number; readonly needsSetup: number; readonly lowConfidence: number; readonly personalityIssues: number; readonly needsConsolidation: number };
            readonly orderingRules: readonly string[];
            readonly routes: { readonly memoryPosture: string; readonly curator: string; readonly candidate: string; readonly consolidation: string };
            readonly policy: string;
          };
          readonly candidates: readonly {
            readonly candidateId: string;
            readonly label: string;
            readonly domain: string;
            readonly status: string;
            readonly proposalTarget?: string;
            readonly proposalFields?: Record<string, string>;
            readonly priority: number;
            readonly scores: { readonly usefulness: number; readonly freshness: number; readonly sourceQuality: number; readonly risk: number };
            readonly inspectRoute: string;
            readonly reviewRoute?: string;
            readonly updateRoute?: string;
            readonly createRoute?: string;
            readonly cleanupRoutes?: readonly string[];
            readonly rollbackRoutes?: readonly string[];
            readonly consolidation?: {
              readonly survivorId: string;
              readonly duplicateIds: readonly string[];
              readonly diffs: readonly { readonly field: string; readonly survivor: string; readonly merged: string }[];
            };
          }[];
          readonly policy: string;
        }>(fixture, { mode: 'learning_curator', includeParameters: true });
        expect(curator.summary.candidates).toBeGreaterThan(3);
        expect(curator.summary.readyToPromote).toBeGreaterThan(0);
        expect(curator.summary.proposedBehavior).toBeGreaterThan(5);
        expect(curator.summary.needsConsolidation).toBeGreaterThan(0);
        expect(curator.policy).toContain('duplicate consolidation');
        expect(curator.promptPlan.status).toBe('attention');
        expect(curator.promptPlan.promptActiveCount).toBeGreaterThan(0);
        expect(curator.promptPlan.suppressedCount).toBeGreaterThan(0);
        expect(curator.promptPlan.proposalCount).toBeGreaterThan(0);
        expect(curator.promptPlan.consolidationCount).toBeGreaterThan(0);
        expect(curator.promptPlan.promptActiveRecords.some((record) => record.domain === 'persona')).toBe(true);
        expect(curator.promptPlan.reviewFirst.some((candidate) => candidate.status === 'low-confidence' && candidate.scores.risk > 0)).toBe(true);
        expect(curator.promptPlan.proposalQueue.some((candidate) => candidate.candidateId.includes('note-proposal') && candidate.createRoute !== undefined)).toBe(true);
        expect(curator.promptPlan.consolidationQueue.some((candidate) => candidate.candidateId.includes('consolidation:skill'))).toBe(true);
        expect(curator.promptPlan.suppressed.lowConfidence).toBeGreaterThan(0);
        expect(curator.promptPlan.orderingRules.join('\n')).toContain('risk');
        expect(curator.promptPlan.routes.memoryPosture).toContain('memory action:"status"');
        expect(curator.promptPlan.routes.candidate).toContain('memory action:"candidate"');
        expect(curator.promptPlan.policy).toContain('read-only');
        expect(curator.consolidationBatch?.status).toBe('ready');
        expect(curator.consolidationBatch?.candidates).toBeGreaterThan(0);
        expect(curator.consolidationBatch?.duplicateRecords).toBeGreaterThan(0);
        expect(curator.consolidationBatch?.domains.some((domain) => domain.domain === 'skill')).toBe(true);
        expect(curator.consolidationBatch?.routes.reviewQueue).toContain('query:"consolidation"');
        expect(curator.consolidationBatch?.routes.candidateDetail).toContain('memory action:"candidate"');
        expect(curator.consolidationBatch?.phases.map((phase) => phase.id)).toEqual([
          'inspect',
          'merge-survivor',
          'stale-duplicates',
          'verify',
          'delete-after-stale',
        ]);
        expect(curator.consolidationBatch?.topCandidates.some((candidate) => candidate.candidateId.includes('consolidation:skill'))).toBe(true);
        expect(curator.consolidationBatch?.topCandidates.every((candidate) => candidate.updateRoute === undefined)).toBe(true);
        expect(curator.consolidationBatch?.topCandidates.some((candidate) => candidate.applyRoute?.includes('agent_learning_consolidation'))).toBe(true);
        expect(curator.consolidationBatch?.topCandidates.some((candidate) => candidate.mergeRoute?.includes('mode=merge'))).toBe(true);
        expect(curator.consolidationBatch?.topCandidates.some((candidate) => candidate.stalePhaseRoute?.includes('mode=stale'))).toBe(true);
        expect(curator.consolidationBatch?.topCandidates.some((candidate) => candidate.deletePhaseRoute?.includes('mode=delete'))).toBe(true);
        expect(curator.consolidationBatch?.topCandidates.some((candidate) => candidate.staleRoutes?.join('\n').includes('action:"stale"'))).toBe(true);
        expect(curator.consolidationBatch?.topCandidates.some((candidate) => candidate.deleteRoutes?.join('\n').includes('action:"delete"'))).toBe(true);
        expect(curator.consolidationBatch?.topCandidates.some((candidate) => candidate.rollbackRoutes?.join('\n').includes('action:"review"'))).toBe(true);
        expect(curator.consolidationBatch?.policy).toContain('agent_learning_consolidation');
        expectRowsHaveCompactModelRoutes(curator.candidates);
        const memoryCandidate = curator.candidates.find((candidate) => candidate.candidateId === `memory:${memory.id}:low-confidence`);
        const personaCandidate = curator.candidates.find((candidate) => candidate.domain === 'persona' && candidate.status === 'needs-review');
        const setupCandidate = curator.candidates.find((candidate) => candidate.domain === 'skill' && candidate.status === 'needs-setup');
        const promoteCandidate = curator.candidates.find((candidate) => candidate.candidateId === `note-promote:${sourceNote.id}`);
        const proposalCandidate = curator.candidates.find((candidate) => candidate.candidateId === `note-proposal:routine:${workflowNote.id}`);
        const memoryNoteCandidate = curator.candidates.find((candidate) => candidate.candidateId === `note-proposal:memory:${decisionNote.id}`);
        const completedCandidate = curator.candidates.find((candidate) => candidate.candidateId === `work-plan-proposal:routine:${completedWork.id}`);
        const completedMemoryCandidate = curator.candidates.find((candidate) => candidate.candidateId === `work-plan-proposal:memory:${completedDecision.id}`);
        const researchCandidate = curator.candidates.find((candidate) => candidate.candidateId === `research-run-proposal:skill:${completedResearch.id}`);
        const sessionCandidate = curator.candidates.find((candidate) => candidate.candidateId === `session-proposal:skill:${savedLearningSession.name}`);
        const consolidationCandidate = curator.candidates.find((candidate) => candidate.status === 'needs-consolidation' && candidate.domain === 'skill');
        expect(memoryCandidate?.reviewRoute).toContain('agent_local_registry');
        expect(memoryCandidate?.scores.risk).toBeGreaterThan(0);
        expect(personaCandidate?.label).toContain('Fresh operator persona');
        expect(setupCandidate?.inspectRoute).toContain('domain:"skill"');
        expect(promoteCandidate?.createRoute).toContain('notes-to-knowledge');
        expect(proposalCandidate?.proposalTarget).toBe('routine');
        expect(proposalCandidate?.createRoute).toContain('notes-to-routine');
        expect(memoryNoteCandidate?.proposalTarget).toBe('memory');
        expect(memoryNoteCandidate?.createRoute).toContain('notes-to-memory');
        expect(completedCandidate?.domain).toBe('work_plan');
        expect(completedCandidate?.inspectRoute).toContain('agent_work_plan');
        expect(completedCandidate?.createRoute).toContain('learned-behavior');
        expect(completedCandidate?.proposalTarget).toBe('routine');
        expect(completedCandidate?.proposalFields?.target).toBe('routine');
        expect(completedCandidate?.proposalFields?.notes).toContain('Release readiness workflow');
        expect(completedMemoryCandidate?.proposalTarget).toBe('memory');
        expect(completedMemoryCandidate?.createRoute).toContain('memory-create');
        expect(completedMemoryCandidate?.proposalFields?.cls).toBe('decision');
        expect(completedMemoryCandidate?.proposalFields?.detail).toContain('existing renderer');
        expect(researchCandidate?.domain).toBe('research_run');
        expect(researchCandidate?.inspectRoute).toContain('mode:"research_run"');
        expect(researchCandidate?.createRoute).toContain('learned-behavior');
        expect(researchCandidate?.proposalTarget).toBe('skill');
        expect(researchCandidate?.proposalFields?.notes).toContain('artifact-research-1');
        expect(sessionCandidate?.domain).toBe('session');
        expect(sessionCandidate?.inspectRoute).toContain('sessions action:"get"');
        expect(sessionCandidate?.createRoute).toContain('learned-behavior');
        expect(sessionCandidate?.proposalTarget).toBe('skill');
        expect(sessionCandidate?.proposalFields?.notes).toContain('typecheck');
        expect(consolidationCandidate?.candidateId).toContain('consolidation:skill');
        expect(consolidationCandidate?.updateRoute).toBeUndefined();
        expect(consolidationCandidate?.cleanupRoutes?.join('\n')).toContain('action:"stale"');
        expect(consolidationCandidate?.rollbackRoutes?.join('\n')).toContain('action:"review"');
        expect(consolidationCandidate?.consolidation?.duplicateIds.length).toBeGreaterThan(0);
        expect(consolidationCandidate?.consolidation?.diffs.some((diff) => diff.field === 'description')).toBe(true);
        return;
      }

      if (surface === 'candidate') {
        const candidate = await executeHarnessJson<{
          readonly candidateId: string;
          readonly routes?: { readonly inspect: string; readonly review: string | null };
        }>(fixture, { mode: 'learning_candidate', candidateId: `memory:${memory.id}:low-confidence` });
        expect(candidate.candidateId).toBe(`memory:${memory.id}:low-confidence`);
        expect(candidate.routes?.review).toContain('action:"review"');
        return;
      }

      if (surface === 'consolidationDetail') {
        const consolidationDetail = await executeHarnessJson<{
          readonly candidateId: string;
          readonly status: string;
          readonly routes?: { readonly update: string | null; readonly stale: string | null; readonly delete: string | null; readonly apply?: string | null; readonly merge?: string | null; readonly stalePhase?: string | null; readonly deletePhase?: string | null };
          readonly cleanupRoutes?: readonly string[];
          readonly rollbackRoutes?: readonly string[];
        }>(fixture, { mode: 'learning_candidate', candidateId: `consolidation:skill:${encodeURIComponent(JSON.stringify([firstSkill.id, secondSkill.id].sort((left, right) => left.localeCompare(right))))}` });
        expect(consolidationDetail.status).toBe('needs-consolidation');
        expect(consolidationDetail.routes?.update).toBeNull();
        expect(consolidationDetail.routes?.apply).toContain('agent_learning_consolidation');
        expect(consolidationDetail.routes?.merge).toContain('mode=merge');
        expect(consolidationDetail.routes?.stalePhase).toContain('mode=stale');
        expect(consolidationDetail.routes?.deletePhase).toContain('mode=delete');
        expect(consolidationDetail.routes?.stale).toContain('action:"stale"');
        expect(consolidationDetail.routes?.delete).toContain('action:"delete"');
        expect(consolidationDetail.cleanupRoutes?.join('\n')).toContain('Duplicate of');
        expect(consolidationDetail.rollbackRoutes?.join('\n')).toContain('action:"review"');
        return;
      }

      if (surface === 'action') {
        const action = await executeHarnessJson<{
          readonly id: string;
          readonly modelRoute?: string;
        }>(fixture, { mode: 'workspace_action', actionId: 'memory-learning-curator' });
        expect(action.id).toBe('memory-learning-curator');
        expect(action.modelRoute).toBe('memory action:"curator"');
        return;
      }

      if (surface === 'promptPlanAction') {
        const promptPlanAction = await executeHarnessJson<{
          readonly id: string;
          readonly modelRoute?: string;
        }>(fixture, { mode: 'workspace_action', actionId: 'memory-prompt-plan' });
        expect(promptPlanAction.id).toBe('memory-prompt-plan');
        expect(promptPlanAction.modelRoute).toBe('memory action:"curator" includeParameters:true');
        return;
      }

      if (surface === 'projectContextAction') {
        const projectContextAction = await executeHarnessJson<{
          readonly id: string;
          readonly modelRoute?: string;
        }>(fixture, { mode: 'workspace_action', actionId: 'context-project-files' });
        expect(projectContextAction.id).toBe('context-project-files');
        expect(projectContextAction.modelRoute).toBe('context action:"files"');
        return;
      }

      if (surface === 'projectContextFileAction') {
        const projectContextFileAction = await executeHarnessJson<{
          readonly id: string;
          readonly modelRoute?: string;
        }>(fixture, { mode: 'workspace_action', actionId: 'context-project-file' });
        expect(projectContextFileAction.id).toBe('context-project-file');
        expect(projectContextFileAction.modelRoute).toBe('context action:"file"');
        return;
      }

    } finally {
      setSystemTime();
      fixture.cleanup();
    }
  });


  test('learning_auto_promote refuses to run without an explicit user request and confirm', async () => {
    const fixture = makeFixture();
    try {
      const memoryRegistry = await createMemoryRegistry(fixture.paths, fixture.configManager);
      (fixture.context.clients as Record<string, unknown>).agentKnowledgeApi = { memory: memoryRegistry };

      // No explicitUserRequest / confirm at all.
      const bare = await fixture.tool.execute({ mode: 'learning_auto_promote' });
      expect(bare.success).toBe(false);
      if (!bare.success) expect(bare.error).toContain('recorded effect admission');

      // Explicit request but confirm not set.
      const unconfirmed = await fixture.tool.execute({
        mode: 'learning_auto_promote',
        explicitUserRequest: 'Promote the reviewed learnings.',
      });
      expect(unconfirmed.success).toBe(false);
      if (!unconfirmed.success) expect(unconfirmed.error).toContain('recorded effect admission');
    } finally {
      fixture.cleanup();
    }
  });


  test('learning_auto_promote promotes eligible candidates after confirmation', async () => {
    const fixture = makeFixture();
    try {
      // Wire up a real MemoryRegistry as the memoryApi (has .add())
      const memoryRegistry = await createMemoryRegistry(fixture.paths, fixture.configManager);
      (fixture.context.clients as Record<string, unknown>).agentKnowledgeApi = { memory: memoryRegistry };

      // Add a reviewed note with a session and a completed work-plan so the
      // learning curator produces skill proposal candidates for runSkillDraftProposer.
      const savedSession = {
        name: 'session-auto-promote-test',
        title: 'Auto-promote integration session',
        model: 'gpt-4.1',
        provider: 'openai',
        timestamp: Date.now(),
        messageCount: 4,
        filePath: fixture.paths.resolveUserPath('sessions', 'session-auto-promote-test.json'),
      };
      (fixture.context.session as unknown as Record<string, unknown>).sessionManager = {
        list: () => [savedSession],
        search: (query: string) => [savedSession]
          .filter((s) => s.title.toLowerCase().includes(query.toLowerCase()))
          .map((s) => ({ session: s, matchCount: 1, snippets: ['Lesson: run auto-promote pass after curator review.'] })),
        load: (name: string) => {
          if (name !== savedSession.name) throw new Error(`Unknown session ${name}`);
          return {
            meta: { title: savedSession.title },
            messages: [
              { role: 'user', content: 'Run auto-promote.' },
              { role: 'assistant', content: 'Lesson: invoke learning_auto_promote after curator review to promote skill drafts autonomously.' },
            ],
          };
        },
      };

      const result = await executeHarnessJson<{
        readonly eligible: number;
        readonly promoted: number;
        readonly skipped: number;
        readonly consolidated: number;
        readonly domains: Record<string, number>;
        readonly log: readonly string[];
        readonly message: string;
        readonly policy: string;
      }>(fixture, {
        mode: 'learning_auto_promote',
        confirm: true,
        explicitUserRequest: 'Promote the reviewed learnings from this session.',
      });

      // Shape assertions, the mode must always return these fields.
      expect(typeof result.eligible).toBe('number');
      expect(typeof result.promoted).toBe('number');
      expect(typeof result.skipped).toBe('number');
      expect(typeof result.consolidated).toBe('number');
      expect(Array.isArray(result.log)).toBe(true);
      expect(typeof result.message).toBe('string');
      expect(typeof result.policy).toBe('string');
      expect(result.policy).toContain('Secret scanning');
      // At minimum the skill-draft pass runs; promoted + skipped covers all eligible
      expect(result.promoted + result.skipped).toBeGreaterThanOrEqual(result.eligible);
    } finally {
      fixture.cleanup();
    }
  });


  test('exposes a read-only research source queue with report handoff routes', async () => {
    const fixture = makeFixture();
    try {
      const registry = AgentResearchSourceRegistry.fromShellPaths(fixture.paths);
      const candidate = registry.create({
        question: 'Which local model route should we try first?',
        title: 'Ollama setup docs',
        url: 'https://example.test/ollama?token=secret-token',
        publisher: 'Ollama',
        summary: 'Official setup docs for a simple local model route.',
        evidence: 'Setup flow is simple and local.',
        tags: ['local-models'],
        provenance: 'test-research-queue',
      });
      const reviewed = registry.review(candidate.id, {
        credibility: 'high',
        score: 91,
        note: 'Official source; useful for report citation.',
      });

      const summary = await executeHarnessJson<{
        readonly researchQueue?: { readonly sources: number; readonly reviewed: number; readonly readOnly: boolean };
      }>(fixture, { mode: 'summary' });
      expect(summary.researchQueue?.sources).toBe(1);
      expect(summary.researchQueue?.reviewed).toBe(1);
      expect(summary.researchQueue?.readOnly).toBe(true);

      const queue = await executeHarnessJson<{
        readonly summary: { readonly sources: number; readonly reviewed: number; readonly candidates: number };
        readonly bundle?: { readonly sources: number; readonly route: string; readonly reportRoute: string };
        readonly sources: readonly {
          readonly sourceId: string;
          readonly status: string;
          readonly credibility: string;
          readonly score: number;
          readonly modelRoute: string;
          readonly bundleRoute?: string;
          readonly reportRoute?: string;
          readonly ingestRoute?: string;
          readonly reportSourceLine: string;
          readonly url?: string;
        }[];
        readonly policy: string;
      }>(fixture, { mode: 'research_queue', includeParameters: true });
      expect(queue.summary.sources).toBe(1);
      expect(queue.summary.reviewed).toBe(1);
      expect(queue.summary.candidates).toBe(0);
      expect(queue.policy).toContain('Research queue is read-only');
      expect(queue.bundle?.sources).toBe(1);
      expect(queue.bundle?.route).toContain('research action:"bundle"');
      expect(queue.bundle?.reportRoute).toContain('requireCitationCoverage:true');
      expectRowsHaveCompactModelRoutes(queue.sources);
      expect(queue.sources[0]?.sourceId).toBe(reviewed.id);
      expect(queue.sources[0]?.status).toBe('reviewed');
      expect(queue.sources[0]?.credibility).toBe('high');
      expect(queue.sources[0]?.score).toBe(91);
      expect(queue.sources[0]?.bundleRoute).toContain('research action:"bundle"');
      expect(queue.sources[0]?.reportRoute).toContain('research action:"report"');
      expect(queue.sources[0]?.ingestRoute).toContain('agent_knowledge_ingest');
      expect(queue.sources[0]?.reportSourceLine).toContain('Ollama setup docs');
      expect(queue.sources[0]?.url).toContain('token=%3Credacted%3E');
      expect(queue.sources[0]?.url).not.toContain('secret-token');

      const source = await executeHarnessJson<{
        readonly sourceId: string;
        readonly bundleRoute?: string;
        readonly reportSourceLine: string;
        readonly policy?: string;
      }>(fixture, { mode: 'research_source', sourceId: reviewed.id });
      expect(source.sourceId).toBe(reviewed.id);
      expect(source.bundleRoute).toContain('research action:"bundle"');
      expect(source.reportSourceLine).toContain('high');
      expect(source.policy).toContain('Research queue rows are local project state only');

      const action = await executeHarnessJson<{
        readonly id: string;
        readonly modelRoute?: string;
      }>(fixture, { mode: 'workspace_action', actionId: 'research-source-queue' });
      expect(action.id).toBe('research-source-queue');
      expect(action.modelRoute).toBe('research action:"sources"');
    } finally {
      fixture.cleanup();
    }
  });


  test('exposes a read-only research run queue with checkpoint and cancel routes', async () => {
    const fixture = makeFixture();
    try {
      const registry = AgentResearchRunRegistry.fromShellPaths(fixture.paths);
      const run = registry.create({
        title: 'Competitor deep research',
        question: 'Which competitor features should GoodVibes Agent match?',
        goal: 'Produce a sourced parity and better-than-parity plan.',
        plan: ['Inventory competitors', 'Review GoodVibes capabilities'],
        nextSteps: ['Collect official sources'],
      });
      const started = registry.start(run.id, 'Starting source collection.');
      const checkpointed = registry.checkpoint(started.id, {
        phase: 'reading',
        progress: 40,
        note: 'Read official docs and captured source ids.',
        nextSteps: ['Draft findings'],
        sourceIds: ['official-docs'],
      });

      const summary = await executeHarnessJson<{
        readonly researchRuns?: { readonly runs: number; readonly running: number; readonly readOnly: boolean };
      }>(fixture, { mode: 'summary' });
      expect(summary.researchRuns?.runs).toBe(1);
      expect(summary.researchRuns?.running).toBe(1);
      expect(summary.researchRuns?.readOnly).toBe(true);

      const queue = await executeHarnessJson<{
        readonly summary: { readonly runs: number; readonly running: number; readonly cancellable: number };
        readonly runs: readonly {
          readonly runId: string;
          readonly status: string;
          readonly phase: string;
          readonly progress: number;
          readonly modelRoute: string;
          readonly checkpointRoute?: string;
          readonly cancelRoute?: string;
          readonly completeRoute?: string;
          readonly logTail: readonly string[];
          readonly runLine: string;
        }[];
        readonly runnerPosture: {
          readonly browserBackedResearch: {
            readonly status: string;
            readonly configured: boolean;
            readonly recommendedRoute: string;
            readonly fallbackRoutes: readonly string[];
            readonly workflows: readonly { readonly id: string; readonly status: string; readonly inspectRoute: string }[];
          };
          readonly sourceQueueRoute: string;
          readonly reportRoute: string;
          readonly policy: string;
        };
        readonly policy: string;
      }>(fixture, { mode: 'research_runs', includeParameters: true });
      expect(queue.summary.runs).toBe(1);
      expect(queue.summary.running).toBe(1);
      expect(queue.summary.cancellable).toBe(1);
      expect(queue.policy).toContain('Research runs are read-only');
      expectRowsHaveCompactModelRoutes(queue.runs);
      expect(queue.runs[0]?.runId).toBe(checkpointed.id);
      expect(queue.runs[0]?.status).toBe('running');
      expect(queue.runs[0]?.phase).toBe('reading');
      expect(queue.runs[0]?.progress).toBe(40);
      expect(queue.runs[0]?.checkpointRoute).toContain('research action:"checkpoint"');
      expect(queue.runs[0]?.cancelRoute).toContain('research action:"cancel"');
      expect(queue.runs[0]?.completeRoute).toContain('research action:"complete"');
      expect(queue.runs[0]?.logTail.join('\n')).toContain('Read official docs and captured source ids.');
      expect(queue.runs[0]?.runLine).toContain('Competitor deep research');
      expect(queue.runnerPosture.browserBackedResearch.status).toBe('setup-needed');
      expect(queue.runnerPosture.browserBackedResearch.configured).toBe(false);
      expect(queue.runnerPosture.browserBackedResearch.recommendedRoute).toContain('mcp_servers');
      expect(queue.runnerPosture.browserBackedResearch.fallbackRoutes.join('\n')).toContain('web-fetch-research');
      expect(queue.runnerPosture.browserBackedResearch.workflows[0]?.id).toBe('browser-navigation');
      expect(queue.runnerPosture.browserBackedResearch.workflows[0]?.inspectRoute).toContain('setup action:"item"');
      expect(queue.runnerPosture.sourceQueueRoute).toBe('research action:"sources"');
      expect(queue.runnerPosture.reportRoute).toContain('research action:"report"');
      expect(queue.runnerPosture.policy).toContain('browser-backed research');

      const detail = await executeHarnessJson<{
        readonly runId: string;
        readonly sourceIds: readonly string[];
        readonly checkpoints: readonly unknown[];
        readonly logTail: readonly string[];
        readonly policy?: string;
      }>(fixture, { mode: 'research_run', runId: checkpointed.id });
      expect(detail.runId).toBe(checkpointed.id);
      expect(detail.sourceIds).toEqual(['official-docs']);
      expect(detail.checkpoints).toHaveLength(1);
      expect(detail.logTail.join('\n')).toContain('Read official docs and captured source ids.');
      expect(detail.policy).toContain('Research run rows are local visible state only');

      const action = await executeHarnessJson<{
        readonly id: string;
        readonly modelRoute?: string;
      }>(fixture, { mode: 'workspace_action', actionId: 'research-run-queue' });
      expect(action.id).toBe('research-run-queue');
      expect(action.modelRoute).toBe('research action:"runs"');
    } finally {
      fixture.cleanup();
    }
  });


  test('plans a read-only deep research workflow across run, source, report, and Knowledge routes', async () => {
    const fixture = makeFixture();
    try {
      const runRegistry = AgentResearchRunRegistry.fromShellPaths(fixture.paths);
      const sourceRegistry = AgentResearchSourceRegistry.fromShellPaths(fixture.paths);
      const run = runRegistry.create({
        title: 'Browser control research',
        question: 'How should GoodVibes Agent expose browser-backed research?',
        goal: 'Produce a sourced implementation plan.',
        plan: ['Collect current public sources', 'Review source credibility', 'Save a sourced report'],
        nextSteps: ['Find official browser-control docs'],
      });
      const started = runRegistry.start(run.id, 'Starting public source collection.');
      const candidate = sourceRegistry.create({
        question: started.question,
        title: 'Browser automation docs',
        url: 'https://example.test/browser-automation',
        publisher: 'Example Docs',
        summary: 'Browser automation setup and safety guidance.',
        tags: ['browser', 'research'],
        provenance: 'test-research-workflow',
      });
      const reviewed = sourceRegistry.review(candidate.id, {
        credibility: 'high',
        score: 88,
        note: 'Official-style source useful for report citation.',
      });

      const workflow = await executeHarnessJson<{
        readonly status: string;
        readonly question: string;
        readonly run?: { readonly runId: string; readonly checkpointRoute: string; readonly completeRoute: string };
        readonly sourcePosture: {
          readonly reviewed: number;
          readonly bundleRoute: string;
          readonly reportReadySources: readonly { readonly sourceId: string; readonly reportLine: string }[];
        };
        readonly browserBackedResearch: { readonly status: string; readonly fallbackRoutes: readonly string[] };
        readonly browserRunnerContract: {
          readonly status: string;
          readonly requiredContracts: readonly string[];
          readonly setupRoutes: readonly string[];
          readonly fallbackRoutes: readonly string[];
          readonly policy: string;
        };
        readonly visualReportContract: {
          readonly status: string;
          readonly currentRoute: string;
          readonly requiredSections: readonly string[];
          readonly acceptanceCriteria: readonly string[];
          readonly routes: { readonly saveVisualReport: string; readonly saveMarkdownReport: string; readonly archiveArtifacts: string };
          readonly policy: string;
        };
        readonly workflow: readonly { readonly id: string; readonly status: string; readonly route: string; readonly reportRoute?: string }[];
        readonly routes: { readonly saveReport: string; readonly completeRun?: string };
        readonly policy: string;
      }>(fixture, { mode: 'research_workflow', runId: started.id, includeParameters: true });
      expect(workflow.status).toBe('ready-to-report');
      expect(workflow.question).toContain('browser-backed research');
      expect(workflow.run?.runId).toBe(started.id);
      expect(workflow.run?.checkpointRoute).toContain('research action:"checkpoint"');
      expect(workflow.run?.completeRoute).toContain('research action:"complete"');
      expect(workflow.sourcePosture.reviewed).toBe(1);
      expect(workflow.sourcePosture.bundleRoute).toContain('research action:"bundle"');
      expect(workflow.sourcePosture.reportReadySources[0]?.sourceId).toBe(reviewed.id);
      expect(workflow.sourcePosture.reportReadySources[0]?.reportLine).toContain('Browser automation docs');
      expect(workflow.browserBackedResearch.status).toBe('setup-needed');
      expect(workflow.browserBackedResearch.fallbackRoutes.join('\n')).toContain('web-fetch-research');
      expect(workflow.browserRunnerContract.status).toBe('setup-contract-needed');
      expect(workflow.browserRunnerContract.requiredContracts.join('\n')).toContain('pause/resume/cancel controls');
      expect(workflow.browserRunnerContract.requiredContracts.join('\n')).toContain('Report draft/save handoff');
      expect(workflow.browserRunnerContract.setupRoutes.join('\n')).toContain('browser-desktop-control');
      expect(workflow.browserRunnerContract.fallbackRoutes.join('\n')).toContain('web-fetch-research');
      expect(workflow.browserRunnerContract.policy).toContain('not started by this workflow plan');
      expect(workflow.visualReportContract.status).toBe('visual-report-packet-ready');
      expect(workflow.visualReportContract.currentRoute).toContain('research action:"report"');
      expect(workflow.visualReportContract.requiredSections).toEqual(expect.arrayContaining(['evidence matrix', 'findings board', 'source map', 'handoff checklist']));
      expect(workflow.visualReportContract.acceptanceCriteria.join('\n')).toContain('citation');
      expect(workflow.visualReportContract.acceptanceCriteria.join('\n')).toContain('visualReport:true');
      expect(workflow.visualReportContract.routes.saveVisualReport).toContain('visualReport:true');
      expect(workflow.visualReportContract.routes.saveMarkdownReport).toContain('research action:"report"');
      expect(workflow.visualReportContract.routes.archiveArtifacts).toContain('agent_artifacts mode:"archive"');
      expect(workflow.visualReportContract.policy).toContain('read-only planning');
      expect(workflow.workflow.map((step) => step.id)).toEqual(['visible-run', 'collect-sources', 'review-sources', 'save-report', 'promote-knowledge']);
      expect(workflow.workflow.find((step) => step.id === 'save-report')?.status).toBe('ready');
      expect(workflow.workflow.find((step) => step.id === 'save-report')?.reportRoute).toContain('visualReport:true');
      expect(workflow.workflow.find((step) => step.id === 'save-report')?.reportRoute).toContain('research action:"report"');
      expect(workflow.routes.saveReport).toContain('visualReport:true');
      expect(workflow.routes.saveReport).toContain('requireCitationCoverage:true');
      expect(workflow.routes.completeRun).toContain(started.id);
      expect(workflow.policy).toContain('read-only workflow plan');

      const briefing = await executeHarnessJson<{
        readonly status: string;
        readonly summary: {
          readonly activeRuns: number;
          readonly reviewedSources: number;
          readonly candidateSources: number;
          readonly browserReady: boolean;
        };
        readonly queue: readonly {
          readonly id: string;
          readonly kind: string;
          readonly status: string;
          readonly routes: Record<string, string>;
          readonly confirmationBoundary: string;
        }[];
        readonly routes: { readonly search: string; readonly saveReport: string };
        readonly policy: string;
      }>(fixture, { mode: 'research_briefing', target: started.id, includeParameters: true });
      expect(briefing.status).toBe('ready-to-report');
      expect(briefing.summary.activeRuns).toBe(1);
      expect(briefing.summary.reviewedSources).toBe(1);
      expect(briefing.summary.candidateSources).toBe(0);
      expect(briefing.summary.browserReady).toBe(false);
      const runItem = briefing.queue.find((item) => item.id === `run:${started.id}`);
      expect(runItem?.kind).toBe('run');
      expect(runItem?.routes.search).toContain(`runId:"${started.id}"`);
      expect(runItem?.routes.checkpoint).toContain('research action:"checkpoint"');
      expect(runItem?.confirmationBoundary).toContain('read-only');
      const sourceItem = briefing.queue.find((item) => item.id === `source:${reviewed.id}`);
      expect(sourceItem?.kind).toBe('source');
      expect(sourceItem?.routes.report).toContain('visualReport:true');
      expect(sourceItem?.routes.bundle).toContain('research action:"bundle"');
      const browserItem = briefing.queue.find((item) => item.id === 'browser:research-runner');
      expect(browserItem?.routes.runner).toBe('research action:"runner"');
      expect(briefing.routes.search).toContain('research action:"search"');
      expect(briefing.routes.saveReport).toContain('requireCitationCoverage:true');
      expect(briefing.policy).toContain('Research briefing is read-only');

      const fresh = await executeHarnessJson<{
        readonly status: string;
        readonly browserRunnerContract: { readonly status: string; readonly fallbackRoutes: readonly string[] };
        readonly visualReportContract: {
          readonly status: string;
          readonly currentRoute: string;
          readonly routes: { readonly reviewedSourceBundle: string };
        };
        readonly workflow: readonly { readonly id: string; readonly status: string; readonly route: string }[];
        readonly routes: { readonly createRun: string };
      }>(fixture, { mode: 'research_workflow', query: 'new competitor research request' });
      expect(fresh.status).toBe('needs-visible-run');
      expect(fresh.browserRunnerContract.status).toBe('setup-contract-needed');
      expect(fresh.browserRunnerContract.fallbackRoutes.join('\n')).toContain('web-fetch-research');
      expect(fresh.visualReportContract.status).toBe('waiting-for-reviewed-sources');
      expect(fresh.visualReportContract.currentRoute).toContain('research action:"bundle"');
      expect(fresh.visualReportContract.routes.reviewedSourceBundle).toContain('new competitor research request');
      expect(fresh.workflow.find((step) => step.id === 'visible-run')?.status).toBe('needed');
      expect(fresh.workflow.find((step) => step.id === 'visible-run')?.route).toContain('research action:"create_run"');
      expect(fresh.routes.createRun).toContain('new competitor research request');
    } finally {
      fixture.cleanup();
    }
  });


  test.each(['workflow', 'briefing', 'runs'] as const)('consumes certified live research runner and visual report read models: %s', async view => {
    const fixture = makeFixture();
    try {
      const runRegistry = AgentResearchRunRegistry.fromShellPaths(fixture.paths);
      const sourceRegistry = AgentResearchSourceRegistry.fromShellPaths(fixture.paths);
      const run = runRegistry.create({
        title: 'Live browser research',
        question: 'Which browser-backed research evidence should count for release?',
        goal: 'Verify live runner and visual report read models.',
        plan: ['Collect source receipts', 'Review citations', 'Inspect rendered report'],
        nextSteps: ['Inspect certified runner record'],
      });
      const started = runRegistry.start(run.id, 'Waiting for daemon browser runner evidence.');
      const candidate = sourceRegistry.create({
        question: started.question,
        title: 'Live research source',
        url: 'https://example.test/live-research',
        publisher: 'Example Research',
        summary: 'Live browser-backed research receipt evidence.',
        tags: ['research', 'browser'],
        provenance: 'test-live-research-runner',
      });
      sourceRegistry.review(candidate.id, {
        credibility: 'high',
        score: 91,
        note: 'Useful certified source receipt.',
      });

      const platform = fixture.context.platform as unknown as { readModels: Record<string, unknown> };
      platform.readModels.research = {
        browserRuns: {
          getSnapshot: () => ({
            records: [{
              id: 'live-runner-1',
              runId: started.id,
              status: 'running',
              phase: 'reading',
              progress: 67,
              question: started.question,
              currentUrl: 'https://research.example.test/page?token=runner-url-secret',
              sourceReceiptIds: ['source-receipt-1'],
              reportDraftId: 'draft-report-1',
              logTail: ['Captured page token=runner-log-secret', 'Saved one source receipt.'],
              routes: {
                inspect: `research action:"runner" runId:"${started.id}" includeParameters:true`,
                checkpoint: `research action:"checkpoint" id:"${started.id}" confirm:true explicitUserRequest:"..."`,
                pause: `research action:"pause" id:"${started.id}" confirm:true explicitUserRequest:"..."`,
                resume: `research action:"resume" id:"${started.id}" confirm:true explicitUserRequest:"..."`,
                cancel: `research action:"cancel" id:"${started.id}" confirm:true explicitUserRequest:"..."`,
              },
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.research.browser-run.v1',
              publicationGuarantee: 'daemon publishes browser research source receipts token=runner-publication-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method research.browserRuns.list', 'sourceTool browser-runner'],
              cursor: 'research-runner-cursor-1',
              receiptId: 'research-runner-receipt-1',
              redaction: 'bounded-page-summary-only',
            }],
          }),
        },
        visualReports: {
          getSnapshot: () => ({
            records: [{
              id: 'visual-report-render-1',
              reportArtifactId: 'artifact-report-1',
              status: 'rendered',
              modelRoute: 'research action:"report_artifact" artifactId:"artifact-report-1"',
              renderRoute: 'computer action:"open_browser" surfaceId:"research-report-artifact-report-1" confirm:true explicitUserRequest:"..."',
              renderUrl: 'https://research.example.test/reports/artifact-report-1?secret=render-url-secret',
              sections: ['at-a-glance summary', 'evidence matrix', 'findings board', 'source map', 'handoff checklist'],
              sourceMapCount: 1,
              citationCoverage: '1/1 material claims covered token=render-coverage-secret',
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.research.visual-report.v1',
              publicationGuarantee: 'daemon publishes visual report render receipts secret=render-publication-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method research.visualReports.list', 'sourceTool report-renderer'],
              cursor: 'visual-report-cursor-1',
              receiptId: 'visual-report-receipt-1',
            }],
          }),
        },
      };

      if (view === 'workflow') {
        const workflow = await executeHarnessJson<{
          readonly browserBackedResearch: {
            readonly status: string;
            readonly configured: boolean;
            readonly liveRunnerRecords: readonly {
              readonly currentUrl: string;
              readonly logTail: readonly string[];
              readonly certification: { readonly missingSignals: readonly string[]; readonly publicationGuarantee?: string };
            }[];
          };
          readonly browserRunnerContract: {
            readonly status: string;
            readonly certifiedLiveRecords: readonly {
              readonly sourceReceiptIds: readonly string[];
              readonly certification: { readonly missingSignals: readonly string[]; readonly receiptId?: string };
            }[];
          };
          readonly visualReportContract: {
            readonly status: string;
            readonly currentRoute: string;
            readonly routes: { readonly openRenderedReport?: string };
            readonly certifiedRendererRecords: readonly {
              readonly sections: readonly string[];
              readonly renderUrl: string;
              readonly certification: { readonly missingSignals: readonly string[]; readonly publicationGuarantee?: string };
            }[];
          };
          readonly workflow: readonly { readonly id: string; readonly status: string; readonly route: string }[];
          readonly routes: { readonly liveRunner?: string; readonly liveVisualReport?: string };
        }>(fixture, { mode: 'research_workflow', runId: started.id, includeParameters: true });

        expect(workflow.browserBackedResearch.status).toBe('certified-live-runner');
        expect(workflow.browserBackedResearch.configured).toBe(true);
        expect(workflow.browserBackedResearch.liveRunnerRecords[0]?.currentUrl).toContain('token=%3Credacted%3E');
        expect(workflow.browserBackedResearch.liveRunnerRecords[0]?.logTail.join('\n')).toContain('token=<redacted>');
        expect(workflow.browserBackedResearch.liveRunnerRecords[0]?.certification.publicationGuarantee).toContain('token=<redacted>');
        expect(workflow.browserBackedResearch.liveRunnerRecords[0]?.certification.missingSignals).toEqual([]);
        expect(workflow.browserRunnerContract.status).toBe('certified-live-runner');
        expect(workflow.browserRunnerContract.certifiedLiveRecords[0]?.sourceReceiptIds).toContain('source-receipt-1');
        expect(workflow.browserRunnerContract.certifiedLiveRecords[0]?.certification.receiptId).toBe('research-runner-receipt-1');
        expect(workflow.browserRunnerContract.certifiedLiveRecords[0]?.certification.missingSignals).toEqual([]);
        expect(workflow.visualReportContract.status).toBe('certified-live-renderer');
        expect(workflow.visualReportContract.currentRoute).toContain('report_artifact');
        expect(workflow.visualReportContract.routes.openRenderedReport).toContain('computer action:"open_browser"');
        expect(workflow.visualReportContract.certifiedRendererRecords[0]?.sections).toEqual(expect.arrayContaining(['evidence matrix', 'source map']));
        expect(workflow.visualReportContract.certifiedRendererRecords[0]?.renderUrl).toContain('secret=%3Credacted%3E');
        expect(workflow.visualReportContract.certifiedRendererRecords[0]?.certification.publicationGuarantee).toContain('secret=<redacted>');
        expect(workflow.visualReportContract.certifiedRendererRecords[0]?.certification.missingSignals).toEqual([]);
        expect(workflow.workflow.find((step) => step.id === 'collect-sources')?.status).toBe('ready');
        expect(workflow.workflow.find((step) => step.id === 'collect-sources')?.route).toContain('research action:"runner"');
        expect(workflow.workflow.find((step) => step.id === 'save-report')?.route).toContain('report_artifact');
        expect(workflow.routes.liveRunner).toContain('research action:"runner"');
        expect(workflow.routes.liveVisualReport).toContain('report_artifact');

        expect(JSON.stringify(workflow)).not.toContain('runner-url-secret');
        expect(JSON.stringify(workflow)).not.toContain('runner-log-secret');
        expect(JSON.stringify(workflow)).not.toContain('runner-publication-secret');
        expect(JSON.stringify(workflow)).not.toContain('render-url-secret');
        expect(JSON.stringify(workflow)).not.toContain('render-coverage-secret');
        expect(JSON.stringify(workflow)).not.toContain('render-publication-secret');
        return;
      }

      if (view === 'briefing') {
        const briefing = await executeHarnessJson<{
          readonly summary: { readonly browserReady: boolean; readonly liveBrowserRuns: number; readonly liveVisualReports: number };
          readonly queue: readonly { readonly id: string; readonly status: string; readonly routes: Record<string, string>; readonly detail?: Record<string, unknown> }[];
        }>(fixture, { mode: 'research_briefing', target: started.id, includeParameters: true });
        expect(briefing.summary.browserReady).toBe(true);
        expect(briefing.summary.liveBrowserRuns).toBe(1);
        expect(briefing.summary.liveVisualReports).toBe(1);
        const browserItem = briefing.queue.find((item) => item.id === 'browser:research-runner');
        expect(browserItem?.status).toBe('certified-live-runner');
        expect(browserItem?.routes.visualReport).toContain('report_artifact');

        expect(JSON.stringify(briefing)).not.toContain('runner-url-secret');
        expect(JSON.stringify(briefing)).not.toContain('runner-log-secret');
        expect(JSON.stringify(briefing)).not.toContain('runner-publication-secret');
        expect(JSON.stringify(briefing)).not.toContain('render-url-secret');
        expect(JSON.stringify(briefing)).not.toContain('render-coverage-secret');
        expect(JSON.stringify(briefing)).not.toContain('render-publication-secret');
        return;
      }

      if (view === 'runs') {
        const runs = await executeHarnessJson<{
          readonly runnerPosture: {
            readonly browserBackedResearch: { readonly status: string; readonly certifiedLiveRecords: readonly unknown[] };
            readonly visualReportRendering: { readonly status: string; readonly certifiedLiveRecords: readonly unknown[] };
          };
        }>(fixture, { mode: 'research_runs', includeParameters: true });
        expect(runs.runnerPosture.browserBackedResearch.status).toBe('certified-live-runner');
        expect(runs.runnerPosture.browserBackedResearch.certifiedLiveRecords).toHaveLength(1);
        expect(runs.runnerPosture.visualReportRendering.status).toBe('certified-live-renderer');
        expect(runs.runnerPosture.visualReportRendering.certifiedLiveRecords).toHaveLength(1);
        expect(JSON.stringify(runs)).not.toContain('runner-url-secret');
        expect(JSON.stringify(runs)).not.toContain('runner-log-secret');
        expect(JSON.stringify(runs)).not.toContain('runner-publication-secret');
        expect(JSON.stringify(runs)).not.toContain('render-url-secret');
        expect(JSON.stringify(runs)).not.toContain('render-coverage-secret');
        expect(JSON.stringify(runs)).not.toContain('render-publication-secret');
        return;
      }

    } finally {
      fixture.cleanup();
    }
  });
});
