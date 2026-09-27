/**
 * `engine.tools.edit-target`: when an edit's find text is not in the file
 * exactly (nor after whitespace normalization), is the run of file lines that
 * best lines up with it the same code the find text was written to target?
 * Read by Jev in place of the fixed 0.7 line-similarity cutoff match.ts used
 * to accept a fuzzy line match.
 *
 * Code still slides a window of the find text's line count over the file and
 * keeps the window with the most exactly matching normalized lines (the
 * shortlist, arithmetic); this one yes/no decides whether that window is
 * edited.
 *
 * Band: medium stakes. A wrong yes rewrites the wrong lines of a file (the
 * edit is reported with a verify warning and can be reverted); a wrong no
 * only sends the caller back to correct the find text. Only a yes that acts
 * is applied; a yes that would need confirming is returned as a
 * "Did you mean this?" hint so the caller confirms by resending the text.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** Most characters of the find text or the window one request carries; longer text is clipped with a note. */
export const MAX_JUDGED_EDIT_CHARS = 4_000;

function clip(text: string): string {
  return text.length <= MAX_JUDGED_EDIT_CHARS
    ? text
    : `${text.slice(0, MAX_JUDGED_EDIT_CHARS)}\n[${text.length - MAX_JUDGED_EDIT_CHARS} more characters]`;
}

/** What the reading sees: the requested find text and the candidate window of file lines. */
export function editTargetView(find: string, windowLines: readonly string[]): { find: string; window: string } {
  return { find: clip(find), window: clip(windowLines.join('\n')) };
}

const view = (find: readonly string[], window: readonly string[]) => editTargetView(find.join('\n'), window);

export const editTarget = defineBattery({
  name: 'engine.tools.edit-target',
  version: 1,
  description: 'Whether the closest window of file lines is the same code an edit\'s find text was written to target, when the find text is not in the file exactly.',
  accuracyFloor: 0.85,
  items: {
    same_target: yesNo(
      'An edit tool was asked to replace the text `find` in a file, but the file does not contain `find` exactly. `window` is the run of lines in the file that lines up best with `find`, line for line. Is `window` the same piece of code that `find` was copied from, so that `find` is only a slightly stale or mistyped copy of `window` and replacing `window` carries out the edit the caller intended?',
      STAKES_BANDS.medium.yesNo,
      {
        true: 'The window is the code the caller meant: the same statements in the same place, differing from `find` only by small drift such as a typo, a changed literal or comment, a missing semicolon, or one renamed identifier.',
        false: 'The window is different code that only shares some lines with `find`: another function, block, case or entry with similar boilerplate, or code whose names and logic differ enough that the caller was describing something else.',
      },
    ),
  },
  fixtures: [
    {
      name: 'one typo in a four line block',
      state: view(
        ['function total(items) {', '  let sum = 0;', '  for (const item of items) sum += item.prce;', '  return sum;'],
        ['function total(items) {', '  let sum = 0;', '  for (const item of items) sum += item.price;', '  return sum;'],
      ),
      expect: { same_target: 'yes' },
    },
    {
      name: 'stale literal from an earlier read',
      state: view(
        ['const client = createClient({', "  baseUrl: 'https://api.example.com',", '  timeoutMs: 3000,', '  retries: 2,', '});'],
        ['const client = createClient({', "  baseUrl: 'https://api.example.com',", '  timeoutMs: 5000,', '  retries: 2,', '});'],
      ),
      expect: { same_target: 'yes' },
    },
    {
      name: 'comment wording changed',
      state: view(
        ['  // Retry the request once before failing.', '  const response = await send(request);', '  if (!response.ok) throw new HttpError(response.status);'],
        ['  // Retry once, then give up.', '  const response = await send(request);', '  if (!response.ok) throw new HttpError(response.status);'],
      ),
      expect: { same_target: 'yes' },
    },
    {
      name: 'one identifier renamed since the read',
      state: view(
        ['export function formatName(user: User): string {', '  const first = user.firstName.trim();', '  const last = user.lastName.trim();', '  return `${first} ${last}`;', '}'],
        ['export function formatName(person: User): string {', '  const first = person.firstName.trim();', '  const last = person.lastName.trim();', '  return `${first} ${last}`;', '}'],
      ),
      expect: { same_target: 'yes' },
    },
    {
      name: 'semicolons left off two lines',
      state: view(
        ['const width = box.right - box.left', 'const height = box.bottom - box.top;', 'const area = width * height', 'return { width, height, area };'],
        ['const width = box.right - box.left;', 'const height = box.bottom - box.top;', 'const area = width * height;', 'return { width, height, area };'],
      ),
      expect: { same_target: 'yes' },
    },
    {
      name: 'a sibling function with the same boilerplate',
      state: view(
        ['export async function saveUser(user: User): Promise<string> {', '  validate(user);', "  const id = await db.insert('users', user);", "  log.info('saved', { id });", '  return id;', '}'],
        ['export async function saveOrder(order: Order): Promise<string> {', '  validate(order);', "  const id = await db.insert('orders', order);", "  log.info('saved', { id });", '  return id;', '}'],
      ),
      expect: { same_target: 'no' },
    },
    {
      name: 'a different switch case',
      state: view(
        ["    case 'delete': {", '      await store.remove(action.id);', '      notify(action);', '      break;', '    }'],
        ["    case 'archive': {", '      await store.moveToArchive(action.id, action.folder);', '      notify(action);', '      break;', '    }'],
      ),
      expect: { same_target: 'no' },
    },
    {
      name: 'a different test case sharing its scaffolding',
      state: view(
        ["  it('rejects an empty email', () => {", "    const result = validateSignup({ email: '', password: 'hunter22' });", '    expect(result.ok).toBe(false);', "    expect(result.field).toBe('email');", '  });'],
        ["  it('rejects a short password', () => {", "    const result = validateSignup({ email: 'a@b.co', password: 'x' });", '    expect(result.ok).toBe(false);', "    expect(result.field).toBe('password');", '  });'],
      ),
      expect: { same_target: 'no' },
    },
    {
      name: 'only closing lines in common',
      state: view(
        ['    for (const row of rows) {', '      totals[row.region] = (totals[row.region] ?? 0) + row.amount;', '    }', '    return totals;', '  }'],
        ['    if (!session) {', "      throw new AuthError('expired');", '    }', '    return totals;', '  }'],
      ),
      expect: { same_target: 'no' },
    },
    {
      name: 'another environment block in a config',
      state: view(
        ['  production: {', "    host: 'db.internal',", '    port: 5432,', '    pool: 20,', '  },'],
        ['  development: {', "    host: 'localhost',", '    port: 5432,', '    pool: 2,', '  },'],
      ),
      expect: { same_target: 'no' },
    },
  ],
});
