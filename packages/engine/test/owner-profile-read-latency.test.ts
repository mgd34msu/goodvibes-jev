/**
 * Mechanical-field reads use the projection built at load: no repeated file
 * reads, stats, or parsing. The ns/read figure is advisory; host contention
 * must not turn a correct cached read into a required-test failure.
 */
import { afterEach, describe, expect, test, beforeEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerProfileStore } from '../sdk/src/platform/owner-profile/index.ts';
import * as profileDocument from '../sdk/src/platform/owner-profile/document.ts';
import { resetProcessUntrustedContentLedgerForTests } from '../sdk/src/platform/security/untrusted-content.ts';

// Profile writes ask the content-derivation reading whenever the process
// ledger holds untrusted text; another test file's reads must not reach these.
beforeEach(() => { resetProcessUntrustedContentLedgerForTests(); });

const tmpDirs: string[] = [];
function mkTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-profile-bench-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A realistic 200-line profile: every mechanical field, provenance suffixes on
 * many of them, superseded history comments, prose bullets under every
 * prose-only section, and enough filler notes to reach the target length.
 *
 * "Realistic" matters because the read path is a Map lookup only if the parse
 * genuinely built the map once. A three-line fixture would prove nothing about
 * a document with history comments and unknown headings in it.
 */
function buildRealisticProfile(): string {
  const lines: string[] = [
    '# Avery\'s profile',
    '',
    '<!-- GoodVibes keeps this file. Edit it by hand whenever you like. -->',
    '',
    '## Identity',
    '',
    'name: Avery Chen',
    'goes by: Avery',
    'pronouns: he/him',
    '',
    '## Contact',
    '',
    'email: owner@example.com — tui, 2026-07-20, "my email is owner@example.com"',
    'phone: +1 517 555 0134',
    'agent alias: agent@example.com',
    '- Prefers Telegram for anything urgent — agent, 2026-07-27, "ping me on telegram if it\'s urgent"',
    '',
    '## Location',
    '',
    'timezone: America/Detroit',
    'city: Lansing, MI',
    'home address: 401 Home St, Lansing, MI 48933, US',
    '',
    '## Commerce',
    '',
    'shipping address: 200 Office Way, Lansing, MI 48933, US — tui, 2026-07-27, "ship it to my office instead"',
    'billing address: 401 Home St, Lansing, MI 48933, US',
    'currency: USD',
    'shipping tier: standard',
    '',
    '<!-- was: shipping address: 401 Home St, Lansing, MI 48933, US — tui, 2026-07-20, "ship to 401 Home St" (superseded 2026-07-27) -->',
    '',
    '## Preferences',
    '',
    'units: imperial',
    'date format: iso',
    'locale: en-US',
    '',
    '## Contacting me',
    '',
    'channel: telegram',
    'quiet hours: 22:00-07:00',
    '',
    '## Style',
    '',
    'verbosity: brief',
    'formality: casual',
    '- Keep replies short unless I ask for detail — tui, 2026-07-26, "keep it short unless I ask"',
    '',
    '## Defaults',
    '',
    'approval window: 30',
    '',
    '## People',
    '',
    '- Sarah, sister, sarah@example.com — tui, 2026-07-27, "my sister Sarah, sarah@example.com"',
    '- Dave from work, handles the Pellux contracts',
    '',
    '## Places',
    '',
    '- Gym: the Y on Michigan Ave — agent, 2026-07-27, "I go to the Y on Michigan Ave"',
    '',
    '## Work',
    '',
    '- Runs Pellux, founder — tui, 2026-07-27, "I run Pellux"',
    '',
    '## Notes',
    '',
  ];
  let n = 1;
  while (lines.length < 199) {
    lines.push(`- Note ${n}: something he mentioned in passing — tui, 2026-07-2${n % 10}, "note ${n}"`);
    n += 1;
  }
  lines.push('');
  return lines.join('\n');
}

describe('owner profile cached reads', () => {
  test('repeated reads do no filesystem or parsing work; latency is advisory', async () => {
    const dir = mkTemp();
    const path = join(dir, 'owner-profile.md');
    const text = buildRealisticProfile();
    writeFileSync(path, text, 'utf-8');
    expect(text.split('\n').length).toBeGreaterThanOrEqual(200);

    const store = new OwnerProfileStore({ path });
    const readFile = spyOn(fs.promises, 'readFile');
    const readFileSync = spyOn(fs, 'readFileSync');
    const stat = spyOn(fs.promises, 'stat');
    const statSync = spyOn(fs, 'statSync');
    const parse = spyOn(profileDocument, 'parseProfileDocument');
    // Filter filesystem observations to this fixture so unrelated background
    // work in the shared test process cannot change the counts.
    const workCounts = () => ({
      reads: readFile.mock.calls.filter(([file]) => file === path).length,
      syncReads: readFileSync.mock.calls.filter(([file]) => file === path).length,
      stats: stat.mock.calls.filter(([file]) => file === path).length,
      syncStats: statSync.mock.calls.filter(([file]) => file === path).length,
      parses: parse.mock.calls.filter(([input]) => input.path === path).length,
    });
    try {
      const state = await store.load();
      expect(state.kind).toBe('loaded');
      const loadedWork = workCounts();
      // Verify the observers see real work before using them as a no-work proof.
      expect(loadedWork.reads).toBeGreaterThan(0);
      expect(loadedWork.syncStats).toBeGreaterThan(0);
      expect(loadedWork.parses).toBeGreaterThan(0);
      expect(store.get('location.timezone')?.value).toBe('America/Detroit');

      const fields = [
        ['location.timezone', 'America/Detroit'],
        ['commerce.shippingAddress', '200 Office Way, Lansing, MI 48933, US'],
        ['preferences.units', 'imperial'],
        ['contactMe.quietHours', '22:00-07:00'],
        ['identity.goesBy', 'Avery'],
      ] as const;
      for (const [fieldId, value] of fields) expect(store.get(fieldId)?.value).toBe(value);

      let sink = 0;
      for (let i = 0; i < 50_000; i++) {
        sink += store.get(fields[i % fields.length]![0]) === undefined ? 0 : 1;
      }
      const iterations = 1_000_000;
      const startedAt = process.hrtime.bigint();
      for (let i = 0; i < iterations; i++) {
        sink += store.get(fields[i % fields.length]![0]) === undefined ? 0 : 1;
      }
      const nsPerRead = Number(process.hrtime.bigint() - startedAt) / iterations;
      expect(sink).toBe(50_000 + iterations);
      expect(workCounts()).toEqual(loadedWork);

      // Advisory measurement, without a host-speed quota in the required gate.
      // eslint-disable-next-line no-console
      console.log(
        `[owner-profile] advisory mechanical-field read: ${nsPerRead.toFixed(1)} ns/read `
        + `over ${iterations.toLocaleString('en-US')} reads of a ${text.split('\n').length}-line profile`,
      );
    } finally {
      parse.mockRestore();
      statSync.mockRestore();
      stat.mockRestore();
      readFileSync.mockRestore();
      readFile.mockRestore();
    }
  });
});
