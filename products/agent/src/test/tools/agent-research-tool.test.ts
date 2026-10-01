import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { AgentResearchRunRegistry } from '../../agent/research-run-registry.ts';
import { AgentResearchSourceRegistry } from '../../agent/research-source-registry.ts';
import { createAgentResearchTool, registerAgentResearchTool } from '../../tools/agent-research-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function fakeTool(name: string, calls: Record<string, unknown>[], output?: unknown): Tool {
  return {
    definition: {
      name,
      description: 'Fake tool',
      parameters: { type: 'object', additionalProperties: true },
    },
    execute: async (args: Record<string, unknown>) => {
      calls.push({ tool: name, ...args });
      return { success: true, output: JSON.stringify(output ?? { name, args }) };
    },
  };
}

function makeTool(calls: Record<string, unknown>[] = [], commandContext: CommandContext = { workspace: {}, platform: {} } as CommandContext): Tool {
  return createAgentResearchTool({
    commandRegistry: {} as CommandRegistry,
    commandContext,
    toolRegistry: new ToolRegistry(),
    harnessTool: fakeTool('agent_harness', calls),
    runsTool: fakeTool('agent_research_runs', calls),
    sourcesTool: fakeTool('agent_research_sources', calls),
    reportTool: fakeTool('agent_research_report', calls),
    artifactTool: fakeTool('agent_artifacts', calls),
    webSearchTool: fakeTool('web_search', calls, {
      providerId: 'duckduckgo',
      providerLabel: 'DuckDuckGo',
      query: 'browser agents',
      verbosity: 'evidence',
      results: [
        {
          rank: 1,
          url: 'https://example.test/report?api_key=secret',
          title: 'Browser Agent Report',
          snippet: 'A source about browser agents.',
          domain: 'example.test',
          type: 'organic',
          providerId: 'duckduckgo',
          metadata: {},
          evidence: [{ url: 'https://example.test/report', extract: 'readable', content: 'Evidence body about browser agents.', tokensUsed: 8, metadata: {} }],
        },
      ],
      metadata: {},
    }),
  });
}

describe('research adapter', () => {
  test('routes plan, run, and source reads to research harness modes', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'briefing', query: 'Compare local agent products.', limit: 3 });
    await tool.execute({ action: 'plan', query: 'Compare local agent products.', includeParameters: true });
    await tool.execute({ action: 'runs', query: 'agent products', limit: 5 });
    await tool.execute({ action: 'run', runId: 'run_123' });
    await tool.execute({ action: 'sources', query: 'odysseus' });
    await tool.execute({ action: 'source', sourceId: 'src_123' });

    expect(calls).toEqual([
      { tool: 'agent_harness', mode: 'research_briefing', query: 'Compare local agent products.', limit: 3 },
      { tool: 'agent_harness', mode: 'research_workflow', query: 'Compare local agent products.', includeParameters: true },
      { tool: 'agent_harness', mode: 'research_runs', query: 'agent products', limit: 5 },
      { tool: 'agent_harness', mode: 'research_run', runId: 'run_123' },
      { tool: 'agent_harness', mode: 'research_queue', query: 'odysseus' },
      { tool: 'agent_harness', mode: 'research_source', sourceId: 'src_123' },
    ]);
  });

  test('infers a research plan from plain query input', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ query: 'Find sources on local browser agents.' });

    expect(calls).toEqual([
      { tool: 'agent_harness', mode: 'research_workflow', query: 'Find sources on local browser agents.' },
    ]);
  });

  test('routes browser-backed runner readiness to the detailed research workflow contract', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'runner' });
    await tool.execute({ action: 'browser', query: 'authenticated market research', includeParameters: false });

    expect(calls).toEqual([
      { tool: 'agent_harness', mode: 'research_workflow', query: 'browser-backed research runner', includeParameters: true },
      { tool: 'agent_harness', mode: 'research_workflow', query: 'authenticated market research', includeParameters: false },
    ]);
  });

  test('routes saved research report artifact reads to the artifact browser', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'reports', query: 'browser agents', limit: 3 });
    await tool.execute({ action: 'report_artifact', artifactId: 'artifact_123', previewBytes: 4096 });
    await tool.execute({ action: 'show_report', reportArtifactId: 'artifact_456', includeContent: false });

    expect(calls).toEqual([
      { tool: 'agent_artifacts', mode: 'list', purpose: 'agent-research-report', query: 'browser agents', limit: 3 },
      { tool: 'agent_artifacts', mode: 'show', artifactId: 'artifact_123', includeContent: true, previewBytes: 4096 },
      { tool: 'agent_artifacts', mode: 'show', artifactId: 'artifact_456', includeContent: false },
    ]);
  });

  test('runs bounded public search and returns source capture routes without mutating the source queue', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    const result = await tool.execute({ action: 'search', query: 'browser agents', maxResults: 2, evidenceTopN: 1 });
    const packet = JSON.parse(result.output as string) as {
      readonly status: string;
      readonly sourceCandidateCount: number;
      readonly sourceCandidates: readonly {
        readonly title: string;
        readonly url: string;
        readonly captureArgs: { readonly action: string; readonly confirm: boolean; readonly explicitUserRequest: string };
        readonly captureRoute: string;
      }[];
    };

    expect(calls).toEqual([
      { tool: 'web_search', query: 'browser agents', maxResults: 2, verbosity: 'evidence', safeSearch: 'moderate', includeEvidence: true, evidenceTopN: 1, evidenceExtract: 'readable' },
    ]);
    expect(packet.status).toBe('source-candidates-ready');
    expect(packet.sourceCandidateCount).toBe(1);
    expect(packet.sourceCandidates[0]?.title).toBe('Browser Agent Report');
    expect(packet.sourceCandidates[0]?.url).toBe('https://example.test/report?api_key=%3Credacted%3E');
    expect(packet.sourceCandidates[0]?.captureArgs.action).toBe('add_source');
    expect(packet.sourceCandidates[0]?.captureArgs.confirm).toBe(true);
    expect(packet.sourceCandidates[0]?.captureArgs.explicitUserRequest).toBe('...');
    expect(packet.sourceCandidates[0]?.captureRoute).toContain('research action:"add_source"');
  });

  test('uses a visible run id as the public search question and returns run follow-up routes', async () => {
    const root = makeProjectTempDir('goodvibes-agent-research-adapter');
    const shellPaths = {
      resolveProjectPath: (...parts: string[]) => join(root, '.goodvibes', ...parts),
    };
    try {
      const run = AgentResearchRunRegistry.fromShellPaths(shellPaths).create({
        title: 'Browser agents',
        question: 'Which browser agents have the best user experience?',
        plan: ['Search public sources', 'Capture candidates', 'Review credibility'],
      });
      const calls: Record<string, unknown>[] = [];
      const tool = makeTool(calls, { workspace: { shellPaths }, platform: {} } as CommandContext);

      const result = await tool.execute({ action: 'search', runId: run.id, maxResults: 2, evidenceTopN: 1 });
      const packet = JSON.parse(result.output as string) as {
        readonly query: string;
        readonly run?: { readonly id: string };
        readonly nextRoutes: {
          readonly createRun?: string;
          readonly run?: string;
          readonly briefing?: string;
          readonly checkpointAfterCapture?: string;
        };
        readonly policy: string;
      };

      expect(calls).toEqual([
        { tool: 'web_search', query: 'Which browser agents have the best user experience?', maxResults: 2, verbosity: 'evidence', safeSearch: 'moderate', includeEvidence: true, evidenceTopN: 1, evidenceExtract: 'readable' },
      ]);
      expect(packet.query).toBe('Which browser agents have the best user experience?');
      expect(packet.run?.id).toBe(run.id);
      expect(packet.nextRoutes.createRun).toBeUndefined();
      expect(packet.nextRoutes.run).toContain(`runId:"${run.id}"`);
      expect(packet.nextRoutes.briefing).toContain(`target:"${run.id}"`);
      expect(packet.nextRoutes.checkpointAfterCapture).toContain(`id:"${run.id}"`);
      expect(packet.policy).toContain('does not create or start a run');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('requires explicit confirmation before the research runner mutates visible run state', async () => {
    const root = makeProjectTempDir('goodvibes-agent-research-runner-confirm');
    const shellPaths = {
      resolveProjectPath: (...parts: string[]) => join(root, '.goodvibes', ...parts),
    };
    try {
      const calls: Record<string, unknown>[] = [];
      const tool = makeTool(calls, { workspace: { shellPaths }, platform: {} } as CommandContext);

      const result = await tool.execute({ action: 'runner', query: 'browser agents', confirm: true });

      expect(result.success).toBe(false);
      expect(result.error).toContain('explicitUserRequest');
      expect(calls).toEqual([]);
      expect(AgentResearchRunRegistry.fromShellPaths(shellPaths).list()).toEqual([]);
      expect(AgentResearchSourceRegistry.fromShellPaths(shellPaths).list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('confirmed research runner starts a visible run, saves source candidates, and checkpoints next review routes', async () => {
    const root = makeProjectTempDir('goodvibes-agent-research-runner');
    const shellPaths = {
      resolveProjectPath: (...parts: string[]) => join(root, '.goodvibes', ...parts),
    };
    try {
      const calls: Record<string, unknown>[] = [];
      const tool = makeTool(calls, { workspace: { shellPaths }, platform: {} } as CommandContext);

      const result = await tool.execute({
        action: 'runner',
        query: 'Which browser agents have the best user experience?',
        maxResults: 2,
        evidenceTopN: 1,
        confirm: true,
        explicitUserRequest: 'Start a visible research runner and capture candidate sources.',
      });
      const packet = JSON.parse(result.output as string) as {
        readonly status: string;
        readonly query: string;
        readonly resultCount: number;
        readonly sourceCandidateCount: number;
        readonly savedSourceCount: number;
        readonly reusedSourceCount: number;
        readonly run: {
          readonly id: string;
          readonly status: string;
          readonly phase: string;
          readonly progress: number;
          readonly sourceIds: readonly string[];
          readonly inspectRoute: string;
        };
        readonly sources: readonly {
          readonly sourceId: string;
          readonly title: string;
          readonly status: string;
          readonly credibility: string;
          readonly inspectRoute: string;
          readonly reviewRoute: string;
          readonly reportLine: string;
        }[];
        readonly nextRoutes: {
          readonly run: string;
          readonly sources: string;
          readonly bundle: string;
          readonly saveReport: string;
        };
        readonly policy: string;
      };

      expect(calls).toEqual([
        { tool: 'web_search', query: 'Which browser agents have the best user experience?', maxResults: 2, verbosity: 'evidence', safeSearch: 'moderate', includeEvidence: true, evidenceTopN: 1, evidenceExtract: 'readable' },
      ]);
      expect(packet.status).toBe('source-collection-checkpointed');
      expect(packet.query).toBe('Which browser agents have the best user experience?');
      expect(packet.resultCount).toBe(1);
      expect(packet.sourceCandidateCount).toBe(1);
      expect(packet.savedSourceCount).toBe(1);
      expect(packet.reusedSourceCount).toBe(0);
      expect(packet.run.status).toBe('running');
      expect(packet.run.phase).toBe('reading');
      expect(packet.run.progress).toBeGreaterThanOrEqual(35);
      expect(packet.run.sourceIds).toEqual([packet.sources[0]?.sourceId]);
      expect(packet.run.inspectRoute).toContain(`runId:"${packet.run.id}"`);
      expect(packet.sources[0]).toMatchObject({
        title: 'Browser Agent Report',
        status: 'candidate',
        credibility: 'unreviewed',
      });
      expect(packet.sources[0]?.inspectRoute).toContain(`sourceId:"${packet.sources[0]?.sourceId}"`);
      expect(packet.sources[0]?.reviewRoute).toContain('confirm:true');
      expect(packet.sources[0]?.reportLine).toContain('https://example.test/report?api_key=%3Credacted%3E');
      expect(packet.nextRoutes.run).toContain(`runId:"${packet.run.id}"`);
      expect(packet.nextRoutes.sources).toContain('includeReportLines:true');
      expect(packet.nextRoutes.bundle).toContain('includeReportLines:true');
      expect(packet.nextRoutes.saveReport).toContain('requireCitationCoverage:true');
      expect(packet.policy).toContain('does not save a report');
      expect(packet.policy).toContain('does not save a report, ingest Knowledge, send messages, or control a browser/PWA surface');

      const savedRun = AgentResearchRunRegistry.fromShellPaths(shellPaths).get(packet.run.id);
      const savedSources = AgentResearchSourceRegistry.fromShellPaths(shellPaths).list();
      expect(savedRun?.status).toBe('running');
      expect(savedRun?.phase).toBe('reading');
      expect(savedRun?.checkpoints.at(-1)?.sourceIds).toEqual(packet.run.sourceIds);
      expect(savedSources).toHaveLength(1);
      expect(savedSources[0]?.url).toBe('https://example.test/report?api_key=%3Credacted%3E');
      expect(savedSources[0]?.provenance).toBe('agent-research-runner');
      expect(savedSources[0]?.tags).toEqual(['research', 'web-search', 'runner']);
      expect(calls.some((call) => call.tool === 'agent_research_report')).toBe(false);
      expect(calls.some((call) => call.tool === 'agent_artifacts')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('routes source bundle and confirmed writes to existing research tools', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'bundle', query: 'browser agents', limit: 4 });
    await tool.execute({
      action: 'create_run',
      title: 'Browser agent comparison',
      question: 'Which local browser agents are strongest?',
      plan: ['Search', 'Review', 'Report'],
      confirm: true,
      explicitUserRequest: 'Start a visible research run.',
    });
    await tool.execute({
      action: 'add_source',
      question: 'Which local browser agents are strongest?',
      title: 'Odysseus README',
      url: 'https://example.test/odysseus',
      summary: 'Local-first browser agent notes.',
      confirm: true,
      explicitUserRequest: 'Capture this source.',
    });
    await tool.execute({
      action: 'review_source',
      sourceId: 'src_123',
      credibility: 'high',
      score: 90,
      note: 'Primary project source.',
      confirm: true,
      explicitUserRequest: 'Review this source.',
    });
    await tool.execute({
      action: 'report',
      runId: 'run_123',
      title: 'Browser agent comparison report',
      question: 'Which local browser agents are strongest?',
      sources: [{ title: 'Odysseus README', credibility: 'high' }],
      visualReport: true,
      confirm: true,
      explicitUserRequest: 'Save this sourced report.',
    });

    expect(calls).toEqual([
      { tool: 'agent_research_sources', mode: 'bundle', query: 'browser agents', limit: 4, includeReportLines: true },
      {
        tool: 'agent_research_runs',
        mode: 'create',
        title: 'Browser agent comparison',
        question: 'Which local browser agents are strongest?',
        plan: ['Search', 'Review', 'Report'],
        confirm: true,
        explicitUserRequest: 'Start a visible research run.',
      },
      {
        tool: 'agent_research_sources',
        mode: 'add',
        question: 'Which local browser agents are strongest?',
        title: 'Odysseus README',
        url: 'https://example.test/odysseus',
        summary: 'Local-first browser agent notes.',
        confirm: true,
        explicitUserRequest: 'Capture this source.',
      },
      {
        tool: 'agent_research_sources',
        mode: 'review',
        id: 'src_123',
        credibility: 'high',
        score: 90,
        note: 'Primary project source.',
        confirm: true,
        explicitUserRequest: 'Review this source.',
      },
      {
        tool: 'agent_research_report',
        runId: 'run_123',
        title: 'Browser agent comparison report',
        question: 'Which local browser agents are strongest?',
        sources: [{ title: 'Odysseus README', credibility: 'high' }],
        visualReport: true,
        confirm: true,
        explicitUserRequest: 'Save this sourced report.',
      },
    ]);
  });

  test('routes confirmed run lifecycle and source status changes', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({
      action: 'checkpoint',
      runId: 'run_123',
      phase: 'reading',
      progress: 45,
      sourceIds: ['src_123'],
      confirm: true,
      explicitUserRequest: 'Checkpoint this research run.',
    });
    await tool.execute({
      action: 'pause',
      id: 'run_123',
      note: 'Waiting for user review.',
      confirm: true,
      explicitUserRequest: 'Pause the research run.',
    });
    await tool.execute({
      action: 'complete',
      id: 'run_123',
      reportArtifactId: 'artifact_123',
      confirm: true,
      explicitUserRequest: 'Complete the research run.',
    });
    await tool.execute({
      action: 'reject_source',
      sourceId: 'src_123',
      note: 'Outdated secondary source.',
      confirm: true,
      explicitUserRequest: 'Reject this source.',
    });
    await tool.execute({
      action: 'use_source',
      sourceId: 'src_456',
      reportArtifactId: 'artifact_123',
      confirm: true,
      explicitUserRequest: 'Mark this source used.',
    });

    expect(calls).toEqual([
      {
        tool: 'agent_research_runs',
        mode: 'checkpoint',
        id: 'run_123',
        phase: 'reading',
        progress: 45,
        sourceIds: ['src_123'],
        confirm: true,
        explicitUserRequest: 'Checkpoint this research run.',
      },
      {
        tool: 'agent_research_runs',
        mode: 'pause',
        id: 'run_123',
        note: 'Waiting for user review.',
        confirm: true,
        explicitUserRequest: 'Pause the research run.',
      },
      {
        tool: 'agent_research_runs',
        mode: 'complete',
        id: 'run_123',
        reportArtifactId: 'artifact_123',
        confirm: true,
        explicitUserRequest: 'Complete the research run.',
      },
      {
        tool: 'agent_research_sources',
        mode: 'reject',
        id: 'src_123',
        note: 'Outdated secondary source.',
        confirm: true,
        explicitUserRequest: 'Reject this source.',
      },
      {
        tool: 'agent_research_sources',
        mode: 'use',
        id: 'src_456',
        reportArtifactId: 'artifact_123',
        confirm: true,
        explicitUserRequest: 'Mark this source used.',
      },
    ]);
  });

  test('registers the direct research adapter', () => {
    const registry = new ToolRegistry();

    registerAgentResearchTool(registry, {} as CommandRegistry, { workspace: {}, platform: {} } as CommandContext);

    expect(registry.has('research')).toBe(true);
  });
});
