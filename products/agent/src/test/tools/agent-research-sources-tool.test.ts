import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { AgentResearchSourceRegistry } from '../../agent/research-source-registry.ts';
import { createAgentResearchSourcesTool, registerAgentResearchSourcesTool } from '../../tools/agent-research-sources-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makePaths() {
  const root = makeProjectTempDir('goodvibes-agent-research-sources-tool');
  return {
    root,
    paths: {
      resolveProjectPath: (...parts: string[]) => join(root, '.goodvibes', ...parts),
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('agent_research_sources tool', () => {
  test('adds and lists local source queue records without leaking URL secrets', async () => {
    const fixture = makePaths();
    try {
      const tool = createAgentResearchSourcesTool(fixture.paths);
      const missingIntent = await tool.execute({
        mode: 'add',
        question: 'Which source should we cite?',
        title: 'Official docs',
        url: 'https://example.test/docs',
        summary: 'Official source.',
      });
      expect(missingIntent.success).toBe(false);
      expect(missingIntent.error).toContain('explicitUserRequest');

      const added = await tool.execute({
        mode: 'add',
        question: 'Which source should we cite?',
        title: 'Official docs',
        url: 'https://example.test/docs?api_key=secret-value',
        publisher: 'Example',
        summary: 'Official source.',
        credibility: 'high',
        score: 88,
        tags: ['research', 'docs'],
        note: 'Primary source.',
        confirm: true,
        explicitUserRequest: 'Add this source to the queue.',
      });
      expect(added.success).toBe(true);
      expect(added.output).toContain('Added Agent research source');
      expect(added.output).toContain('reportLine Official docs');
      expect(added.output).toContain('nextRoutes');
      expect(added.output).toContain('bundle research action:"bundle" query:"Which source should we cite?"');
      expect(added.output).toContain('promoteUrl agent_knowledge_ingest sourceKind:"url"');
      expect(added.output).not.toContain('secret-value');

      const listed = await tool.execute({ mode: 'list', includeReportLines: true });
      expect(listed.success).toBe(true);
      expect(listed.output).toContain('Agent research sources');
      expect(listed.output).toContain('Report source lines');
      expect(listed.output).not.toContain('secret-value');

      const bundled = await tool.execute({ mode: 'bundle', query: 'docs', limit: 5 });
      expect(bundled.success).toBe(true);
      expect(bundled.output).toContain('Agent research source bundle');
      expect(bundled.output).toContain('sources 1');
      expect(bundled.output).toContain('Report source lines');
      expect(bundled.output).toContain('[S1] Official docs');
      expect(bundled.output).toContain('Citation plan');
      expect(bundled.output).toContain('research action:"report" handoff');
      expect(bundled.output).toContain('requireCitationCoverage:true');
      expect(bundled.output).toContain('"title": "Official docs"');
      expect(bundled.output).not.toContain('secret-value');

      const source = AgentResearchSourceRegistry.fromShellPaths(fixture.paths).get('official-docs');
      expect(source?.status).toBe('reviewed');
      expect(source?.url).toContain('api_key=%3Credacted%3E');
    } finally {
      fixture.cleanup();
    }
  });

  test('shows, reviews, rejects, marks used, deletes, and registers', async () => {
    const fixture = makePaths();
    try {
      const tool = createAgentResearchSourcesTool(fixture.paths);
      const add = await tool.execute({
        mode: 'add',
        question: 'What source should the report use?',
        title: 'Candidate source',
        url: 'https://example.test/candidate',
        summary: 'Candidate summary.',
        confirm: true,
        explicitUserRequest: 'Add this source.',
      });
      expect(add.success).toBe(true);

      const shown = await tool.execute({ mode: 'show', id: 'candidate-source' });
      expect(shown.success).toBe(true);
      expect(shown.output).toContain('Report source line');
      expect(shown.output).toContain('Next routes');
      expect(shown.output).toContain('review research action:"review_source" id:"candidate-source"');

      const reviewed = await tool.execute({
        mode: 'review',
        id: 'candidate-source',
        credibility: 'medium',
        score: 70,
        note: 'Useful but secondary.',
        confirm: true,
        explicitUserRequest: 'Review this source.',
      });
      expect(reviewed.success).toBe(true);
      expect(reviewed.output).toContain('Reviewed Agent research source');
      expect(reviewed.output).toContain('credibility medium');
      expect(reviewed.output).toContain('report research action:"report" question:"What source should the report use?"');
      expect(reviewed.output).toContain('markUsed research action:"use_source" id:"candidate-source"');
      expect(reviewed.output).toContain('promoteUrl agent_knowledge_ingest sourceKind:"url" url:"https://example.test/candidate"');

      const used = await tool.execute({
        mode: 'use',
        id: 'candidate-source',
        reportArtifactId: 'artifact-9',
        confirm: true,
        explicitUserRequest: 'Mark this source used in the report.',
      });
      expect(used.success).toBe(true);
      expect(used.output).toContain('Marked Agent research source used');
      expect(used.output).toContain('reportArtifact research action:"report_artifact" artifactId:"artifact-9"');
      expect(used.output).toContain('promoteReport agent_knowledge_ingest sourceKind:"artifact" artifactId:"artifact-9"');

      const rejected = await tool.execute({
        mode: 'reject',
        id: 'candidate-source',
        note: 'Superseded by a primary source.',
        confirm: true,
        explicitUserRequest: 'Reject this source.',
      });
      expect(rejected.success).toBe(true);
      expect(rejected.output).toContain('Rejected Agent research source');
      expect(rejected.output).toContain('reAdd research action:"add_source" question:"What source should the report use?"');

      const unconfirmedDelete = await tool.execute({
        mode: 'delete',
        id: 'candidate-source',
        explicitUserRequest: 'Delete this source.',
      });
      expect(unconfirmedDelete.success).toBe(false);
      expect(unconfirmedDelete.error).toContain('confirm:true');

      const deleted = await tool.execute({
        mode: 'delete',
        id: 'candidate-source',
        confirm: true,
        explicitUserRequest: 'Delete this source.',
      });
      expect(deleted.success).toBe(true);
      expect(deleted.output).toContain('Deleted Agent research source');
      expect(deleted.output).toContain('queue research action:"sources" query:"What source should the report use?"');

      const registry = new ToolRegistry();
      registerAgentResearchSourcesTool(registry, fixture.paths);
      expect(registry.has('agent_research_sources')).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test('fails clearly without shell paths', async () => {
    const result = await createAgentResearchSourcesTool().execute({ mode: 'list' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('shell paths');
  });
  test('says when a citation bundle stopped at the limit rather than running out of sources', async () => {
    const fixture = makePaths();
    try {
      const tool = createAgentResearchSourcesTool(fixture.paths);
      for (let index = 0; index < 4; index += 1) {
        const added = await tool.execute({
          mode: 'add',
          question: 'Which sources back this claim?',
          title: `Bundle source ${index}`,
          url: `https://example.test/bundle-${index}`,
          publisher: 'Example',
          summary: `Bundle source ${index} summary.`,
          credibility: 'high',
          score: 90 - index,
          confirm: true,
          explicitUserRequest: 'Add this source to the queue.',
        });
        expect(added.success).toBe(true);
      }

      const short = await tool.execute({ mode: 'bundle', limit: 2 });
      expect(short.success).toBe(true);
      expect(short.output).toContain('sources 2 of 4 matched');
      expect(short.output).toContain('this bundle is short');

      const whole = await tool.execute({ mode: 'bundle', limit: 20 });
      expect(whole.success).toBe(true);
      expect(whole.output).toContain('sources 4');
      expect(whole.output).not.toContain('this bundle is short');
    } finally {
      fixture.cleanup();
    }
  });

});
