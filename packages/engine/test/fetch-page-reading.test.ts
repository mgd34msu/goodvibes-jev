/**
 * fetch-page-reading.test.ts, the fetch tool's Jev readings: which blocks of a
 * page are main content (`readable`), which paragraph says what a page is
 * about (`summary`), and which caller headers follow a redirect to another
 * origin. The page carving, the protocol's own credential headers and the
 * tool's own auth headers are code and pinned exactly; what the readings
 * decide is pinned through a fake port.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { pageBlocks, pageTitle, pageUnits } from '../sdk/src/platform/tools/fetch/page-blocks.ts';
import { NO_SUMMARY_NOTE } from '../sdk/src/platform/tools/fetch/page-reading.ts';
import { applyExtract } from '../sdk/src/platform/tools/fetch/extract.ts';
import { headersForOtherOrigin } from '../sdk/src/platform/tools/fetch/redirect-headers.ts';
import { executeFetchInput } from '../sdk/src/platform/tools/fetch/index.ts';

const PAGE = `<!doctype html><html><head><title>Lemon Pasta &amp; More</title><style>p{}</style></head>
<body>
  <header id="site"><nav class="top menu"><a href="/">Home</a> <a href="/r">Recipes</a></nav></header>
  <main><article>
    <header><h1>Weeknight Lemon Pasta</h1><p>By Dana, March 3</p></header>
    <p>This pasta comes together in twenty minutes &hellip; bright and easy.</p>
    <script>track()</script>
    <ul><li>8 oz spaghetti</li><li>1 lemon</li></ul>
    <h2>Method</h2>
    <p>Boil the spaghetti&#44; then toss with lemon.</p>
  </article></main>
  <aside class="sidebar"><p>Popular: Banana Bread</p></aside>
  <!-- <p>hidden comment</p> -->
  <footer><p>&copy; 2025 Dana Cooks</p></footer>
</body></html>`;

/** Block or header text that reads as not main content, and text that reads as neither. */
const NOT_MAIN = ['Home Recipes', 'Popular: Banana Bread'];
const UNSURE = ['2025 Dana Cooks'];
/** The paragraph that reads as saying what a page is about. */
let summaryMarker = 'comes together in twenty minutes';
/** Header names that read as carrying a credential, and one that reads as neither. */
const CREDENTIAL_HEADERS = ['x-auth-token'];
const UNSURE_HEADERS = ['x-maybe'];

function blockTexts(page: string): Map<number, string> {
  const texts = new Map<number, string>();
  for (const match of page.matchAll(/#(\d+) \[[^\]]*\]\n([\s\S]*?)(?=\n\n#\d+ \[|$)/g)) texts.set(Number(match[1]), match[2]!);
  return texts;
}

type Candidates = { readonly candidates: readonly { readonly id: string; readonly content: string }[] };

function answer(name: string, question: Question, state: EntryType): unknown {
  if (name === 'credential') {
    const header = String((state as { header: string }).header).toLowerCase();
    return noulAnswer(CREDENTIAL_HEADERS.includes(header) ? 0.97 : UNSURE_HEADERS.includes(header) ? 0.5 : 0.03);
  }
  if (name.startsWith('main_')) {
    const text = blockTexts((state as { page: string }).page).get(Number(name.slice('main_'.length))) ?? '';
    return noulAnswer(NOT_MAIN.some((part) => text.includes(part)) ? 0.03 : UNSURE.some((part) => text.includes(part)) ? 0.5 : 0.97);
  }
  const { candidates } = state as unknown as Candidates;
  const summary = candidates.find((candidate) => candidate.content.includes(summaryMarker))?.id;
  if (name === 'pick') return choiceAnswer(question, summary ?? 'none', 0.95);
  if (name.startsWith('fits_')) return noulAnswer(candidates[Number(name.slice('fits_'.length))]?.id === summary ? 0.97 : 0.03);
  throw new Error(`fetch-page-reading: no answer for ${name}`);
}

let requests: ReturnType<typeof fakePort>['requests'] = [];
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  summaryMarker = 'comes together in twenty minutes';
  const fake = fakePort(answer);
  requests = fake.requests;
  previous = installJudgmentPort(fake.port);
});
afterEach(() => installJudgmentPort(previous));

describe('the page carving (HTML grammar, code)', () => {
  test('head, comments, scripts and styles are not rendered text; regions keep their path', () => {
    const units = pageUnits(PAGE);
    const texts = units.map((unit) => unit.text);
    expect(texts.join(' ')).not.toContain('track()');
    expect(texts.join(' ')).not.toContain('hidden comment');
    expect(texts.join(' ')).not.toContain('p{}');
    expect(units[0]).toEqual({ text: 'Home Recipes', path: 'header#site > nav.top.menu' });
    expect(units.find((unit) => unit.text === 'Weeknight Lemon Pasta')).toEqual({ text: 'Weeknight Lemon Pasta', path: 'main > article > header', headingLevel: 1 });
    expect(units.find((unit) => unit.text === 'Method')?.headingLevel).toBe(2);
    expect(texts).toContain('Boil the spaghetti, then toss with lemon.');
    expect(texts).toContain('© 2025 Dana Cooks');
    expect(pageTitle(PAGE)).toBe('Lemon Pasta & More');
  });

  test('consecutive units in one region form one block', () => {
    const blocks = pageBlocks(pageUnits(PAGE));
    expect(blocks.find((block) => block.path === 'main > article > ul')?.text).toBe('8 oz spaghetti\n1 lemon');
    expect(blocks.find((block) => block.path === 'main > article > header')?.text).toBe('Weeknight Lemon Pasta\nBy Dana, March 3');
  });
});

describe('readable: blocks read as not main content are dropped', () => {
  test('a no that acts drops the block; a yes or an unsure reading keeps it; the article header stays', async () => {
    const readable = await applyExtract(PAGE, 'text/html', 'readable');
    expect(readable).toContain('Weeknight Lemon Pasta');
    expect(readable).toContain('This pasta comes together');
    expect(readable).toContain('8 oz spaghetti');
    expect(readable).not.toContain('Home Recipes');
    expect(readable).not.toContain('Banana Bread');
    expect(readable).toContain('© 2025 Dana Cooks');
  });

  test('every block of the page is asked about in one request, with the page title', async () => {
    await applyExtract(PAGE, 'text/html', 'readable');
    expect(requests).toHaveLength(1);
    expect((requests[0]!.state as { title: string }).title).toBe('Lemon Pasta & More');
    expect(Object.keys(requests[0]!.questions)).toHaveLength(pageBlocks(pageUnits(PAGE)).length);
  });

  test('a body that is not HTML is returned as it is, unread', async () => {
    expect(await applyExtract('plain words', 'text/plain', 'readable')).toBe('plain words');
    expect(requests).toHaveLength(0);
  });
});

describe('summary: the paragraph read as saying what the page is about', () => {
  test('HTML: the picked paragraph, then the headings as an outline', async () => {
    const summary = await applyExtract(PAGE, 'text/html', 'summary');
    expect(summary).toBe('This pasta comes together in twenty minutes … bright and easy.\n\nHeadings:\n# Weeknight Lemon Pasta\n## Method');
    const offered = (requests[0]!.state as unknown as Candidates).candidates.map((candidate) => candidate.content);
    expect(offered).not.toContain('Weeknight Lemon Pasta');
    expect(offered[0]).toBe('Home Recipes');
  });

  test('plain text: paragraphs are split on blank lines and the pick is returned', async () => {
    summaryMarker = 'streaming CSV parser';
    const summary = await applyExtract('fastcsv\n\nfastcsv is a streaming CSV parser.\n\nMIT License', 'text/plain', 'summary');
    expect(summary).toBe('fastcsv is a streaming CSV parser.');
  });

  test('no paragraph read as the summary is stated, not replaced by the first one', async () => {
    summaryMarker = 'nothing on this page';
    const summary = await applyExtract('Skip to content\n\nAccept cookies', 'text/plain', 'summary');
    expect(summary).toBe(NO_SUMMARY_NOTE);
  });

  test('a page with more paragraphs than one request offers is read in groups, then the picks compete', async () => {
    summaryMarker = 'says what this is';
    const body = Array.from({ length: 90 }, (_, index) => (index === 12 || index === 57 ? `paragraph ${index} says what this is` : `filler ${index}`)).join('\n\n');
    expect(await applyExtract(body, 'text/plain', 'summary')).toBe('paragraph 12 says what this is');
    // Three groups of at most forty, then one final between the two groups' picks.
    expect(requests.map((request) => (request.state as unknown as Candidates).candidates.length)).toEqual([40, 40, 10, 2]);
  });
});

describe('headers at a redirect to another origin', () => {
  test('the protocol\'s credential headers and the tool\'s own are dropped without a reading', async () => {
    const kept = await headersForOtherOrigin(
      { Authorization: 'Bearer a', cookie: 'sid=1', 'Proxy-Authorization': 'Basic b', 'X-Service-Key': 'k' },
      new Set(['x-service-key']),
    );
    expect(kept).toEqual({});
    expect(requests).toHaveLength(0);
  });

  test('a caller header follows only when its name reads as not a credential with a no that acts', async () => {
    const kept = await headersForOtherOrigin({ 'X-Auth-Token': 't', 'X-Maybe': 'm', 'X-Trace-Id': 'abc' }, new Set());
    expect(kept).toEqual({ 'X-Trace-Id': 'abc' });
    expect(requests.map((request) => request.state)).toEqual([{ header: 'X-Auth-Token' }, { header: 'X-Maybe' }, { header: 'X-Trace-Id' }]);
  });
});

describe('the fetch tool end to end', () => {
  const servers: Array<{ stop: (force?: boolean) => void }> = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
  });
  const echo = () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => Response.json(Object.fromEntries(req.headers.entries())) });
    servers.push(server);
    return `http://127.0.0.1:${server.port}/`;
  };
  const deps = { isLocalhostAllowed: () => true };

  test('a cross-origin redirect drops the auth header and a credential-named caller header, and keeps the rest', async () => {
    const target = echo();
    const redirect = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status: 302, headers: { location: target } }) });
    servers.push(redirect);
    const output = await executeFetchInput({
      urls: [{
        url: `http://127.0.0.1:${redirect.port}/start`,
        headers: { 'X-Auth-Token': 'secret-token', 'X-Trace-Id': 'trace-1' },
        auth: { type: 'bearer', token: 'bearer-token' },
      }],
    }, deps);
    const received = JSON.parse(output.results?.[0]?.content ?? '{}') as Record<string, string>;
    expect(received['x-trace-id']).toBe('trace-1');
    expect(received['x-auth-token']).toBeUndefined();
    expect(received['authorization']).toBeUndefined();
  });

  test('Accept asks for JSON only when the caller asked for JSON, and a caller\'s own Accept wins', async () => {
    const url = echo();
    const asJson = await executeFetchInput({ urls: [{ url, extract: 'json' }] }, deps);
    expect((JSON.parse(asJson.results?.[0]?.content ?? '{}') as Record<string, string>)['accept']).toBe('application/json');
    const raw = await executeFetchInput({ urls: [{ url: `${url}api/v1/graphql` }] }, deps);
    expect((JSON.parse(raw.results?.[0]?.content ?? '{}') as Record<string, string>)['accept']).not.toBe('application/json');
    const own = await executeFetchInput({ urls: [{ url, extract: 'json', headers: { Accept: 'text/csv' } }] }, deps);
    expect((JSON.parse(own.results?.[0]?.content ?? '{}') as Record<string, string>)['accept']).toBe('text/csv');
  });
});
