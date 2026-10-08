import { cleanupResearchScreeningFixtures, researchScreeningFixture, exactSensitiveSpans } from '../helpers/research-screening.ts';
import { afterAll, describe, expect, test } from 'bun:test';
import { buildAgentResearchReportToolArgs, buildAgentResearchReportPromptSubmission as formatPrompt, createAgentResearchReportEditor, submitProtectedAgentResearchReport } from '../../input/agent-workspace-research-report-editor.ts';

// Pure structural/formatting regressions. Protected runtime adoption is exercised
// separately with the actual asynchronous owner and workspace controller.
function buildAgentResearchReportPromptSubmission(editor: ReturnType<typeof createAgentResearchReportEditor>, read: (id: string) => string, available: boolean) {
  try { return formatPrompt(editor, read, available, buildAgentResearchReportToolArgs(read, 'Save a reviewed source-grounded research report as an Agent artifact.')); }
  catch { return formatPrompt(editor, read, available); }
}

afterAll(cleanupResearchScreeningFixtures);
const fields = { title: 'Report', question: 'What is supported?', summary: 'Evidence [S1].', confirm: 'yes' };
const reader = (sources: string) => (id: string): string => ({ ...fields, sources } as Record<string, string>)[id] ?? '';

describe('research report editor source containment', () => {
  test('contains embedded non-HTTP URI userinfo before editor arguments and prompt dispatch', () => {
    const uri = 'ftp://sentinel@archive.example.test/paper?edition=2#part';
    const read = reader(`Read ${uri} carefully | https://example.test/article?id=123#section-2 | high | Before ${uri} after.`);
    const args = buildAgentResearchReportToolArgs(read, 'Save the report.');
    const result = buildAgentResearchReportPromptSubmission(createAgentResearchReportEditor(), read, true);
    expect(result.kind).toBe('prompt');
    expect(JSON.stringify([args, result])).not.toContain('sentinel');
    expect(args.sources[0]).toMatchObject({
      title: 'Read [source URL withheld] carefully',
      url: 'https://example.test/article?id=123#section-2',
      credibility: 'high', note: 'Before [source URL withheld] after.', urlOmitted: true,
    });
  });

  test('contains declared malformed userinfo aliases before prompt dispatch', () => {
    const uri = 'ftp://sentinel\\\t@archive.example.test/doc';
    const alias = uri.replace('ftp:', 'FTP:').replace('archive.example.test', 'ARCHIVE.EXAMPLE.TEST');
    const read = reader(`Source | ${uri} | high | Before ${alias} after.`);
    const args = buildAgentResearchReportToolArgs(read, 'Save the report.');
    const result = buildAgentResearchReportPromptSubmission(createAgentResearchReportEditor(), read, true);
    expect(result.kind).toBe('prompt');
    expect(JSON.stringify([args, result])).not.toContain('sentinel');
    expect(args.sources[0]).toMatchObject({ title: 'Source', note: 'Before [source URL withheld] after.', urlOmitted: true });
  });

  for (const url of [
    'https://example.test/document?token=sentinel',
    'https://example.test/document?auth_token=sentinel',
    'https://sentinel@example.test/document',
    'https://[invalid?token=sentinel',
    'https:invalid?token=sentinel',
    'https://[invalid ?token=sentinel',
  ]) {
    test(`contains raw fallback and explicit URL aliases: ${url}`, () => {
      for (const sources of [url, `${url} | high`, `${url} | ${url} | high | ${url}`]) {
        const args = buildAgentResearchReportToolArgs(reader(sources), 'Save the report.');
        expect(JSON.stringify(args)).not.toContain('sentinel');
        expect(args.sources[0]).toMatchObject({ urlOmitted: true });
        const result = buildAgentResearchReportPromptSubmission(createAgentResearchReportEditor(), reader(sources), true);
        expect(result.kind).toBe('prompt');
        expect(JSON.stringify(result)).not.toContain('sentinel');
        if (result.kind === 'prompt') expect(result.prompt).toContain('"urlOmitted":true');
      }
    });
  }

  for (const url of ['https://example.test/document?access_token=sentinel', 'https://example.test/document?api_key=sentinel', 'https://sentinel:password@example.test/document', 'ftp://user:sentinel@example.test/document']) {
    test(`refuses declared credential syntax before prompt projection: ${url}`, () => {
      for (const sources of [url, `${url} | high`, `${url} | ${url} | high | ${url}`]) {
        expect(() => buildAgentResearchReportToolArgs(reader(sources), 'Save the report.')).toThrow('Refused before judgment');
        const result = buildAgentResearchReportPromptSubmission(createAgentResearchReportEditor(), reader(sources), true);
        expect(result.kind).toBe('editor');
        expect(result.actionResult?.kind).toBe('error');
        expect(JSON.stringify(result)).not.toContain('sentinel');
      }
    });
  }

  test('retains safe URL-only fallback, named source and full long notes', () => {
    const note = 'Evidence about password managers. '.repeat(200);
    const args = buildAgentResearchReportToolArgs(reader(`https://example.test/docs | high | ${note}\nOfficial docs | https://example.test/guide | medium | A source.`), 'Save the report.');
    expect(args.sources).toEqual([
      { title: 'https://example.test/docs', url: 'https://example.test/docs', credibility: 'high', note: note.trim() },
      { title: 'Official docs', url: 'https://example.test/guide', credibility: 'medium', note: 'A source.' },
    ]);
  });

  test('withholds malformed authority and path syntax rather than repairing it in a prompt', () => {
    for (const url of ['https://example.test\\document', 'https:///example.test/document', 'https://example.test/doc\tument']) {
      const result = buildAgentResearchReportPromptSubmission(createAgentResearchReportEditor(), reader(url), true);
      expect(result.kind).toBe('prompt');
      if (result.kind === 'prompt') {
        expect(result.prompt).toContain('"urlOmitted":true');
        expect(result.prompt).not.toContain('https://example.test/document');
      }
    }
  });

  test('contains complete malformed source aliases in actual tool args and model prompts', () => {
    for (const control of ['\t', '\r']) {
      const url = `https://example.test/doc${control}ument?token=sentinel`;
      const read = reader(`Read ${url} carefully | ${url} | high | Before ${url} after`);
      const args = buildAgentResearchReportToolArgs(read, 'Save the report.');
      expect(JSON.stringify(args)).not.toContain('sentinel');
      expect(args.sources[0]).toMatchObject({ title: 'Read [source URL withheld] carefully', note: 'Before [source URL withheld] after', urlOmitted: true });
      const result = buildAgentResearchReportPromptSubmission(createAgentResearchReportEditor(), read, true);
      expect(result.kind).toBe('prompt');
      expect(JSON.stringify(result)).not.toContain('sentinel');
    }
  });

  test('contains declared scheme-case aliases before prompt dispatch', () => {
    const url = 'https://example.test/doc\tument?token=sentinel';
    for (const sources of [`Source | ${url} | high | See ${url.replace('https:', 'HTTPS:')}`]) {
      const read = reader(sources);
      const args = buildAgentResearchReportToolArgs(read, 'Save the report.');
      expect(JSON.stringify(args)).not.toContain('sentinel');
      const result = buildAgentResearchReportPromptSubmission(createAgentResearchReportEditor(), read, true);
      expect(result.kind).toBe('prompt');
      expect(JSON.stringify(result)).not.toContain('sentinel');
    }
  });

  test('contains declared host-case aliases in editor args and prompts', () => {
    const url = 'https://example.test/doc\tument?token=sentinel';
    const alias = url.replace('example.test', 'EXAMPLE.TEST');
    const read = reader(`Source | ${url} | high | See ${alias}`);
    const args = buildAgentResearchReportToolArgs(read, 'Save the report.');
    expect(JSON.stringify(args)).not.toContain('sentinel');
    expect(args.sources[0]?.note).toBe('See [source URL withheld]');
    const result = buildAgentResearchReportPromptSubmission(createAgentResearchReportEditor(), read, true);
    expect(result.kind).toBe('prompt');
    expect(JSON.stringify(result)).not.toContain('sentinel');
  });

  test('contains unbound control-split prompt prose through the protected source-span boundary', async () => {
    const reference = 'https://example.test/doc\tument?token=sentinel';
    const sources = `See ${reference}`;
    const fixture = researchScreeningFixture({ spans: exactSensitiveSpans([reference]) });
    let result: ReturnType<typeof formatPrompt> | undefined;
    await submitProtectedAgentResearchReport(createAgentResearchReportEditor(), { ...fields, sources }, true, fixture.owner, {}, value => { result = value; });
    expect(result?.kind).toBe('prompt');
    expect(JSON.stringify(result)).not.toContain('sentinel');
  });

  test('keeps LF record framing and contains omitted URL aliases across records', () => {
    const omitted = 'https://example.test/doc\tument?token=sentinel';
    const safe = 'https://example.test/article?id=123#section-2';
    const read = reader(`First source | ${omitted} | high | See ${omitted}\nSecond source | ${safe} | medium | Compare ${omitted} with this source.`);
    const args = buildAgentResearchReportToolArgs(read, 'Save the report.');
    expect(args.sources).toHaveLength(2);
    expect(args.sources[0]).toMatchObject({ title: 'First source', urlOmitted: true, note: 'See [source URL withheld]' });
    expect(args.sources[1]).toMatchObject({ title: 'Second source', url: safe, note: 'Compare [source URL withheld] with this source.' });
    const result = buildAgentResearchReportPromptSubmission(createAgentResearchReportEditor(), read, true);
    expect(result.kind).toBe('prompt');
    expect(JSON.stringify(result)).not.toContain('sentinel');
    expect(JSON.stringify(result)).toContain(safe);
    const safeList = buildAgentResearchReportToolArgs(reader(`First | ${safe}\nSecond | https://example.test/other#anchor`), 'Save the report.');
    expect(safeList.sources).toHaveLength(2);
    expect(safeList.sources[0]?.url).toBe(safe);
    expect(safeList.sources[1]?.url).toBe('https://example.test/other#anchor');
  });

  test('retains ordinary URL canonical equivalence and explicitly encoded path characters', () => {
    const args = buildAgentResearchReportToolArgs(reader('HTTPS://EXAMPLE.TEST:443/document?id=123#section-2\nhttps://example.test/doc%5Cument'), 'Save the report.');
    expect(args.sources[0]?.url).toBe('https://example.test/document?id=123#section-2');
    expect(args.sources[1]?.url).toBe('https://example.test/doc%5Cument');
    expect(args.sources.every((source) => !source.urlOmitted)).toBe(true);
  });

  test('preserves query-dependent citations and section anchors without claiming omission', () => {
    for (const url of ['https://example.test/article?id=123', 'https://example.test/search?q=ordinary', 'https://example.test/guide#section-2']) {
      const read = reader(`Named source | ${url} | high`);
      const args = buildAgentResearchReportToolArgs(read, 'Save the report.');
      expect(args.sources[0]).toEqual({ title: 'Named source', url, credibility: 'high' });
      const fallback = buildAgentResearchReportToolArgs(reader(url), 'Save the report.');
      expect(fallback.sources[0]).toEqual({ title: url, url, credibility: 'unreviewed' });
      const result = buildAgentResearchReportPromptSubmission(createAgentResearchReportEditor(), read, true);
      expect(result.kind).toBe('prompt');
      if (result.kind === 'prompt') expect(result.prompt).toContain(url);
    }
  });

  test('validates complete declared URL cells independently of prose matching', () => {
    const args = buildAgentResearchReportToolArgs(reader('Source | https://example.test/article?q=ordinary words#section | high'), 'Save the report.');
    expect(args.sources[0]?.url).toBe('https://example.test/article?q=ordinary%20words#section');
    expect(args.sources[0]?.urlOmitted).toBeUndefined();
  });

  test('reads each source field once even when subsequent reads change', () => {
    let calls = 0;
    const read = (id: string) => id === 'sources'
      ? (++calls === 1 ? 'https://example.test/document' : 'https://example.test/?token=sentinel')
      : reader('')(id);
    const result = buildAgentResearchReportPromptSubmission(createAgentResearchReportEditor(), read, true);
    expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain('sentinel');
  });

  test('refuses protected non-URL source text before any model prompt is returned', () => {
    const result = buildAgentResearchReportPromptSubmission(createAgentResearchReportEditor(),
      reader(`Document | https://example.test/document | high | ${'ordinary '.repeat(600)}authorization: Bearer sentinel`), true);
    expect(result.kind).toBe('editor');
    expect(result.actionResult?.kind).toBe('error');
    expect(JSON.stringify(result)).not.toContain('sentinel');
  });
});
