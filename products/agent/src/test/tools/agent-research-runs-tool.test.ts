import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { AgentResearchRunRegistry } from '../../agent/research-run-registry.ts';
import { createAgentResearchRunsTool, registerAgentResearchRunsTool } from '../../tools/agent-research-runs-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makePaths() {
  const root = makeProjectTempDir('goodvibes-agent-research-runs-tool');
  return {
    root,
    paths: {
      resolveProjectPath: (...parts: string[]) => join(root, '.goodvibes', ...parts),
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('agent_research_runs tool', () => {
  test('creates and lists visible local research runs only after confirmation', async () => {
    const fixture = makePaths();
    try {
      const tool = createAgentResearchRunsTool(fixture.paths);
      const missingConfirm = await tool.execute({
        mode: 'create',
        title: 'Competitor research',
        question: 'What should we match?',
        explicitUserRequest: 'Create this research run.',
      });
      expect(missingConfirm.success).toBe(false);
      expect(missingConfirm.error).toContain('confirm:true');

      const created = await tool.execute({
        mode: 'create',
        title: 'Competitor research',
        question: 'What should we match?',
        goal: 'Produce a sourced feature inventory.',
        plan: ['Inventory features', 'Find UX gaps'],
        nextSteps: ['Start source collection'],
        confirm: true,
        explicitUserRequest: 'Create this research run.',
      });
      expect(created.success).toBe(true);
      expect(created.output).toContain('Created Agent research run');
      expect(created.output).toContain('policy local visible run state only');

      const listed = await tool.execute({ mode: 'list', includeCheckpoints: true });
      expect(listed.success).toBe(true);
      expect(listed.output).toContain('Agent research runs');
      expect(listed.output).toContain('competitor-research');

      const run = AgentResearchRunRegistry.fromShellPaths(fixture.paths).get('competitor-research');
      expect(run?.status).toBe('planned');
    } finally {
      fixture.cleanup();
    }
  });

  test('shows, starts, checkpoints, pauses, resumes, completes, deletes, and registers', async () => {
    const fixture = makePaths();
    try {
      const tool = createAgentResearchRunsTool(fixture.paths);
      const created = await tool.execute({
        mode: 'create',
        title: 'Deep research run',
        question: 'What is missing?',
        confirm: true,
        explicitUserRequest: 'Create this research run.',
      });
      expect(created.success).toBe(true);

      const shown = await tool.execute({ mode: 'show', id: 'deep-research-run' });
      expect(shown.success).toBe(true);
      expect(shown.output).toContain('Routes');
      expect(shown.output).toContain('checkpoint research action:"checkpoint"');
      expect(shown.output).toContain('Next routes');
      expect(shown.output).toContain('search research action:"search" runId:"deep-research-run"');

      const started = await tool.execute({
        mode: 'start',
        id: 'deep-research-run',
        note: 'Starting.',
        confirm: true,
        explicitUserRequest: 'Start this research run.',
      });
      expect(started.success).toBe(true);
      expect(started.output).toContain('Started Agent research run');
      expect(started.output).toContain('nextRoutes');
      expect(started.output).toContain('search research action:"search" runId:"deep-research-run"');
      expect(started.output).toContain('bundle research action:"bundle"');
      expect(started.output).toContain('report research action:"report" question:"What is missing?"');

      const checkpointed = await tool.execute({
        mode: 'checkpoint',
        id: 'deep-research-run',
        phase: 'reading',
        progress: 55,
        note: 'Reviewed two sources.',
        nextSteps: ['Draft findings'],
        sourceIds: ['source-a', 'source-b'],
        confirm: true,
        explicitUserRequest: 'Checkpoint this research run.',
      });
      expect(checkpointed.success).toBe(true);
      expect(checkpointed.output).toContain('Checkpointed Agent research run');
      expect(checkpointed.output).toContain('complete research action:"complete" id:"deep-research-run"');

      const listedWithTail = await tool.execute({ mode: 'list', includeLogTail: true });
      expect(listedWithTail.success).toBe(true);
      expect(listedWithTail.output).toContain('Recent run log tail');
      expect(listedWithTail.output).toContain('Reviewed two sources.');
      expect(listedWithTail.output).toContain('sources source-a, source-b');

      const shownWithTail = await tool.execute({ mode: 'show', id: 'deep-research-run' });
      expect(shownWithTail.success).toBe(true);
      expect(shownWithTail.output).toContain('Log tail');
      expect(shownWithTail.output).toContain('Reviewed two sources.');

      const paused = await tool.execute({
        mode: 'pause',
        id: 'deep-research-run',
        confirm: true,
        explicitUserRequest: 'Pause this research run.',
      });
      expect(paused.success).toBe(true);
      expect(paused.output).toContain('Paused Agent research run');

      const resumed = await tool.execute({
        mode: 'resume',
        id: 'deep-research-run',
        confirm: true,
        explicitUserRequest: 'Resume this research run.',
      });
      expect(resumed.success).toBe(true);
      expect(resumed.output).toContain('Resumed Agent research run');

      const completed = await tool.execute({
        mode: 'complete',
        id: 'deep-research-run',
        reportArtifactId: 'artifact-2',
        confirm: true,
        explicitUserRequest: 'Complete this research run.',
      });
      expect(completed.success).toBe(true);
      expect(completed.output).toContain('Completed Agent research run');
      expect(completed.output).toContain('reportArtifact research action:"report_artifact" artifactId:"artifact-2"');
      expect(completed.output).toContain('promoteKnowledge agent_knowledge_ingest sourceKind:"artifact" artifactId:"artifact-2"');

      const unconfirmedDelete = await tool.execute({
        mode: 'delete',
        id: 'deep-research-run',
        explicitUserRequest: 'Delete this research run.',
      });
      expect(unconfirmedDelete.success).toBe(false);
      expect(unconfirmedDelete.error).toContain('confirm:true');

      const deleted = await tool.execute({
        mode: 'delete',
        id: 'deep-research-run',
        confirm: true,
        explicitUserRequest: 'Delete this research run.',
      });
      expect(deleted.success).toBe(true);
      expect(deleted.output).toContain('Deleted Agent research run');
      expect(deleted.output).toContain('recreate research action:"create_run" title:"Deep research run"');

      const registry = new ToolRegistry();
      registerAgentResearchRunsTool(registry, fixture.paths);
      expect(registry.has('agent_research_runs')).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test('cancels and fails runs through confirmed local state routes', async () => {
    const fixture = makePaths();
    try {
      const tool = createAgentResearchRunsTool(fixture.paths);
      await tool.execute({
        mode: 'create',
        title: 'Cancel run',
        question: 'Should this stop?',
        confirm: true,
        explicitUserRequest: 'Create this run.',
      });
      const cancelled = await tool.execute({
        mode: 'cancel',
        id: 'cancel-run',
        note: 'User stopped the run.',
        confirm: true,
        explicitUserRequest: 'Cancel this run.',
      });
      expect(cancelled.success).toBe(true);
      expect(cancelled.output).toContain('Cancelled Agent research run');

      await tool.execute({
        mode: 'create',
        title: 'Fail run',
        question: 'Will this fail?',
        confirm: true,
        explicitUserRequest: 'Create this run.',
      });
      const failed = await tool.execute({
        mode: 'fail',
        id: 'fail-run',
        error: 'Browser route unavailable.',
        confirm: true,
        explicitUserRequest: 'Record this run failure.',
      });
      expect(failed.success).toBe(true);
      expect(failed.output).toContain('Failed Agent research run');
    } finally {
      fixture.cleanup();
    }
  });

  test('fails clearly without shell paths', async () => {
    const result = await createAgentResearchRunsTool().execute({ mode: 'list' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('shell paths');
  });
});
