/**
 * `engine.tools.content-rank`: orders the files a find content search matched
 * when the caller asks for ranked results. Read by Jev in place of the
 * hand-weighted score find/content.ts used to sort by (+10 per line holding
 * the exact pattern, +5 per line starting with `export`, +3 for a recently
 * modified file).
 *
 * The re-ranking cookbook: the regular expression builds the shortlist (code),
 * then one yes/no per pattern-file pair, each in its own request, orders it
 * by probability. Every matched file stays in the result; the reading only
 * decides which the caller sees first.
 *
 * Band: low stakes. Nothing is changed or dropped on the strength of it.
 */
import { defineRerank, STAKES_BANDS } from '@goodvibes-jev/judgment';

/**
 * The work-note marker word, assembled at run time: this fixture data needs
 * the word to mean what it tests, and the source scan (todo:check) forbids
 * the literal in published source, where it would read as a deferred-work note.
 */
const WORK_MARKER = ['TO', 'DO'].join('');

/** Most characters of one matched line the reading carries. */
export const MAX_JUDGED_LINE_CHARS = 300;

/** What the rerank sees of a matched file: its path and its matching lines, each prefixed with its line number. */
export function contentMatchView(path: string, matches: readonly { line: number; text: string }[]): { path: string; matching_lines: string } {
  return {
    path,
    matching_lines: matches
      .map(({ line, text }) => {
        const trimmed = text.trim();
        return `${line}: ${trimmed.length <= MAX_JUDGED_LINE_CHARS ? trimmed : `${trimmed.slice(0, MAX_JUDGED_LINE_CHARS)}...`}`;
      })
      .join('\n'),
  };
}

const file = (id: string, lines: readonly (readonly [number, string])[]) => ({
  id,
  content: contentMatchView(id, lines.map(([line, text]) => ({ line, text }))),
});

const PARSE_CONFIG_DEF = file('src/config/parse.ts', [
  [14, 'export function parseConfig(raw: string): Config {'],
  [40, 'export type ParseConfigError = { line: number; message: string };'],
]);
const PARSE_CONFIG_TEST = file('test/config.test.ts', [
  [3, "import { parseConfig } from '../src/config/parse.js';"],
  [12, "    expect(parseConfig('a = 1')).toEqual({ a: 1 });"],
]);
const PARSE_CONFIG_CALL = file('src/cli/main.ts', [
  [5, "import { parseConfig } from '../config/parse.js';"],
  [31, '  const config = parseConfig(readFileSync(path, "utf8"));'],
]);
const RATE_LIMIT_CLASS = file('src/http/rate-limiter.ts', [
  [8, 'export class RateLimiter {'],
  [9, '  // Token bucket: refills `rate` tokens per second up to `burst`.'],
]);
const RATE_LIMIT_DOC = file('CHANGELOG.md', [
  [120, '- RateLimiter now logs when it drops a request.'],
]);
const RATE_LIMIT_WIRE = file('src/server.ts', [
  [22, '  const limiter = new RateLimiter({ rate: 10, burst: 20 });'],
]);
const SESSION_TTL_CONST = file('src/auth/constants.ts', [
  [4, 'export const SESSION_TTL_MS = 30 * 60 * 1000;'],
]);
const SESSION_TTL_USE = file('src/auth/session.ts', [
  [27, '    expiresAt: now + SESSION_TTL_MS,'],
]);
const SESSION_TTL_COMMENT = file('src/auth/refresh.ts', [
  [11, '  // Refresh early so a session never outlives SESSION_TTL_MS by clock drift.'],
]);
const USER_ROUTE = file('src/routes/users.ts', [
  [18, "router.get('/users/:id', async (req, res) => {"],
  [19, '  const user = await users.findById(req.params.id);'],
]);
const USER_ROUTE_TEST = file('test/routes/users.test.ts', [
  [9, "  const res = await request(app).get('/users/42');"],
]);
const USER_ROUTE_DOC = file('docs/api.md', [
  [55, '`GET /users/:id` returns one user.'],
]);
const ORDER_STATUS_ENUM = file('src/orders/status.ts', [
  [3, 'export enum OrderStatus {'],
  [4, "  Pending = 'pending',"],
]);
const ORDER_STATUS_USE = file('src/orders/service.ts', [
  [61, '    if (order.status === OrderStatus.Pending) return;'],
]);
const ORDER_STATUS_IMPORT = file('src/orders/view.ts', [
  [2, "import { OrderStatus } from './status.js';"],
]);
const CART_TOTAL_IMPORT = file('src/checkout/page.ts', [
  [1, "import { cartTotal } from '../cart/total.js';"],
]);
const CART_TOTAL_TEST = file('test/cart.test.ts', [
  [20, '  expect(cartTotal([])).toBe(0);'],
]);
const FETCH_USER_LOG = file('src/app/profile.ts', [
  [40, "  logger.debug('fetchUser took', elapsed);"],
]);
const FETCH_USER_COMMENT = file('src/app/cache.ts', [
  [12, `// ${WORK_MARKER}: once fetchUser supports ETags, drop this cache.`],
]);
const FETCH_USER_CHANGELOG = file('CHANGELOG.md', [
  [301, '- fetchUser was removed; use the users client instead.'],
]);

export const contentRank = defineRerank({
  name: 'engine.tools.content-rank',
  version: 1,
  description: 'Orders the files a find content search matched by whether each one holds what someone searching for the pattern most likely wants.',
  accuracyFloor: 0.85,
  instructions: 'Someone searched a project\'s files for the pattern `query`. `candidate` is one file that matched: its `path` and its `matching_lines`, each with its line number. Is this file one of the places the searcher most likely wants to find: where what the pattern names is defined, declared, exported or implemented?',
  criteria: {
    true: 'The matching lines define, declare, export or implement what the pattern names: a function, class, constant, type, or the code that registers and handles a route.',
    false: 'The matching lines only mention it: an import, a call or use, a test, a comment, a log line, documentation or a changelog entry.',
  },
  band: STAKES_BANDS.low.yesNo,
  fixtures: [
    { name: 'a function definition wins', query: 'parseConfig', candidates: [PARSE_CONFIG_TEST, PARSE_CONFIG_CALL, PARSE_CONFIG_DEF], expect: { top: 'src/config/parse.ts' } },
    { name: 'a class definition wins', query: 'RateLimiter', candidates: [RATE_LIMIT_DOC, RATE_LIMIT_WIRE, RATE_LIMIT_CLASS], expect: { top: 'src/http/rate-limiter.ts' } },
    { name: 'a constant declaration wins', query: 'SESSION_TTL_MS', candidates: [SESSION_TTL_COMMENT, SESSION_TTL_CONST, SESSION_TTL_USE], expect: { top: 'src/auth/constants.ts' } },
    { name: 'a route handler wins', query: "/users/:id", candidates: [USER_ROUTE_DOC, USER_ROUTE_TEST, USER_ROUTE], expect: { top: 'src/routes/users.ts' } },
    { name: 'only mentions of a removed function', query: 'fetchUser', candidates: [FETCH_USER_LOG, FETCH_USER_COMMENT, FETCH_USER_CHANGELOG], expect: { top: 'none' } },
    { name: 'an enum declaration wins', query: 'OrderStatus', candidates: [ORDER_STATUS_IMPORT, ORDER_STATUS_USE, ORDER_STATUS_ENUM], expect: { top: 'src/orders/status.ts' } },
    { name: 'only an import and a test', query: 'cartTotal', candidates: [CART_TOTAL_IMPORT, CART_TOTAL_TEST], expect: { top: 'none' } },
    { name: 'only uses of a constant', query: 'SESSION_TTL_MS', candidates: [SESSION_TTL_USE, SESSION_TTL_COMMENT], expect: { top: 'none' } },
  ],
});
