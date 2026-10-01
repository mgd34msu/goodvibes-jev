import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { extractKnowledgeArtifact } from '../sdk/src/platform/knowledge/extractors.js';
import { extractLightweightReadableHtml, extractReadableHtml } from '../sdk/src/platform/knowledge/html-readability.js';
import { hasUsefulKnowledgeExtractionText, KnowledgeExtractionJudgmentHoldError } from '../sdk/src/platform/knowledge/extraction-policy.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { registry } from '../sdk/src/platform/knowledge/extraction/judgment-registry.js';

let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function port(options: { readonly rejectedBlocks?: readonly string[]; readonly mainProbability?: number; readonly title?: string; readonly titleConfidence?: number; readonly fitProbability?: number } = {}) {
  const fake = fakePort((name, question) => {
    if (question.type === 'choice') return choiceAnswer(question, options.title ?? 'title-1', options.titleConfidence ?? 0.99);
    if (name.startsWith('fits_')) return noulAnswer(options.fitProbability ?? 0.99);
    return noulAnswer(options.rejectedBlocks?.includes(name) ? 0.01 : options.mainProbability ?? 0.99);
  });
  installJudgmentPort(fake.port);
  return fake;
}

const HTML = '<html><head><title>Site shell</title><meta name="author" content="A Writer"></head><body>'
  + '<nav><h1>Sections</h1>Home Pricing Login</nav><article><h1>Actual Guide</h1><p>Connect local control to the device.</p>'
  + '<table><tr><td>電圧</td><td>100 V</td></tr></table></article><footer>Subscribe to our newsletter</footer></body></html>';
const artifact = { id: 'synthetic-html', mimeType: 'text/html', filename: 'page.html' };

describe('judged HTML extraction', () => {
  test('registers the main-content and title decisions', () => {
    expect(registry.list().map((decision) => decision.name)).toContain('engine.knowledge.html-main-content');
    expect(registry.list().map((decision) => decision.name)).toContain('engine.knowledge.html-document-title');
  });

  for (const [name, extract] of [['DOM', extractReadableHtml], ['lightweight', extractLightweightReadableHtml]] as const) {
    test(`${name} parsing selects main content and the later document title, including non-ASCII table cells`, async () => {
      const fake = port({ rejectedBlocks: ['main_1', 'main_4'], title: 'title-3' });
      const result = await extract(HTML);
      expect(result?.title).toBe('Actual Guide');
      expect(result?.textContent).toContain('Connect local control');
      expect(result?.textContent).toContain('電圧');
      expect(result?.textContent).toContain('100 V');
      expect(result?.textContent).not.toContain('Home Pricing');
      expect(result?.textContent).not.toContain('Subscribe');
      expect(result?.headings).toEqual(['Actual Guide']);
      expect(fake.requests[0]?.context?.battery).toBe('engine.knowledge.html-main-content');
      expect(fake.requests[1]?.context?.battery).toBe('engine.knowledge.html-document-title');
    });
  }

  test('a confident no-content reading never falls back to the whole page', async () => {
    const fake = port({ mainProbability: 0.01 });
    const result = await extractKnowledgeArtifact(artifact, Buffer.from(HTML));
    expect(result.summary).toBe('HTML extraction found no main content.');
    expect(result.excerpt).toBeUndefined();
    expect(result.structure.searchText).toBeUndefined();
    expect(result.sections).toEqual([]);
    expect(fake.requests).toHaveLength(1);
    installJudgmentPort(undefined);
    expect(await hasUsefulKnowledgeExtractionText(result.summary)).toBe(false);
  });

  test('no title is an explicit result, never the first heading fallback', async () => {
    port({ rejectedBlocks: ['main_1', 'main_4'], title: 'none' });
    const result = await extractReadableHtml(HTML);
    expect(result?.title).toBeUndefined();
    expect(result?.textContent).toContain('Actual Guide');
  });

  test('uncertain content, title confidence and title fitness hold instead of switching parsers', async () => {
    for (const options of [{ mainProbability: 0.5 }, { titleConfidence: 0.5 }, { fitProbability: 0.5 }]) {
      const fake = port(options);
      await expect(extractKnowledgeArtifact(artifact, Buffer.from(HTML))).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
      expect(fake.requests).toHaveLength(options.mainProbability === 0.5 ? 1 : 2);
    }
  });

  test('missing and unavailable ports hold through artifact dispatch', async () => {
    await expect(extractKnowledgeArtifact(artifact, Buffer.from(HTML))).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
    const fake = fakePort(() => { throw new Error('Synthetic unavailable port'); });
    installJudgmentPort(fake.port);
    await expect(extractKnowledgeArtifact(artifact, Buffer.from(HTML))).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
    expect(fake.requests).toHaveLength(1);
  });

  test('preflights complete HTML and decoded text before any capped block request', async () => {
    const fake = port();
    for (const html of [
      `<p>${'Ordinary prose. '.repeat(500)}password=synthetic-fixture</p>`,
      '<p>&#112;assword=synthetic-fixture</p>',
      '<p>4111 1111 1111 1111</p>',
    ]) {
      await expect(extractKnowledgeArtifact(artifact, Buffer.from(html))).rejects.toBeInstanceOf(JudgmentInputError);
    }
    expect(fake.requests).toHaveLength(0);
  });

  test('empty markup is structural and asks nothing', async () => {
    const fake = port();
    const result = await extractKnowledgeArtifact(artifact, Buffer.from('<html><body><script>void 0</script></body></html>'));
    expect(result.structure.searchText).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
  });

  test('title selection can choose beyond the first request without positional defaults', async () => {
    const fake = fakePort((_name, question, state) => {
      if (question.type !== 'choice') return noulAnswer(0.99);
      const candidates = (state as { candidates: Array<{ id: string }> }).candidates;
      return choiceAnswer(question, candidates.some((candidate) => candidate.id === 'title-71') ? 'title-71' : 'none', 0.99);
    });
    installJudgmentPort(fake.port);
    const html = '<title>Site</title><body>' + Array.from({ length: 70 }, (_, index) => `<h2>Heading ${index + 1}</h2>`).join('') + '<p>Body content</p></body>';
    expect((await extractReadableHtml(html))?.title).toBe('Heading 70');
    for (const request of fake.requests.filter((entry) => entry.context?.battery === 'engine.knowledge.html-document-title')) {
      expect((request.state as { candidates: unknown[] }).candidates.length).toBeLessThanOrEqual(32);
    }
  });
});
