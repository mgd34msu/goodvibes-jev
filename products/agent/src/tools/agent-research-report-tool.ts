import { prepareAgentResearchReportInput, type AgentResearchReportSource as ResearchSource } from '../agent/research-report-input.ts';
import type { ArtifactDescriptor, ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';

export interface AgentResearchReportToolArgs {
  readonly runId?: unknown;
  readonly id?: unknown;
  readonly title?: unknown;
  readonly question?: unknown;
  readonly summary?: unknown;
  readonly reportMarkdown?: unknown;
  readonly sources?: unknown;
  readonly findings?: unknown;
  readonly gaps?: unknown;
  readonly recommendations?: unknown;
  readonly methodology?: unknown;
  readonly confidence?: unknown;
  readonly tags?: unknown;
  readonly requireCitationCoverage?: unknown;
  readonly visualReport?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

type AgentResearchReportArtifactStore = Pick<ArtifactStore, 'create'>;

interface CitationCoverage {
  readonly sourceCount: number;
  readonly citedSourceIds: readonly string[];
  readonly missingSourceIds: readonly string[];
  readonly unknownCitationIds: readonly string[];
  readonly repairSuggestions: readonly string[];
  readonly coverageRatio: number;
  readonly pass: boolean;
}

const MAX_REPORT_CHARS = 80_000;

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 'yes';
}

function readList(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.map(readString).filter(Boolean);
  return readString(value)
    .split(/\n/)
    .map((entry) => entry.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
}

function readTags(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.map(readString).filter(Boolean);
  return readString(value).split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
}

function previewText(value: string, limit = 240): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.slice(0, 64) || 'research-report';
}

function failure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

function output(text: string): { readonly success: true; readonly output: string } {
  return { success: true, output: text };
}

function routeString(value: string): string {
  return JSON.stringify(value);
}

function preview(args: AgentResearchReportToolArgs, sources: readonly ResearchSource[]): string {
  return [
    'Agent research report preview',
    `  title ${readString(args.title) || '(missing)'}`,
    `  question ${readString(args.question) || '(missing)'}`,
    `  sources ${sources.length}`,
    `  confidence ${readString(args.confidence) || '(unspecified)'}`,
    '  policy saving a sourced report artifact requires confirm:true',
  ].join('\n');
}

function listSection(title: string, items: readonly string[]): string {
  if (items.length === 0) return '';
  return [`## ${title}`, '', ...items.map((item) => `- ${item}`), ''].join('\n');
}

function markdownCell(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return (text || '(none)').replace(/\|/g, '\\|');
}

function citationIdsInText(value: string): readonly string[] {
  const ids = new Set<string>();
  for (const match of value.matchAll(/\[S(\d+)\]/gi)) ids.add(`S${Number(match[1] ?? 0)}`);
  return Array.from(ids).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function evidenceLabel(value: string): string {
  return citationIdsInText(value).join(', ') || 'needs citation';
}

function visualReportSection(
  args: AgentResearchReportToolArgs,
  sources: readonly ResearchSource[],
  coverage: CitationCoverage,
): string {
  const summary = readString(args.summary);
  const findings = readList(args.findings);
  const gaps = readList(args.gaps);
  const recommendations = readList(args.recommendations);
  const datedSources = sources
    .map((source, index) => ({ id: `S${index + 1}`, source, date: source.publishedAt || source.accessedAt || '' }))
    .filter((entry) => entry.date);
  const sourceUse = new Set(coverage.citedSourceIds);
  const lines = [
    '## Visual Report Packet',
    '',
    '### At A Glance',
    '',
    `- Answer: ${summary ? previewText(summary) : '(summary not provided)'}`,
    `- Confidence: ${readString(args.confidence) || 'unspecified'}`,
    `- Sources: ${coverage.sourceCount}`,
    `- Citation coverage: ${coverage.citedSourceIds.length}/${coverage.sourceCount} cited`,
    `- Needs repair: ${coverage.repairSuggestions.join(' ') || 'none'}`,
    '',
    '### Evidence Matrix',
    '',
    '| Source | Credibility | Publisher | Evidence Note | Report Use |',
    '| --- | --- | --- | --- | --- |',
    ...sources.map((source, index) => {
      const id = `S${index + 1}`;
      return [
        `| ${markdownCell(`${id} ${source.title}`)}`,
        markdownCell(source.credibility),
        markdownCell(source.publisher ?? ''),
        markdownCell(previewText(source.note ?? '', 180)),
        `${sourceUse.has(id) ? 'cited in body' : 'needs body citation'} |`,
      ].join(' | ');
    }),
    '',
  ];
  if (findings.length > 0) {
    lines.push(
      '### Findings Board',
      '',
      '| Finding | Evidence |',
      '| --- | --- |',
      ...findings.map((finding) => `| ${markdownCell(finding)} | ${markdownCell(evidenceLabel(finding))} |`),
      '',
    );
  }
  if (datedSources.length > 0) {
    lines.push(
      '### Dated Sources',
      '',
      '| Date | Source | Use |',
      '| --- | --- | --- |',
      ...datedSources.map((entry) => `| ${markdownCell(entry.date)} | ${markdownCell(`${entry.id} ${entry.source.title}`)} | ${markdownCell(sourceUse.has(entry.id) ? 'cited' : 'needs citation')} |`),
      '',
    );
  } else {
    lines.push(
      '### Dated Sources',
      '',
      'No dated sources were provided. Treat this as a comparison packet rather than a chronology.',
      '',
    );
  }
  if (gaps.length > 0) lines.push('### Open Questions', '', ...gaps.map((gap) => `- ${gap}`), '');
  if (recommendations.length > 0) {
    lines.push(
      '### Next Actions',
      '',
      '| Action | Evidence |',
      '| --- | --- |',
      ...recommendations.map((recommendation) => `| ${markdownCell(recommendation)} | ${markdownCell(evidenceLabel(recommendation))} |`),
      '',
    );
  }
  lines.push(
    '### Handoff Checklist',
    '',
    '- Review citation coverage and repair suggestions before sharing.',
    '- Inspect the saved artifact with `agent_artifacts mode:"show" includeContent:true`.',
    '- Archive the report with related research source artifacts through `agent_artifacts mode:"archive"`.',
    '- Promote to Knowledge only through a separate confirmed `agent_knowledge_ingest sourceKind:"artifact"` call.',
    '',
  );
  return lines.join('\n');
}

function sourceMapSection(sources: readonly ResearchSource[]): string {
  const lines = ['## Source Map', ''];
  sources.forEach((source, index) => {
    const id = `S${index + 1}`;
    lines.push(`- [${id}] ${source.title}`);
    if (source.url) lines.push(`  - URL: ${source.url}`);
    if (source.urlOmitted) lines.push('  - URL status: withheld before transmission; the original reference was not retained.');
    if (source.publisher) lines.push(`  - Publisher: ${source.publisher}`);
    if (source.publishedAt) lines.push(`  - Published: ${source.publishedAt}`);
    if (source.accessedAt) lines.push(`  - Accessed: ${source.accessedAt}`);
    lines.push(`  - Credibility: ${source.credibility}`);
    if (source.note) lines.push(`  - Note: ${source.note}`);
  });
  lines.push('');
  return lines.join('\n');
}

function reportBodyText(args: AgentResearchReportToolArgs): string {
  return [
    readString(args.summary),
    readString(args.reportMarkdown),
    ...readList(args.findings),
    ...readList(args.gaps),
    ...readList(args.recommendations),
    readString(args.methodology),
  ].filter(Boolean).join('\n');
}

function citationCoverage(args: AgentResearchReportToolArgs, sources: readonly ResearchSource[]): CitationCoverage {
  const sourceIds = sources.map((_, index) => `S${index + 1}`);
  const valid = new Set(sourceIds);
  const cited = new Set<string>();
  const unknown = new Set<string>();
  for (const match of reportBodyText(args).matchAll(/\[S(\d+)\]/gi)) {
    const id = `S${Number(match[1] ?? 0)}`;
    if (valid.has(id)) cited.add(id);
    else unknown.add(id);
  }
  const citedSourceIds = sourceIds.filter((id) => cited.has(id));
  const missingSourceIds = sourceIds.filter((id) => !cited.has(id));
  const unknownCitationIds = Array.from(unknown).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const sourceTitleById = new Map(sourceIds.map((id, index) => [id, sources[index]?.title ?? id]));
  const validRange = sourceIds.length > 1 ? `${sourceIds[0]}-${sourceIds[sourceIds.length - 1]}` : sourceIds[0] ?? '(none)';
  const repairSuggestions = [
    ...missingSourceIds.map((id) => `Add body citation for ${id} (${sourceTitleById.get(id) ?? id}).`),
    ...unknownCitationIds.map((id) => `Replace or remove unknown citation ${id}. Valid source ids are ${validRange}.`),
  ];
  return {
    sourceCount: sourceIds.length,
    citedSourceIds,
    missingSourceIds,
    unknownCitationIds,
    repairSuggestions,
    coverageRatio: sourceIds.length > 0 ? Number((citedSourceIds.length / sourceIds.length).toFixed(3)) : 1,
    pass: missingSourceIds.length === 0 && unknownCitationIds.length === 0,
  };
}

function citationCoverageSection(coverage: CitationCoverage): string {
  return [
    '## Citation Coverage',
    '',
    `- Sources: ${coverage.sourceCount}`,
    `- Cited in body: ${coverage.citedSourceIds.join(', ') || '(none)'}`,
    `- Uncited in body: ${coverage.missingSourceIds.join(', ') || '(none)'}`,
    `- Unknown citations: ${coverage.unknownCitationIds.join(', ') || '(none)'}`,
    `- Repair suggestions: ${coverage.repairSuggestions.join(' ') || '(none)'}`,
    '',
  ].join('\n');
}

function buildMarkdown(args: AgentResearchReportToolArgs, sources: readonly ResearchSource[], includeVisualReport: boolean): string {
  const title = readString(args.title);
  const question = readString(args.question);
  const summary = readString(args.summary);
  const reportMarkdown = readString(args.reportMarkdown);
  const findings = readList(args.findings);
  const gaps = readList(args.gaps);
  const recommendations = readList(args.recommendations);
  const methodology = readString(args.methodology);
  const confidence = readString(args.confidence);
  const coverage = citationCoverage(args, sources);
  const generatedAt = new Date().toISOString();
  const lines = [
    `# ${title}`,
    '',
    `Question: ${question}`,
    `Generated: ${generatedAt}`,
    `Confidence: ${confidence || 'unspecified'}`,
    '',
  ];
  if (summary) lines.push('## Summary', '', summary, '');
  if (reportMarkdown) lines.push('## Report', '', reportMarkdown, '');
  const findingSection = listSection('Findings', findings);
  if (findingSection) lines.push(findingSection);
  const gapSection = listSection('Gaps And Caveats', gaps);
  if (gapSection) lines.push(gapSection);
  const recommendationSection = listSection('Recommendations', recommendations);
  if (recommendationSection) lines.push(recommendationSection);
  if (methodology) lines.push('## Method', '', methodology, '');
  lines.push(citationCoverageSection(coverage));
  if (includeVisualReport) lines.push(visualReportSection(args, sources, coverage));
  lines.push(sourceMapSection(sources));
  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';
}

function sourceMetadata(sources: readonly ResearchSource[]): readonly Record<string, unknown>[] {
  return sources.map((source, index) => ({
    id: `S${index + 1}`,
    title: source.title,
    ...(source.url ? { url: source.url } : {}),
    ...(source.urlOmitted ? { urlOmitted: true } : {}),
    ...(source.publisher ? { publisher: source.publisher } : {}),
    ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
    ...(source.accessedAt ? { accessedAt: source.accessedAt } : {}),
    credibility: source.credibility,
    ...(source.note ? { note: source.note } : {}),
  }));
}

function visualReportMetadata(
  args: AgentResearchReportToolArgs,
  sources: readonly ResearchSource[],
  coverage: CitationCoverage,
): Record<string, unknown> {
  const findingCount = readList(args.findings).length;
  const gapCount = readList(args.gaps).length;
  const recommendationCount = readList(args.recommendations).length;
  return {
    format: 'markdown-visual-report-packet',
    sections: [
      'at-a-glance',
      'evidence-matrix',
      ...(findingCount > 0 ? ['findings-board'] : []),
      'dated-sources-or-comparison',
      'citation-coverage',
      'source-map',
      ...(gapCount > 0 ? ['open-questions'] : []),
      ...(recommendationCount > 0 ? ['next-actions'] : []),
      'handoff-checklist',
    ],
    sourceCount: sources.length,
    findingCount,
    gapCount,
    recommendationCount,
    datedSourceCount: sources.filter((source) => source.publishedAt || source.accessedAt).length,
    citationCoveragePass: coverage.pass,
    missingSourceIds: coverage.missingSourceIds,
    unknownCitationIds: coverage.unknownCitationIds,
    routes: {
      inspect: 'agent_artifacts mode:"show" artifactId:"..." includeContent:true',
      archive: 'agent_artifacts mode:"archive" artifactIds:["..."] destinationPath:"exports/research-report.zip" confirm:true explicitUserRequest:"..."',
      promoteKnowledge: 'agent_knowledge_ingest sourceKind:"artifact" artifactId:"..." confirm:true explicitUserRequest:"..."',
    },
  };
}

function runIdFromArgs(args: AgentResearchReportToolArgs): string {
  return readString(args.runId) || readString(args.id);
}

function reportNextRouteLines(descriptor: ArtifactDescriptor, args: AgentResearchReportToolArgs): readonly string[] {
  const filename = descriptor.filename ?? `${descriptor.id}.md`;
  const title = readString(args.title);
  const runId = runIdFromArgs(args);
  return [
    `  inspect research action:"report_artifact" artifactId:${routeString(descriptor.id)}`,
    `  artifact agent_artifacts mode:"show" artifactId:${routeString(descriptor.id)} includeContent:true`,
    `  export agent_artifacts mode:"export" artifactId:${routeString(descriptor.id)} destinationPath:${routeString(`exports/${filename}`)} confirm:true explicitUserRequest:"..."`,
    `  archive agent_artifacts mode:"archive" artifactIds:[${routeString(descriptor.id)}] destinationPath:"exports/research-report.zip" confirm:true explicitUserRequest:"..."`,
    `  promoteKnowledge agent_knowledge_ingest sourceKind:"artifact" artifactId:${routeString(descriptor.id)} confirm:true explicitUserRequest:"..."`,
    ...(runId ? [
      `  completeRun research action:"complete" id:${routeString(runId)} reportArtifactId:${routeString(descriptor.id)} confirm:true explicitUserRequest:"..."`,
    ] : []),
    `  reports research action:"reports"${title ? ` query:${routeString(title)}` : ''}`,
  ];
}

async function saveResearchReport(
  artifactStore: AgentResearchReportArtifactStore,
  args: AgentResearchReportToolArgs & { readonly sources: readonly ResearchSource[] },
): Promise<ArtifactDescriptor> {
  const title = readString(args.title);
  const question = readString(args.question);
  if (!title) throw new Error('title is required.');
  if (!question) throw new Error('question is required.');
  const sources = args.sources;
  if (sources.length === 0) throw new Error('At least one reviewed source is required for a research report artifact.');
  if (!readString(args.summary) && !readString(args.reportMarkdown) && readList(args.findings).length === 0) {
    throw new Error('summary, reportMarkdown, or findings are required.');
  }
  const explicitUserRequest = readString(args.explicitUserRequest);
  if (!explicitUserRequest) throw new Error('explicitUserRequest is required so report export stays user-directed.');
  if (!readBoolean(args.confirm)) {
    throw new Error([
      preview(args, sources),
      '',
      'Model tool confirmation required. Call this tool with confirm:true only after the user explicitly asked GoodVibes Agent to save this research report.',
    ].join('\n'));
  }
  const coverage = citationCoverage(args, sources);
  if (readBoolean(args.requireCitationCoverage) && !coverage.pass) {
    throw new Error([
      `Citation coverage check failed. Missing body citations: ${coverage.missingSourceIds.join(', ') || '(none)'}. Unknown citations: ${coverage.unknownCitationIds.join(', ') || '(none)'}.`,
      `Repair suggestions: ${coverage.repairSuggestions.join(' ') || '(none)'}`,
    ].join('\n'));
  }
  const includeVisualReport = readBoolean(args.visualReport);
  const markdown = buildMarkdown(args, sources, includeVisualReport);
  if (markdown.length > MAX_REPORT_CHARS) throw new Error(`Research report is too large (${markdown.length} chars). Keep it under ${MAX_REPORT_CHARS}.`);
  return artifactStore.create({
    kind: 'document',
    mimeType: 'text/markdown',
    filename: `${slug(title)}.md`,
    text: markdown,
    metadata: {
      purpose: 'agent-research-report',
      source: 'agent-research-report',
      title,
      question,
      confidence: readString(args.confidence) || 'unspecified',
      tags: readTags(args.tags),
      sourceCount: sources.length,
      sources: sourceMetadata(sources),
      citationCoverage: coverage,
      ...(includeVisualReport ? { visualReport: visualReportMetadata(args, sources, coverage) } : {}),
      explicitUserRequest,
    },
  });
}

function coverageFromMetadata(metadata: ArtifactDescriptor['metadata']): CitationCoverage | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).citationCoverage;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.sourceCount !== 'number') return null;
  return {
    sourceCount: record.sourceCount,
    citedSourceIds: Array.isArray(record.citedSourceIds) ? record.citedSourceIds.filter((entry): entry is string => typeof entry === 'string') : [],
    missingSourceIds: Array.isArray(record.missingSourceIds) ? record.missingSourceIds.filter((entry): entry is string => typeof entry === 'string') : [],
    unknownCitationIds: Array.isArray(record.unknownCitationIds) ? record.unknownCitationIds.filter((entry): entry is string => typeof entry === 'string') : [],
    repairSuggestions: Array.isArray(record.repairSuggestions) ? record.repairSuggestions.filter((entry): entry is string => typeof entry === 'string') : [],
    coverageRatio: typeof record.coverageRatio === 'number' ? record.coverageRatio : 0,
    pass: record.pass === true,
  };
}

export function createAgentResearchReportTool(
  artifactStore?: AgentResearchReportArtifactStore,
): Tool {
  return {
    definition: {
      name: 'agent_research_report',
      description: 'Save one confirmed sourced research report artifact.',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Optional visible research run id to complete after saving the artifact.' },
          id: { type: 'string', description: 'Alias for runId when saving through the high-level research adapter.' },
          title: { type: 'string', description: 'Report title.' },
          question: { type: 'string', description: 'Research question answered by the report.' },
          summary: { type: 'string', description: 'Short executive summary.' },
          reportMarkdown: { type: 'string', description: 'Full report markdown.' },
          sources: {
            type: 'array',
            items: { type: 'object' },
            description: 'Reviewed sources with title, url, and credibility. Credential-redacted, userinfo-bearing or malformed URLs are withheld in full with urlOmitted:true; ordinary query and section references are preserved.',
          },
          findings: {
            type: 'array',
            items: { type: 'string' },
            description: 'Key findings.',
          },
          gaps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Open questions or caveats.',
          },
          recommendations: {
            type: 'array',
            items: { type: 'string' },
            description: 'Recommended next actions.',
          },
          methodology: { type: 'string', description: 'How sources were selected and judged.' },
          confidence: { type: 'string', description: 'Overall confidence label.' },
          requireCitationCoverage: { type: 'boolean', description: 'Fail save unless all sources are cited in body.' },
          visualReport: { type: 'boolean', description: 'Append a visual report packet section.' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional report tags.',
          },
          confirm: { type: 'boolean', description: 'Required true to save the report.' },
          explicitUserRequest: { type: 'string', description: 'User request authorizing report save.' },
        },
        required: ['title', 'question', 'sources', 'confirm', 'explicitUserRequest'],
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: Record<string, unknown>) => {
      if (!artifactStore?.create) return failure('Research report export is unavailable because this runtime did not provide an artifact store.');
      try {
        const args = prepareAgentResearchReportInput(rawArgs as AgentResearchReportToolArgs);
        const descriptor = await saveResearchReport(artifactStore, args);
        const coverage = coverageFromMetadata(descriptor.metadata);
        const lines = [
          'Saved Agent research report artifact',
          `  artifact ${descriptor.id}`,
          `  filename ${descriptor.filename ?? '(none)'}`,
          `  bytes ${descriptor.sizeBytes}`,
          `  mime ${descriptor.mimeType}`,
          `  sources ${args.sources.length}`,
          readBoolean(args.visualReport) ? '  visualReport markdown-visual-report-packet' : '',
          coverage ? `  citationCoverage ${coverage.citedSourceIds.length}/${coverage.sourceCount} cited; uncited ${coverage.missingSourceIds.length}; unknown ${coverage.unknownCitationIds.length}` : '',
          coverage && coverage.repairSuggestions.length > 0 ? `  citationRepair ${coverage.repairSuggestions.join(' ')}` : '',
          `  sha256 ${descriptor.sha256}`,
          '  nextRoutes',
          ...reportNextRouteLines(descriptor, args),
          '  policy sourced markdown saved as artifact; content not printed',
          `  inspect agent_artifacts mode:"show" artifactId:"${descriptor.id}" includeContent:true`,
        ].filter(Boolean);
        return output(lines.join('\n'));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function registerAgentResearchReportTool(
  registry: ToolRegistry,
  artifactStore?: AgentResearchReportArtifactStore,
): void {
  registry.register(createAgentResearchReportTool(artifactStore));
}
