/**
 * `engine.tools.page-content`: which blocks of a fetched web page are part of
 * its main content? Read by Jev in place of the fetch tool's `readable` mode
 * deleting every `nav`, `aside`, `header` and `footer` element: that removed
 * an article's own header (its title and byline) and kept every sidebar,
 * cookie banner and pager built from `div`s.
 *
 * One yes/no per block, all about the same numbered page, so the questions
 * for one page share a request (the parallel questions cookbook). A page too
 * long for one request is split into consecutive runs of blocks, as few as
 * the documented request limits allow (LIMITS in the judgment port); the
 * packing is token counting, code. Carving the page into blocks is the HTML
 * grammar (fetch/page-blocks.ts), also code.
 *
 * The question set grows with the page, so this is a named decision of its
 * own rather than a fixed-question battery; its one question, band and
 * fixtures live here.
 *
 * Band: medium stakes. A wrong no drops part of what the caller fetched the
 * page for; a wrong yes leaves some boilerplate in. Code drops a block only on
 * a no that acts.
 */
import {
  askAs,
  checkEachFixture,
  checkReading,
  decisionHeader,
  estimateTokens,
  LIMITS,
  mapLimit,
  noul,
  readYesNo,
  recordReadings,
  STAKES_BANDS,
  type CallOptions,
  type JudgmentPort,
  type NamedDecision,
  type NoulResponse,
  type Question,
  type YesNoReading,
} from '@goodvibes-jev/judgment';

export const PAGE_CONTENT_BAND = STAKES_BANDS.medium.yesNo;

const CONTENT_INSTRUCTIONS =
  '`page` is a web page titled `title`, carved into numbered blocks; each block shows the elements it sits in (tag, id and classes) and then its text. Is block `block` part of the page\'s main content: what a reader came to this page for?';
const CONTENT_CRITERIA = {
  true: 'The block is the page\'s own subject matter: its title and byline, its body text, lists, code, tables or figures, or the entry the page is about.',
  false: 'The block is site navigation, a menu or breadcrumb, a sidebar or list of other pages, a cookie, sign-up or advertising notice, a pager, share buttons, comments, or the site footer.',
} as const;

/** Most characters of one block a request carries; longer blocks are clipped with a note. */
export const MAX_JUDGED_BLOCK_CHARS = 2_000;

/** Requests in flight at once when a page needs more than one. */
const REQUEST_CONCURRENCY = 4;

/** One block to read: its position on the page (1-based), its element path and its text. */
export interface ContentBlock {
  readonly number: number;
  readonly path: string;
  readonly text: string;
}

export interface PageContentFixture {
  readonly name: string;
  readonly title: string;
  /** The page's blocks in order, as [element path, text]; numbered from 1. */
  readonly blocks: readonly (readonly [string, string])[];
  /** The expected answer for each labelled block, by number. */
  readonly expect: Readonly<Record<number, 'yes' | 'no'>>;
}

export interface PageContent extends NamedDecision {
  /** One reading per block, by block number. */
  read(port: JudgmentPort, title: string, blocks: readonly ContentBlock[], options?: CallOptions): Promise<Map<number, YesNoReading>>;
}

const clipText = (text: string): string =>
  text.length <= MAX_JUDGED_BLOCK_CHARS ? text : `${text.slice(0, MAX_JUDGED_BLOCK_CHARS)} [${text.length - MAX_JUDGED_BLOCK_CHARS} more characters]`;

const lineFor = (block: ContentBlock): string => `#${block.number} [${block.path}]\n${clipText(block.text)}`;
const keyFor = (block: ContentBlock): string => `main_${block.number}`;
const questionFor = (block: ContentBlock): Question => noul({ question: CONTENT_INSTRUCTIONS, block: `#${block.number}` }, CONTENT_CRITERIA);

const SEPARATOR = '\n\n';
const ESCAPED_SEPARATOR_CHARS = JSON.stringify(SEPARATOR).length - 2;
const jsonChars = (text: string): number => JSON.stringify(text).length - 2;

/**
 * Splits blocks into consecutive runs, each run one request within the
 * documented limits: the state plus every question under maxRequestTokens,
 * the state plus the longest question under maxStateWithQuestionTokens,
 * both estimated exactly as the port validates them.
 */
export function packContentRequests(title: string, blocks: readonly ContentBlock[]): ContentBlock[][] {
  const emptyStateChars = JSON.stringify({ title, page: '' }).length;
  const runs: ContentBlock[][] = [];
  let run: ContentBlock[] = [];
  let stateChars = emptyStateChars;
  let questionTokens = 0;
  let longestQuestion = 0;
  for (const block of blocks) {
    const lineChars = jsonChars(lineFor(block)) + (run.length > 0 ? ESCAPED_SEPARATOR_CHARS : 0);
    const tokens = estimateTokens(questionFor(block));
    const stateTokens = Math.ceil((stateChars + lineChars) / 3);
    const fits = stateTokens + questionTokens + tokens <= LIMITS.maxRequestTokens
      && stateTokens + Math.max(longestQuestion, tokens) <= LIMITS.maxStateWithQuestionTokens;
    if (run.length > 0 && !fits) {
      runs.push(run);
      run = [];
      stateChars = emptyStateChars + jsonChars(lineFor(block));
      questionTokens = tokens;
      longestQuestion = tokens;
    } else {
      stateChars += lineChars;
      questionTokens += tokens;
      longestQuestion = Math.max(longestQuestion, tokens);
    }
    run.push(block);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

export function definePageContent(spec: {
  readonly name: string;
  readonly version: number;
  readonly description: string;
  readonly accuracyFloor: number;
  readonly fixtures: readonly PageContentFixture[];
}): PageContent {
  const header = decisionHeader(spec);
  const labels = spec.fixtures.flatMap((fixture) => Object.values(fixture.expect));
  if (!labels.includes('yes') || !labels.includes('no')) throw new RangeError(`decision ${spec.name}: fixtures need at least one yes and one no`);
  for (const fixture of spec.fixtures) {
    for (const number of Object.keys(fixture.expect).map(Number)) {
      if (!(number >= 1 && number <= fixture.blocks.length)) throw new RangeError(`decision ${spec.name}: fixture ${fixture.name} labels unknown block #${number}`);
    }
  }

  const askRun = async (port: JudgmentPort, title: string, run: readonly ContentBlock[], options: CallOptions): Promise<Array<[number, YesNoReading]>> => {
    const state = { title, page: run.map(lineFor).join(SEPARATOR) };
    const questions = Object.fromEntries(run.map((block) => [keyFor(block), questionFor(block)]));
    const result = await askAs(port, spec, 'battery', state, questions, options);
    const answers = result.answers as Record<string, NoulResponse>;
    const readings = run.map((block): [number, YesNoReading] => [block.number, readYesNo(answers[keyFor(block)]!, PAGE_CONTENT_BAND)]);
    recordReadings(port, result, Object.fromEntries(readings.map(([number, reading]) => [`#${number}`, reading])));
    return readings;
  };

  const decision: PageContent = {
    ...header,
    async read(port, title, blocks, options = {}) {
      if (blocks.length === 0) return new Map();
      const runs = packContentRequests(title, blocks);
      const read = await mapLimit(runs, REQUEST_CONCURRENCY, (run) => askRun(port, title, run, options));
      return new Map(read.flat());
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => {
        const blocks = fixture.blocks.map(([path, text], index) => ({ number: index + 1, path, text }));
        const readings = await decision.read(port, fixture.title, blocks, run);
        return Object.entries(fixture.expect).map(([number, expected]) =>
          checkReading(fixture.name, `#${number}`, expected, readings.get(Number(number))!, 'main'));
      }),
  };
  return decision;
}

export const pageContent = definePageContent({
  name: 'engine.tools.page-content',
  version: 1,
  description: 'Which blocks of a fetched web page are part of its main content rather than navigation, sidebars, notices or footers.',
  accuracyFloor: 0.85,
  fixtures: [
    {
      name: 'recipe post',
      title: 'Weeknight Lemon Garlic Pasta | Dana Cooks',
      blocks: [
        ['header#site-header > nav', 'Home\nRecipes\nAbout\nContact\nSubscribe'],
        ['main > article > header', 'Weeknight Lemon Garlic Pasta\nBy Dana Ruiz, March 3, 2025'],
        ['main > article', 'This pasta comes together in twenty minutes with pantry staples, and the lemon keeps it bright enough for spring.'],
        ['main > article > ul', '8 oz spaghetti\n3 cloves garlic, sliced\n1 lemon, zested and juiced\n2 tbsp butter\nParmesan to serve'],
        ['main > article', 'Boil the spaghetti in well-salted water. Meanwhile, cook the garlic in butter over low heat until golden, then add the lemon zest and juice. Toss with the drained pasta and a splash of pasta water.'],
        ['aside.sidebar > ul', 'Popular posts\nBest Banana Bread\nSheet Pan Chicken Thighs\nFive-Minute Pancake Batter'],
        ['div.newsletter', 'Get new recipes in your inbox every Friday.\nSign up'],
        ['footer', '© 2025 Dana Cooks. Privacy Policy. Terms of Use.'],
      ],
      expect: { 1: 'no', 2: 'yes', 3: 'yes', 4: 'yes', 5: 'yes', 6: 'no', 7: 'no', 8: 'no' },
    },
    {
      name: 'docs page built from divs',
      title: 'Configuration - Tool Docs',
      blocks: [
        ['div#app > div.topbar', 'Docs\nAPI\nBlog\nGitHub\nSearch'],
        ['div#app > div.sidebar > ul', 'Getting started\nInstallation\nConfiguration\nCLI reference\nPlugins'],
        ['div#app > div.content', 'Configuration\nThe config file lives at ~/.tool/config.json and is read at startup. Every setting has a default, so the file only needs the settings you change.'],
        ['div#app > div.content > pre', '{\n  "theme": "dark",\n  "timeout": 30\n}'],
        ['div#app > div.content > div.pager', '← Installation\nCLI reference →'],
        ['div#app > div.cookie-banner', 'We use cookies to improve your experience.\nAccept all\nReject'],
      ],
      expect: { 1: 'no', 2: 'no', 3: 'yes', 4: 'yes', 5: 'no', 6: 'no' },
    },
    {
      name: 'news article',
      title: 'Council approves Main Street bike lanes - The Daily Ledger',
      blocks: [
        ['header', 'The Daily Ledger\nWorld\nBusiness\nTech\nSports'],
        ['article > header', 'City council approves new bike lanes on Main Street'],
        ['article', 'The city council voted 7-2 on Tuesday to add protected bike lanes along Main Street, the first such lanes downtown. Construction starts in June.'],
        ['article > figure', 'Cyclists on Main Street during the morning commute. Photo: J. Park'],
        ['section.related > ul', 'Related stories\nTransit budget grows for the third year\nNew bus routes announced'],
        ['div.comments', 'Sign in to join the discussion.\n142 comments'],
        ['div.share', 'Share on Facebook\nShare on X\nCopy link'],
      ],
      expect: { 1: 'no', 2: 'yes', 3: 'yes', 4: 'yes', 5: 'no', 6: 'no', 7: 'no' },
    },
  ],
});
