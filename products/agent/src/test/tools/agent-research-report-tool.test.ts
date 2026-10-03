import { describe, expect, test } from 'bun:test';
import type { ArtifactCreateInput, ArtifactDescriptor, ArtifactRecord, ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { createAgentResearchReportTool, registerAgentResearchReportTool } from '../../tools/agent-research-report-tool.ts';

class ResearchReportArtifactStore implements Pick<ArtifactStore, 'create'> {
  readonly records: ArtifactRecord[] = [];
  readonly contents = new Map<string, string>();

  async create(input: ArtifactCreateInput): Promise<ArtifactDescriptor> {
    const id = `artifact-${this.records.length + 1}`;
    const text = input.text ?? '';
    const record: ArtifactRecord = {
      id,
      kind: input.kind ?? 'document',
      mimeType: input.mimeType ?? 'text/plain',
      ...(input.filename ? { filename: input.filename } : {}),
      sizeBytes: Buffer.byteLength(text, 'utf-8'),
      sha256: `sha-${id}`,
      createdAt: Date.now(),
      acquisitionMode: input.acquisitionMode ?? 'inline-data',
      fetchMode: input.fetchMode ?? 'not-applicable',
      metadata: input.metadata ?? {},
      contentPath: `/tmp/${id}.md`,
      metadataPath: `/tmp/${id}.json`,
    };
    this.records.push(record);
    this.contents.set(id, text);
    return record;
  }
}

describe('agent_research_report tool', () => {
  test('saves a sourced markdown report artifact without printing report content', async () => {
    const store = new ResearchReportArtifactStore();
    const tool = createAgentResearchReportTool(store);

    const result = await tool.execute({
      runId: 'local-model-options-run',
      title: 'Local Model Options',
      question: 'Which local model serving route should this user try first?',
      summary: 'Ollama is easiest; vLLM is throughput-oriented.',
      reportMarkdown: 'Ollama is easiest for first setup [S1].\n\nvLLM fits throughput-heavy use [S2].',
      sources: [
        {
          title: 'Ollama docs',
          url: 'https://example.test/ollama?token=secret-token',
          credibility: 'high',
          note: 'Official setup docs.',
        },
        'vLLM docs | https://example.test/vllm | medium | Project docs.',
      ],
      findings: ['Use Ollama for first local route.'],
      gaps: ['Benchmark after setup.'],
      recommendations: ['Offer a hardware-aware setup checklist.'],
      methodology: 'Compared official setup paths and operational complexity.',
      confidence: 'medium',
      tags: ['research', 'local-models'],
      confirm: true,
      explicitUserRequest: 'Save the reviewed local model research report.',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Saved Agent research report artifact');
    expect(result.output).toContain('artifact artifact-1');
    expect(result.output).toContain('sources 2');
    expect(result.output).toContain('citationCoverage 2/2 cited; uncited 0; unknown 0');
    expect(result.output).toContain('nextRoutes');
    expect(result.output).toContain('inspect research action:"report_artifact" artifactId:"artifact-1"');
    expect(result.output).toContain('promoteKnowledge agent_knowledge_ingest sourceKind:"artifact" artifactId:"artifact-1"');
    expect(result.output).toContain('completeRun research action:"complete" id:"local-model-options-run" reportArtifactId:"artifact-1"');
    expect(result.output).not.toContain('Ollama is easiest for first setup');
    expect(result.output).not.toContain('secret-token');

    const record = store.records[0];
    expect(record?.filename).toBe('local-model-options.md');
    expect(record?.metadata).toMatchObject({
      purpose: 'agent-research-report',
      source: 'agent-research-report',
      title: 'Local Model Options',
      question: 'Which local model serving route should this user try first?',
      confidence: 'medium',
      tags: ['research', 'local-models'],
      sourceCount: 2,
      citationCoverage: {
        sourceCount: 2,
        citedSourceIds: ['S1', 'S2'],
        missingSourceIds: [],
        unknownCitationIds: [],
        repairSuggestions: [],
        coverageRatio: 1,
        pass: true,
      },
    });
    const sources = record?.metadata.sources as Array<{ readonly url?: string }>;
    expect(sources[0]?.url).toBeUndefined();
    expect(record?.metadata.sources).toMatchObject([{ urlOmitted: true }, {}]);
    const content = store.contents.get('artifact-1') ?? '';
    expect(content).toContain('# Local Model Options');
    expect(content).toContain('## Citation Coverage');
    expect(content).toContain('Cited in body: S1, S2');
    expect(content).toContain('Repair suggestions: (none)');
    expect(content).toContain('## Source Map');
    expect(content).toContain('[S1] Ollama docs');
    expect(content).toContain('URL status: withheld before transmission');
    expect(content).not.toContain('secret-token');
  });

  test('adds a visual report packet when requested', async () => {
    const store = new ResearchReportArtifactStore();
    const tool = createAgentResearchReportTool(store);

    const result = await tool.execute({
      title: 'Deep Research Packet',
      question: 'What should the user do next?',
      summary: 'The next step is to save a visible, source-backed packet [S1] and archive it for review [S2].',
      reportMarkdown: 'A visual packet makes review easier when it stays tied to the same citations [S1]. Archive handoff should stay explicit [S2].',
      sources: [
        {
          title: 'Research source workflow',
          url: 'https://example.test/research',
          publisher: 'Example Docs',
          publishedAt: '2026-06-01',
          credibility: 'high',
          note: 'Explains reviewed source queues.',
        },
        {
          title: 'Artifact archive guide',
          url: 'https://example.test/archive',
          accessedAt: '2026-06-06',
          credibility: 'medium',
          note: 'Explains artifact archive handoff.',
        },
      ],
      findings: ['Save a visual packet only after reviewed sources exist [S1].'],
      gaps: ['Browser-backed execution still needs a live runner contract.'],
      recommendations: ['Archive the saved report and related source artifacts [S2].'],
      confidence: 'high',
      visualReport: true,
      requireCitationCoverage: true,
      confirm: true,
      explicitUserRequest: 'Save the reviewed deep research visual packet.',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('visualReport markdown-visual-report-packet');
    expect(result.output).not.toContain('The next step is to save');

    const record = store.records[0];
    expect(record?.metadata).toMatchObject({
      visualReport: {
        format: 'markdown-visual-report-packet',
        sourceCount: 2,
        findingCount: 1,
        gapCount: 1,
        recommendationCount: 1,
        datedSourceCount: 2,
        citationCoveragePass: true,
        missingSourceIds: [],
        unknownCitationIds: [],
      },
    });
    const content = store.contents.get('artifact-1') ?? '';
    expect(content).toContain('## Visual Report Packet');
    expect(content).toContain('### At A Glance');
    expect(content).toContain('### Evidence Matrix');
    expect(content).toContain('| S1 Research source workflow | high | Example Docs | Explains reviewed source queues. | cited in body |');
    expect(content).toContain('### Findings Board');
    expect(content).toContain('| Save a visual packet only after reviewed sources exist [S1]. | S1 |');
    expect(content).toContain('### Dated Sources');
    expect(content).toContain('| 2026-06-01 | S1 Research source workflow | cited |');
    expect(content).toContain('### Handoff Checklist');
    expect(content).toContain('agent_knowledge_ingest sourceKind:"artifact"');
  });

  test('requires confirmation and at least one reviewed source', async () => {
    const store = new ResearchReportArtifactStore();
    const tool = createAgentResearchReportTool(store);

    const unconfirmed = await tool.execute({
      title: 'Report',
      question: 'What happened?',
      summary: 'A concise answer.',
      sources: [{ title: 'Source', url: 'https://example.test', credibility: 'high' }],
      explicitUserRequest: 'Save the report.',
    });
    expect(unconfirmed.success).toBe(false);
    expect(unconfirmed.error).toContain('confirm:true');
    expect(store.records).toHaveLength(0);

    const unsourced = await tool.execute({
      title: 'Report',
      question: 'What happened?',
      summary: 'A concise answer.',
      sources: [],
      confirm: true,
      explicitUserRequest: 'Save the report.',
    });
    expect(unsourced.success).toBe(false);
    expect(unsourced.error).toContain('reviewed source');
  });

  test('records citation coverage warnings and can enforce complete body citations', async () => {
    const store = new ResearchReportArtifactStore();
    const tool = createAgentResearchReportTool(store);

    const loose = await tool.execute({
      title: 'Coverage Warnings',
      question: 'Are sources cited?',
      summary: 'Only one source is cited [S1], and one unknown citation appears [S3].',
      sources: [
        { title: 'Source one', url: 'https://example.test/one', credibility: 'high' },
        { title: 'Source two', url: 'https://example.test/two', credibility: 'medium' },
      ],
      confirm: true,
      explicitUserRequest: 'Save the report with coverage metadata.',
    });
    expect(loose.success).toBe(true);
    expect(loose.output).toContain('citationCoverage 1/2 cited; uncited 1; unknown 1');
    expect(loose.output).toContain('citationRepair Add body citation for S2 (Source two). Replace or remove unknown citation S3. Valid source ids are S1-S2.');
    expect(store.records[0]?.metadata).toMatchObject({
      citationCoverage: {
        sourceCount: 2,
        citedSourceIds: ['S1'],
        missingSourceIds: ['S2'],
        unknownCitationIds: ['S3'],
        repairSuggestions: [
          'Add body citation for S2 (Source two).',
          'Replace or remove unknown citation S3. Valid source ids are S1-S2.',
        ],
        coverageRatio: 0.5,
        pass: false,
      },
    });

    const strict = await tool.execute({
      title: 'Strict Coverage',
      question: 'Are sources cited?',
      summary: 'Only one source is cited [S1].',
      sources: [
        { title: 'Source one', url: 'https://example.test/one', credibility: 'high' },
        { title: 'Source two', url: 'https://example.test/two', credibility: 'medium' },
      ],
      requireCitationCoverage: true,
      confirm: true,
      explicitUserRequest: 'Save only if every source is cited.',
    });
    expect(strict.success).toBe(false);
    expect(strict.error).toContain('Citation coverage check failed');
    expect(strict.error).toContain('Missing body citations: S2');
    expect(strict.error).toContain('Repair suggestions: Add body citation for S2 (Source two).');
  });

  test('fails clearly without an artifact store and registers with the tool registry', async () => {
    const unavailable = await createAgentResearchReportTool().execute({
      title: 'Report',
      question: 'What happened?',
      summary: 'A concise answer.',
      sources: [{ title: 'Source', url: 'https://example.test', credibility: 'high' }],
      confirm: true,
      explicitUserRequest: 'Save the report.',
    });
    expect(unavailable.success).toBe(false);
    expect(unavailable.error).toContain('artifact store');

    const registry = new ToolRegistry();
    registerAgentResearchReportTool(registry, new ResearchReportArtifactStore());
    expect(registry.has('agent_research_report')).toBe(true);
  });
});


describe('research report source containment', () => {
  const base = {
    title: 'Sources', question: 'What is supported?', summary: 'Evidence [S1].',
    confirm: true, explicitUserRequest: 'Save this research report.',
  };

  for (const url of [
    'https://example.test/doc?token=sentinel',
    'https://example.test/doc?auth_token=sentinel',
    'https://sentinel@example.test/doc',
    'https://[invalid?token=sentinel',
    'https:broken?token=sentinel',
    'https://[invalid ?token=sentinel',
  ]) {
    test(`contains source URL and aliases: ${url}`, async () => {
      for (const entry of [url, { url }, { name: url, url }, { title: url, url, note: url, publisher: url }]) {
        const store = new ResearchReportArtifactStore();
        const result = await createAgentResearchReportTool(store).execute({ ...base, sources: [entry] });
        expect(result.success).toBe(true);
        const emitted = JSON.stringify([result, store.records, [...store.contents.values()]]);
        expect(emitted).not.toContain('sentinel');
        expect(store.records[0]?.metadata.sources).toMatchObject([{ urlOmitted: true }]);
        expect(store.contents.get('artifact-1')).toContain('URL status: withheld before transmission');
      }
    });
  }

  for (const url of ['https://example.test/doc?access_token=sentinel', 'https://example.test/doc?api_key=sentinel', 'https://sentinel:password@example.test/doc']) {
    test(`refuses declared credential syntax before storing a report: ${url}`, async () => {
      for (const entry of [url, { url }, { name: url, url }, { title: url, url, note: url }]) {
        const store = new ResearchReportArtifactStore();
        const result = await createAgentResearchReportTool(store).execute({ ...base, sources: [entry] });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Refused before judgment');
        expect(JSON.stringify(result)).not.toContain('sentinel');
        expect(store.records).toHaveLength(0);
      }
    });
  }

  test('withholds malformed references before permissive URL parsing can repair them', async () => {
    for (const url of ['https://example.test/doc\nument', 'https://example.test/doc\tument', 'https://example.test\\document', 'https:///example.test/document']) {
      for (const source of [url, { url }, { title: url, url }, { name: url, url, note: url }]) {
        const store = new ResearchReportArtifactStore();
        const result = await createAgentResearchReportTool(store).execute({ ...base, sources: [source] });
        expect(result.success).toBe(true);
        expect(store.records[0]?.metadata.sources).toMatchObject([{ title: '[source URL withheld]', urlOmitted: true }]);
        const sources = store.records[0]?.metadata.sources as Array<{ url?: string }>;
        expect(sources[0]?.url).toBeUndefined();
        expect(store.contents.get('artifact-1')).not.toContain('https://example.test/document');
      }
    }
  });

  test('retains safe sources, query-dependent citations and section anchors', async () => {
    const store = new ResearchReportArtifactStore();
    const result = await createAgentResearchReportTool(store).execute({ ...base, sources: [
      'https://example.test/document | high | Official documentation.',
      { name: 'Search results', url: 'https://example.test/article?id=123', note: 'Query-dependent source.' },
      'https://example.test/guide#section-2',
    ] });
    expect(result.success).toBe(true);
    expect(store.records[0]?.metadata.sources).toMatchObject([
      { title: 'https://example.test/document', url: 'https://example.test/document', credibility: 'high', note: 'Official documentation.' },
      { title: 'Search results', url: 'https://example.test/article?id=123', note: 'Query-dependent source.' },
      { title: 'https://example.test/guide#section-2', url: 'https://example.test/guide#section-2' },
    ]);
    const sources = store.records[0]?.metadata.sources as Array<{ url?: string }>;
    expect(sources[1]?.url).toBe('https://example.test/article?id=123');
    expect(sources[2]?.url).toBe('https://example.test/guide#section-2');
  });

  test('rejects source getters without invoking them or writing an artifact', async () => {
    const store = new ResearchReportArtifactStore();
    let reads = 0;
    const source = { title: 'Example', get url() { reads++; return 'https://example.test/?token=sentinel'; } };
    const result = await createAgentResearchReportTool(store).execute({ ...base, sources: [source] });
    expect(result.success).toBe(false);
    expect(reads).toBe(0);
    expect(store.records).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('sentinel');
  });

  test('rejects top-level source getter without invoking it', async () => {
    const store = new ResearchReportArtifactStore();
    let reads = 0;
    const result = await createAgentResearchReportTool(store).execute({ ...base, get sources() { reads++; return []; } });
    expect(result.success).toBe(false);
    expect(reads).toBe(0);
  });

  test('rejects array accessors and serialization hooks without executing them', async () => {
    let invoked = 0;
    const sources: unknown[] = [];
    Object.defineProperty(sources, '0', { get() { invoked++; return { title: 'sentinel' }; } });
    const hooked = { title: 'Source' };
    Object.defineProperty(hooked, 'toJSON', { value: () => { invoked++; return 'sentinel'; } });
    for (const input of [sources, [hooked]]) {
      const store = new ResearchReportArtifactStore();
      const result = await createAgentResearchReportTool(store).execute({ ...base, sources: input });
      expect(result.success).toBe(false);
      expect(store.records).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain('sentinel');
    }
    expect(invoked).toBe(0);
  });

  test('checks sources beyond the retained source-count cap before projection', async () => {
    const store = new ResearchReportArtifactStore();
    const sources = Array.from({ length: 50 }, () => ({ title: 'Safe source', url: 'https://example.test/doc' }));
    sources.push({ title: 'Credential source', url: 'https://example.test/?access_token=sentinel' });
    const result = await createAgentResearchReportTool(store).execute({ ...base, sources });
    expect(result.success).toBe(false);
    expect(store.records).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('sentinel');
  });

  test('owns source values across artifact creation and later mutation', async () => {
    const source = { title: 'Original source', url: 'https://example.test/document' };
    const store = new ResearchReportArtifactStore();
    const create = store.create.bind(store);
    store.create = async (input) => {
      source.title = 'https://example.test/?token=sentinel';
      Object.defineProperty(source, 'url', { get() { throw new Error('sentinel'); } });
      return create(input);
    };
    const result = await createAgentResearchReportTool(store).execute({ ...base, sources: [source] });
    expect(result.success).toBe(true);
    expect(JSON.stringify([result, store.records, [...store.contents.values()]])).not.toContain('sentinel');
    expect(store.records[0]?.metadata.sources).toMatchObject([{ title: 'Original source', url: 'https://example.test/document' }]);
  });

  test('runs the full pre-judgment boundary over aliases before saving', async () => {
    const store = new ResearchReportArtifactStore();
    const result = await createAgentResearchReportTool(store).execute({ ...base,
      sources: [{ name: 'Ordinary title', note: `${'ordinary '.repeat(600)}authorization: Bearer sentinel` }],
    });
    expect(result.success).toBe(false);
    expect(store.records).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('sentinel');
  });
});
