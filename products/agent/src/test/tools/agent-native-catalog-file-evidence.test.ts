import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withNativeCatalog } from '../../tools/agent-harness-research-catalog-source.ts';
import { researchScreeningFixture, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(cleanupResearchScreeningFixtures);
function file(raw: string): string {
  const root = mkdtempSync(join(tmpdir(), 'native-catalog-json-')); roots.push(root);
  const path = join(root, 'catalog.json'); writeFileSync(path, raw); return path;
}
const records = () => Array.from({ length: 180 }, (_, index) => ({
  label: `Native item ${index}`, detail: `${'Complete native catalog evidence. '.repeat(12)}Tail ${index}`,
  quoted: 'A quoted "property": "value" stays inside this complete string.',
}));

describe('complete native JSON file evidence', () => {
  test('screens every value of a large file through its retained native owner', async () => {
    const raw = JSON.stringify({ records: records() }); expect(raw.length).toBeGreaterThan(40_000);
    const path = file(raw), fixture = researchScreeningFixture();
    const result = await withNativeCatalog({}, { sourceOwner: fixture.owner }, [path], () => ({}), async () => 'complete');
    expect(result).toBe('complete');
    const observed = JSON.stringify(fixture.calls);
    expect(observed).toContain('Tail 0'); expect(observed).toContain('Tail 179');
    expect(observed).toContain('complete-json-values');
  });

  test('duplicate JSON keys are refused before any privacy request', async () => {
    const raw = `{"records":${JSON.stringify(records())},"records":[]}`;
    const path = file(raw), fixture = researchScreeningFixture();
    await expect(withNativeCatalog({}, { sourceOwner: fixture.owner }, [path], () => ({}), async () => 'discarded evidence')).rejects.toMatchObject({ problem: 'held' });
    expect(fixture.calls).toHaveLength(0);
  });

  test('a private late value is refused before screening earlier file values', async () => {
    const raw = JSON.stringify({ records: records(), tail: { card: '4111111111111111' } });
    const path = file(raw), fixture = researchScreeningFixture();
    await expect(withNativeCatalog({}, { sourceOwner: fixture.owner }, [path], () => ({}), async () => 'private')).rejects.toMatchObject({ problem: 'card-material' });
    expect(fixture.calls).toHaveLength(0);
  });

  test('file replacement during screening retires the complete parsed projection', async () => {
    const path = file(JSON.stringify({ records: records() })); let consumed = false;
    const fixture = researchScreeningFixture({ beforeProposal: async () => { writeFileSync(path, '{"changed":true}'); } });
    await expect(withNativeCatalog({}, { sourceOwner: fixture.owner }, [path], () => ({}), async () => { consumed = true; })).rejects.toThrow();
    expect(consumed).toBe(false);
  });
});
