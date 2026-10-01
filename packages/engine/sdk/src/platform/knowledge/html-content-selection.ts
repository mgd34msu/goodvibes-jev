import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { type Candidate } from '@goodvibes-jev/judgment';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { pageBlocks, pageUnits } from '../tools/fetch/page-blocks.js';
import { htmlDocumentTitle, htmlMainContent } from './batteries/html-content.js';
import { KnowledgeExtractionJudgmentHoldError, requireExtractionJudgment } from './extraction-policy.js';

const TITLE_GROUP_SIZE = 32;
const TITLE_SAMPLE_CHARS = 512;
const TITLE_CONTEXT_CHARS = 4_096;

interface SelectedHtmlContent {
  readonly textContent: string;
  readonly title?: string | undefined;
  readonly headings: readonly string[];
  readonly paragraphSamples: readonly string[];
}

/** HTML grammar supplies blocks; only recorded judgments decide which are document content. */
export async function selectHtmlContent(html: string, documentTitle: string, metadataTitles: readonly string[] = []): Promise<SelectedHtmlContent | null> {
  assertJudgmentInput(html);
  const units = pageUnits(html);
  const blocks = pageBlocks(units).map((block, index) => ({ number: index + 1, ...block }));
  const titles = [...new Set([documentTitle, ...metadataTitles, ...units.filter((unit) => unit.headingLevel !== undefined).map((unit) => unit.text)].map((text) => text.trim()).filter(Boolean))];
  // Covers decoded content and every candidate before the pattern clips request samples.
  assertJudgmentInput({ documentTitle, blocks, titles });
  if (blocks.length === 0) return null;
  return requireExtractionJudgment(async () => {
    const readings = await htmlMainContent.read(judgmentPort('knowledge.extraction.html-content'), documentTitle.slice(0, TITLE_SAMPLE_CHARS), blocks, { site: 'knowledge.extraction.html-content' });
    for (const block of blocks) {
      const reading = readings.get(block.number);
      if (!reading || reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new KnowledgeExtractionJudgmentHoldError();
    }
    const kept = blocks.filter((block) => readings.get(block.number)?.verdict === 'yes');
    if (kept.length === 0) return null;
    let blockNumber = 0;
    let previousPath: string | undefined;
    const keptUnits = units.filter((unit) => {
      if (unit.path !== previousPath) { blockNumber += 1; previousPath = unit.path; }
      return readings.get(blockNumber)?.verdict === 'yes';
    });
    const textContent = kept.map((block) => block.text).join('\n\n');
    const candidates: Candidate[] = titles.map((text, index) => ({ id: `title-${index + 1}`, content: text.slice(0, TITLE_SAMPLE_CHARS) }));
    const titleId = await chooseTitle(textContent, candidates);
    const titleIndex = candidates.findIndex((candidate) => candidate.id === titleId);
    return {
      textContent,
      ...(titleIndex >= 0 ? { title: titles[titleIndex] } : {}),
      headings: [...new Set(keptUnits.filter((unit) => unit.headingLevel !== undefined).map((unit) => unit.text))].slice(0, 24),
      paragraphSamples: [...new Set(keptUnits.filter((unit) => unit.headingLevel === undefined).map((unit) => unit.text))].slice(0, 12),
    };
  });
}

/** Large candidate lists use the foundation's selection pattern in bounded tournaments. */
async function chooseTitle(content: string, candidates: readonly Candidate[]): Promise<string | undefined> {
  if (candidates.length === 0) return undefined;
  const finalists: Candidate[] = [];
  for (let start = 0; start < candidates.length; start += TITLE_GROUP_SIZE) {
    const group = candidates.slice(start, start + TITLE_GROUP_SIZE);
    const selection = await htmlDocumentTitle.select(judgmentPort('knowledge.extraction.html-title'), { content: content.slice(0, TITLE_CONTEXT_CHARS) }, group, { site: 'knowledge.extraction.html-title' });
    if (selection.outcome !== 'act') {
      selection.recordAction('hold');
      throw new KnowledgeExtractionJudgmentHoldError();
    }
    const chosen = group.find((candidate) => candidate.id === selection.chosen);
    if (selection.chosen !== undefined && !chosen) throw new KnowledgeExtractionJudgmentHoldError();
    selection.recordAction(chosen ? `selected:${chosen.id}` : 'no-document-title');
    if (chosen) finalists.push(chosen);
  }
  if (candidates.length <= TITLE_GROUP_SIZE || finalists.length <= 1) return finalists[0]?.id;
  return chooseTitle(content, finalists);
}
