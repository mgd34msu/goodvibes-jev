/**
 * `engine.tools.page-summary`: which paragraph of a fetched page best says
 * what the page is about? Read by Jev in place of the fetch tool's `summary`
 * mode taking the first `h1`-`h3` and the first paragraph (the first two
 * paragraphs of plain text), which returned a byline, a date, a cookie notice
 * or a photo credit whenever one came first.
 *
 * The candidate-selection pattern: code offers the page's paragraphs (the
 * HTML grammar in fetch/page-blocks.ts, blank lines in plain text); one
 * choice picks among them or none, and one yes/no per candidate confirms the
 * pick says what the page is about on its own.
 *
 * Band: low stakes. The summary is a view of a page the caller can fetch in
 * full; a poor pick costs a second fetch. Code uses the pick when it acts.
 */
import { defineSelector, STAKES_BANDS, type Candidate } from '@goodvibes-jev/judgment';

/** Most characters of one paragraph a candidate carries. */
export const MAX_JUDGED_PARAGRAPH_CHARS = 600;

const clip = (text: string): string =>
  text.length <= MAX_JUDGED_PARAGRAPH_CHARS ? text : `${text.slice(0, MAX_JUDGED_PARAGRAPH_CHARS)} [${text.length - MAX_JUDGED_PARAGRAPH_CHARS} more characters]`;

/** One paragraph as a candidate. */
export function paragraphCandidate(id: string, text: string): Candidate {
  return { id, content: clip(text) };
}

const page = (title: string, paragraphs: readonly string[]) => ({
  context: { title },
  candidates: paragraphs.map((text, index) => paragraphCandidate(`p${index + 1}`, text)),
});

export const pageSummary = defineSelector({
  name: 'engine.tools.page-summary',
  version: 1,
  description: 'Which paragraph of a fetched page best says what the page as a whole is about.',
  accuracyFloor: 0.85,
  instructions:
    '`candidates` are paragraphs from a fetched page titled `context.title` (empty when the page has no title). Which paragraph best says what the page as a whole is about, so that someone reading only it would know the page\'s subject and what it covers? Choose none when no paragraph does.',
  fitInstructions:
    'Does this paragraph say what the page as a whole is about: its subject and what it covers? A navigation label, a cookie, sign-up or legal notice, a byline or date, a photo credit, a button label, or one step or detail from partway through does not.',
  band: STAKES_BANDS.low.confidence,
  fitBand: STAKES_BANDS.low.yesNo,
  fixtures: [
    {
      name: 'recipe with a byline first',
      ...page('Weeknight Lemon Garlic Pasta | Dana Cooks', [
        'Posted March 3, 2025 by Dana Ruiz',
        'This lemon garlic pasta comes together in twenty minutes with pantry staples, making it an easy weeknight dinner for four.',
        'Boil the spaghetti in well-salted water until al dente.',
        'Sign up for the newsletter to get new recipes every week.',
      ]),
      expect: 'p2',
    },
    {
      name: 'docs page with an edit link first',
      ...page('Configuration - Tool Docs', [
        'Edit this page on GitHub',
        'Step 3: restart the daemon.',
        'The config file at ~/.tool/config.json controls themes, timeouts and plugins; this page lists every setting and its default.',
        'Was this page helpful? Yes No',
      ]),
      expect: 'p3',
    },
    {
      name: 'news story with a photo credit first',
      ...page('Council approves Main Street bike lanes - The Daily Ledger', [
        'Photo: J. Park',
        'The city council voted 7-2 on Tuesday to add protected bike lanes along Main Street, the first such lanes downtown.',
        'Council member Ortiz, who voted no, said parking was a concern.',
      ]),
      expect: 'p2',
    },
    {
      name: 'plain text readme',
      ...page('', [
        'fastcsv',
        'fastcsv is a streaming CSV parser for Node.js that handles quoted fields and multi-gigabyte files in constant memory.',
        'Install with npm install fastcsv.',
        'MIT License',
      ]),
      expect: 'p2',
    },
    {
      name: 'release notes with the overview last',
      ...page('Release notes 4.2 - Widget', [
        'Last updated 2 days ago',
        'Fixed a crash when saving empty files.',
        'Version 4.2 adds offline sync and a redesigned editor and fixes twelve bugs; this page lists every change.',
      ]),
      expect: 'p3',
    },
    {
      name: 'only boilerplate',
      ...page('Account | Example Bank', [
        'Skip to main content',
        'We use cookies to improve your experience. Accept all',
        '© 2025 Example Bank. Member FDIC.',
      ]),
      expect: 'none',
    },
    {
      name: 'only a sign-in prompt and legal text',
      ...page('Sign in', [
        'Forgot your password?',
        'By continuing you agree to the Terms of Service and Privacy Policy.',
      ]),
      expect: 'none',
    },
  ],
});
