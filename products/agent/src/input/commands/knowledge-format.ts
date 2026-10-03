import type { KnowledgeMapResult, KnowledgeService } from '@goodvibes-jev/engine/sdk/platform/knowledge';

export type KnowledgeAskResult = Awaited<ReturnType<KnowledgeService['ask']>>;

export function cleanInline(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export function formatKnowledgeMap(result: KnowledgeMapResult): string {
  return [
    'Agent Knowledge map',
    `  nodes: ${result.nodeCount}${result.totalNodeCount !== undefined && result.totalNodeCount !== result.nodeCount ? ` of ${result.totalNodeCount}` : ''}`,
    `  edges: ${result.edgeCount}${result.totalEdgeCount !== undefined && result.totalEdgeCount !== result.edgeCount ? ` of ${result.totalEdgeCount}` : ''}`,
    '  route /api/goodvibes-agent/knowledge/map',
  ].join('\n');
}

export function nodeLabel(node: { readonly kind?: string; readonly title?: string; readonly summary?: string; readonly confidence?: number }): string {
  const kind = cleanInline(node.kind) || 'node';
  const title = cleanInline(node.title) || 'untitled';
  const summary = cleanInline(node.summary);
  const confidence = typeof node.confidence === 'number' ? `  confidence ${node.confidence}` : '';
  return summary ? `[${kind}] ${title}${confidence} - ${summary}` : `[${kind}] ${title}${confidence}`;
}

export function sourceLabel(source: {
  readonly id?: string;
  readonly sourceType?: string;
  readonly title?: string;
  readonly canonicalUri?: string;
  readonly sourceUri?: string;
  readonly summary?: string;
  readonly status?: string;
}): string {
  const title = cleanInline(source.title) || cleanInline(source.canonicalUri) || cleanInline(source.sourceUri) || cleanInline(source.id) || 'untitled';
  const type = cleanInline(source.sourceType) || 'source';
  const status = cleanInline(source.status);
  const summary = cleanInline(source.summary);
  const suffix = status ? `/${status}` : '';
  return summary ? `[${type}${suffix}] ${title} - ${summary}` : `[${type}${suffix}] ${title}`;
}

export function renderKnowledgeAskResult(result: KnowledgeAskResult): string {
  const answer = result.answer;
  const lines = [
    `[knowledge] ${result.query}`,
    answer.text,
    '',
    `mode ${answer.mode}  confidence ${answer.confidence}  synthesized ${answer.synthesized ? 'yes' : 'no'}`,
  ];

  if (answer.sources.length > 0) {
    lines.push('', 'Sources:');
    for (const source of answer.sources) lines.push(`  - ${sourceLabel(source)}`);
  }

  if (answer.facts.length > 0) {
    lines.push('', 'Facts:');
    for (const fact of answer.facts) lines.push(`  - ${nodeLabel(fact)}`);
  }

  if (answer.linkedObjects.length > 0) {
    lines.push('', 'Linked objects:');
    for (const object of answer.linkedObjects) lines.push(`  - ${nodeLabel(object)}`);
  }

  if (answer.gaps.length > 0) {
    lines.push('', 'Gaps:');
    for (const gap of answer.gaps) lines.push(`  - ${nodeLabel(gap)}`);
  }

  return lines.join('\n');
}
