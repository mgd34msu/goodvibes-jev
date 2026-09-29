/**
 * page-reading.ts, the fetch tool's `readable` and `summary` modes: Jev reads
 * which parts of a page are its main content (`engine.tools.page-content`)
 * and which paragraph says what it is about (`engine.tools.page-summary`).
 * Carving the page into blocks and paragraphs is the HTML grammar
 * (page-blocks.ts); listing its headings is too. A failed reading throws, and
 * the fetch reports it as that URL's error.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { mapLimit, type Candidate } from '@goodvibes-jev/judgment';
import { pageContent } from '../batteries/page-content.js';
import { pageSummary, paragraphCandidate } from '../batteries/page-summary.js';
import { pageBlocks, pageTitle, pageUnits } from './page-blocks.js';

const READABLE_SITE = 'tools.fetch.readable';
const SUMMARY_SITE = 'tools.fetch.summary';

/**
 * Paragraphs one summary request offers. A page with more is read in groups
 * and the groups' picks compete in a final request; the size keeps each
 * request well inside the port's request limits.
 */
const SUMMARY_CANDIDATES_PER_REQUEST = 40;
const SUMMARY_REQUEST_CONCURRENCY = 4;

/** Stated when Jev reads no paragraph as saying what the page is about. */
export const NO_SUMMARY_NOTE = 'No paragraph on this page reads as saying what the page is about.';

/** The page's main content: every block except those read, with a no that acts, as not main content. */
export async function readReadable(html: string): Promise<string> {
  const blocks = pageBlocks(pageUnits(html)).map((block, index) => ({ number: index + 1, ...block }));
  const port = judgmentPort(READABLE_SITE);
  const readings = await pageContent.read(port, pageTitle(html), blocks, { site: READABLE_SITE });
  const kept = blocks.filter((block) => {
    const reading = readings.get(block.number);
    return !(reading?.verdict === 'no' && reading.outcome === 'act');
  });
  return kept.map((block) => block.text).join('\n\n');
}

/** The id of the paragraph that best says what the page is about, when the reading acts on one. */
async function pickSummary(title: string, candidates: readonly Candidate[]): Promise<string | undefined> {
  const port = judgmentPort(SUMMARY_SITE);
  const select = async (group: readonly Candidate[]): Promise<string | undefined> => {
    const selection = await pageSummary.select(port, { title }, group, { site: SUMMARY_SITE });
    const picked = selection.outcome === 'act' ? selection.chosen : undefined;
    selection.recordAction(picked === undefined ? 'no summary paragraph' : `summarized by ${picked}`);
    return picked;
  };
  if (candidates.length <= SUMMARY_CANDIDATES_PER_REQUEST) return candidates.length > 0 ? select(candidates) : undefined;
  const groups: Candidate[][] = [];
  for (let start = 0; start < candidates.length; start += SUMMARY_CANDIDATES_PER_REQUEST) {
    groups.push(candidates.slice(start, start + SUMMARY_CANDIDATES_PER_REQUEST));
  }
  const picks = new Set((await mapLimit(groups, SUMMARY_REQUEST_CONCURRENCY, select)).filter((id): id is string => id !== undefined));
  const finalists = candidates.filter((candidate) => picks.has(candidate.id));
  return finalists.length > 1 ? pickSummary(title, finalists) : finalists[0]?.id;
}

/**
 * The page's summary: the paragraph Jev reads as saying what the page is
 * about, then (for HTML) the page's headings as an outline.
 */
export async function readSummary(body: string, isHtml: boolean): Promise<string> {
  const units = isHtml ? pageUnits(body) : body.split(/\n{2,}/).map((text) => ({ text: text.trim(), headingLevel: undefined })).filter((unit) => unit.text);
  const paragraphs = units.filter((unit) => unit.headingLevel === undefined).map((unit) => unit.text);
  const candidates = paragraphs.map((text, index) => paragraphCandidate(`p${index + 1}`, text));
  const picked = await pickSummary(isHtml ? pageTitle(body) : '', candidates);
  const summary = picked === undefined ? undefined : paragraphs[Number(picked.slice(1)) - 1];
  const headings = units.filter((unit) => unit.headingLevel !== undefined).map((unit) => `${'#'.repeat(unit.headingLevel!)} ${unit.text}`);
  const parts = [summary ?? NO_SUMMARY_NOTE];
  if (headings.length > 0) parts.push(`Headings:\n${headings.join('\n')}`);
  return parts.join('\n\n');
}
