/**
 * `engine.state.code-search`: orders code-index chunks against a search
 * query when the vector path is off (the index was built under a different
 * embedding provider than the current one). Read by Jev in place of the
 * matched-token fraction code-index-store.ts searchLexical used to sort by
 * (query tokens found in the chunk's symbol and path, over the token count).
 *
 * The re-ranking cookbook: the SQL LIKE match over symbol and path builds the
 * shortlist (code), then one yes/no per query-chunk pair, each in its own
 * request, orders it by probability. Chunks read as not matching are dropped.
 *
 * Band: low stakes. The order only decides which chunks a reader sees first;
 * nothing is changed or injected on the strength of it (per-turn injection
 * never reads a provider-mismatched index).
 */
import { defineRerank, STAKES_BANDS } from '@goodvibes-jev/judgment';
import type { CodeChunk } from '../code-index-chunking.js';

/** Most characters of a chunk's code one pair request carries; longer code is clipped with a note. */
export const MAX_JUDGED_CODE_CHARS = 6_000;

/** What the rerank sees of a chunk: where it is, what it defines, and its code when the file could be read. */
export function codeChunkView(
  chunk: Pick<CodeChunk, 'path' | 'symbol' | 'kind' | 'startLine' | 'endLine'>,
  code: string | undefined,
): { [field: string]: string } {
  const clipped = code === undefined || code.length <= MAX_JUDGED_CODE_CHARS
    ? code
    : `${code.slice(0, MAX_JUDGED_CODE_CHARS)}\n[${code.length - MAX_JUDGED_CODE_CHARS} more characters]`;
  return {
    path: chunk.path,
    ...(chunk.symbol ? { symbol: chunk.symbol } : {}),
    kind: chunk.kind,
    lines: `${chunk.startLine}-${chunk.endLine}`,
    ...(clipped !== undefined ? { code: clipped } : {}),
  };
}

const chunk = (id: string, path: string, symbol: string, kind: string, startLine: number, code: string) => ({
  id,
  content: codeChunkView({ path, symbol, kind, startLine, endLine: startLine + code.split('\n').length - 1 }, code),
});

const RETRY_WITH_BACKOFF = chunk('retry-with-backoff', 'src/net/retry.ts', 'retryWithBackoff', 'function', 12, [
  'export async function retryWithBackoff<T>(fn: () => Promise<T>, attempts = 5, baseMs = 200): Promise<T> {',
  '  for (let attempt = 0; ; attempt++) {',
  '    try {',
  '      return await fn();',
  '    } catch (err) {',
  '      if (attempt + 1 >= attempts) throw err;',
  '      await sleep(baseMs * 2 ** attempt + Math.random() * baseMs);',
  '    }',
  '  }',
  '}',
].join('\n'));
const RETRY_LABEL = chunk('retry-label', 'src/ui/strings.ts', 'RETRY_BUTTON_LABEL', 'variable', 40, "export const RETRY_BUTTON_LABEL = 'Retry';");
const SESSION_STORE = chunk('session-store', 'src/auth/session-store.ts', 'SessionStore', 'class', 8, [
  'export class SessionStore {',
  '  private readonly sessions = new Map<string, Session>();',
  '  create(userId: string): Session {',
  '    const session = { id: randomUUID(), userId, expiresAt: Date.now() + SESSION_TTL_MS };',
  '    this.sessions.set(session.id, session);',
  '    return session;',
  '  }',
  '  get(id: string): Session | undefined {',
  '    const session = this.sessions.get(id);',
  '    return session && session.expiresAt > Date.now() ? session : undefined;',
  '  }',
  '}',
].join('\n'));
const REVIEW_PROMPT = chunk('store-review-prompt', 'src/app/rating.ts', 'showStoreReviewPrompt', 'function', 3, [
  'export function showStoreReviewPrompt(launchCount: number): boolean {',
  '  // Ask for an app store review after the tenth launch.',
  '  return launchCount === 10;',
  '}',
].join('\n'));
const MIGRATE_WINDOW = chunk('migrate-window', 'scripts/migrate.ts', '', 'window', 1, [
  "import { readdirSync, readFileSync } from 'node:fs';",
  "import { db } from '../src/db/pool.js';",
  '',
  "const applied = new Set(db.query('SELECT name FROM schema_migrations').all().map((row) => row.name));",
  "for (const file of readdirSync('migrations').filter((name) => name.endsWith('.sql')).sort()) {",
  '  if (applied.has(file)) continue;',
  "  db.exec(readFileSync(`migrations/${file}`, 'utf8'));",
  "  db.run('INSERT INTO schema_migrations (name) VALUES (?)', [file]);",
  '}',
].join('\n'));
const DATABASE_ICON = chunk('database-icon', 'src/ui/icons.ts', 'databaseIcon', 'variable', 22, "export const databaseIcon = '\\u{1F5C4}';");
const MIGRATE_SETTINGS = chunk('migrate-settings', 'src/config/legacy.ts', 'migrateSettings', 'function', 5, [
  'export function migrateSettings(raw: Record<string, unknown>): Settings {',
  "  // Settings files before 2.0 used 'colour' instead of 'theme'.",
  "  const { colour, ...rest } = raw;",
  '  return { ...rest, theme: colour ?? rest.theme } as Settings;',
  '}',
].join('\n'));
const REQUEST_OPTIONS = chunk('request-options', 'src/http/types.ts', 'RequestOptions', 'interface', 14, [
  'export interface RequestOptions {',
  '  readonly method?: "GET" | "POST" | "PUT" | "DELETE";',
  '  readonly headers?: Record<string, string>;',
  '  readonly timeoutMs?: number;',
  '  readonly body?: unknown;',
  '}',
].join('\n'));
const OPTIONS_MENU = chunk('options-menu', 'src/ui/menu.ts', 'renderOptionsMenu', 'function', 30, [
  'export function renderOptionsMenu(items: MenuItem[]): string {',
  "  return items.map((item, i) => `${i + 1}. ${item.label}`).join('\\n');",
  '}',
].join('\n'));
const STATUS_TEXT = chunk('status-text', 'src/http/status.ts', 'httpStatusText', 'variable', 1, [
  'export const httpStatusText: Record<number, string> = {',
  "  200: 'OK', 404: 'Not Found', 500: 'Internal Server Error',",
  '};',
].join('\n'));
const DOCS_URL = chunk('websocket-docs-url', 'src/help/links.ts', 'WEBSOCKET_DOCS_URL', 'variable', 9, "export const WEBSOCKET_DOCS_URL = 'https://example.com/docs/websockets';");
const SOCKET_PATH = chunk('socket-path', 'src/daemon/ipc.ts', 'socketPathFor', 'function', 18, [
  'export function socketPathFor(home: string): string {',
  "  return join(home, '.cache', 'daemon.sock');",
  '}',
].join('\n'));

export const codeSearchRerank = defineRerank({
  name: 'engine.state.code-search',
  version: 1,
  description: 'Orders code-index chunks by whether each one is code that someone searching the project source for the query is looking for.',
  accuracyFloor: 0.9,
  instructions: 'Someone searched the project source code for `query`. `candidate` is one code chunk: the file `path`, the `symbol` it defines (if any), its line span and its code. Is this code chunk relevant to the query?',
  criteria: {
    true: 'The chunk implements, defines or directly handles what the query is about.',
    false: 'The chunk only shares a word with the query in its name or path, or is about something else.',
  },
  band: STAKES_BANDS.low.yesNo,
  fixtures: [
    { name: 'a function wins', query: 'retry with backoff', candidates: [RETRY_LABEL, RETRY_WITH_BACKOFF, STATUS_TEXT], expect: { top: 'retry-with-backoff' } },
    { name: 'a class wins', query: 'session store', candidates: [REVIEW_PROMPT, SESSION_STORE, OPTIONS_MENU], expect: { top: 'session-store' } },
    { name: 'a line window wins', query: 'database migrations', candidates: [MIGRATE_SETTINGS, DATABASE_ICON, MIGRATE_WINDOW], expect: { top: 'migrate-window' } },
    { name: 'an interface wins', query: 'http request options', candidates: [OPTIONS_MENU, STATUS_TEXT, REQUEST_OPTIONS], expect: { top: 'request-options' } },
    { name: 'a constant wins', query: 'retry button label', candidates: [RETRY_WITH_BACKOFF, RETRY_LABEL, OPTIONS_MENU], expect: { top: 'retry-label' } },
    { name: 'nothing about websocket reconnects', query: 'websocket reconnect', candidates: [DOCS_URL, SOCKET_PATH, DATABASE_ICON], expect: { top: 'none' } },
  ],
});
