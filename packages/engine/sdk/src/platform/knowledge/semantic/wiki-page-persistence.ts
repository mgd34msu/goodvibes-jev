import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord, KnowledgeNodeUpsertInput, KnowledgeSourceRecord } from '../types.js';
import type { KnowledgeSemanticExtraction, KnowledgeSemanticFactInput } from './types.js';
import { semanticHash, semanticMetadata, semanticSlug } from './utils.js';

export function prepareWikiPageNodeInput(
  source: KnowledgeSourceRecord, semantic: KnowledgeSemanticExtraction, spaceId: string, textHash: string,
): KnowledgeNodeUpsertInput | undefined {
  const markdown = semantic.wikiPage?.markdown ?? renderDeterministicWikiPage(source, semantic.facts);
  if (!markdown.trim()) return undefined;
  return {
    id: `sem-page-${semanticHash(spaceId, source.id)}`,
    kind: 'wiki_page',
    slug: semanticSlug(`${spaceId}-${source.title ?? source.id}-page`),
    title: semantic.wikiPage?.title ?? `${source.title ?? source.id} knowledge page`,
    summary: semantic.summary ?? source.summary,
    aliases: source.title ? [source.title] : [],
    confidence: semantic.extractor === 'llm' ? 80 : 55,
    sourceId: source.id,
    metadata: semanticMetadata(spaceId, {
      semanticKind: 'wiki_page',
      markdown,
      sourceId: source.id,
      extractor: semantic.extractor,
      textHash,
    }),
  };
}

export async function persistWikiPage(
  store: KnowledgeStore, source: KnowledgeSourceRecord, semantic: KnowledgeSemanticExtraction,
  spaceId: string, input: KnowledgeNodeUpsertInput | undefined,
  writePrepared?: (() => Promise<KnowledgeNodeRecord>) | undefined,
): Promise<KnowledgeNodeRecord | undefined> {
  if (!input) return undefined;
  const page = await (writePrepared ? writePrepared() : store.upsertNode(input));
  await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: page.id,
    relation: 'compiled_into_page', weight: semantic.extractor === 'llm' ? 1 : 0.6,
    metadata: semanticMetadata(spaceId, { extractor: semantic.extractor }),
  });
  return page;
}

export function renderDeterministicWikiPage(
  source: KnowledgeSourceRecord,
  facts: readonly KnowledgeSemanticFactInput[],
): string {
  const grouped = new Map<string, KnowledgeSemanticFactInput[]>();
  for (const fact of facts) {
    grouped.set(fact.kind, [...(grouped.get(fact.kind) ?? []), fact]);
  }
  const sections = [...grouped.entries()].flatMap(([kind, entries]) => [
    `## ${titleCase(kind)}`,
    '',
    ...entries.slice(0, 24).map((fact) => `- ${fact.title}${fact.value ? `: ${fact.value}` : ''}${fact.summary ? ` - ${fact.summary}` : ''}`),
    '',
  ]);
  return [
    `# ${source.title ?? source.id}`,
    '',
    source.summary ?? '',
    '',
    ...sections,
  ].filter((line) => line !== undefined).join('\n').trim();
}

function titleCase(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}
