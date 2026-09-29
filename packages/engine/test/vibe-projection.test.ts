import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import {
  MemoryEmbeddingProviderRegistry,
  MemoryStore,
  renderVibeProjection,
  selectVibeRecords,
  vibeBodyToConstraintOptions,
  VIBE_PROJECTION_HEADING,
  VIBE_PROJECTION_CAVEAT,
} from '../sdk/src/platform/state/index.js';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';

/**
 * VIBE.md as a projection of persona/constraint records.
 *
 * Asserts: the '## VIBE.md' block renders from constraint records (not a file),
 * the precedence caveat is preserved, a persona edit via a record changes the
 * projected block, and persona records round-trip through the normal MemoryStore
 * bundle seam (the file demoted to an import/export format).
 *
 * Whether a non-bullet line is a persona instruction is read by Jev
 * (engine.state.vibe-persona-line); the fake port below answers with the
 * probability `lineAnswer` gives, a no for every line unless a test says
 * otherwise.
 */

let lineAnswer: (line: string) => number = () => 0.03;
let lineRequests: ReturnType<typeof fakePort>['requests'] = [];
let previousPort: JudgmentPort | undefined;

beforeEach(() => {
  lineAnswer = () => 0.03;
  const fake = fakePort((name, _question, state) => {
    if (name !== 'instruction') throw new Error(`unexpected question ${name}`);
    return noulAnswer(lineAnswer((state as { line: string }).line));
  });
  lineRequests = fake.requests;
  previousPort = installJudgmentPort(fake.port);
});

afterEach(() => {
  installJudgmentPort(previousPort);
});

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function openStore(root: string): MemoryStore {
  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  return new MemoryStore(join(root, 'memory.sqlite'), {
    embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    enableVectorIndex: false,
  });
}

const SAMPLE_VIBE = [
  '# VIBE.md',
  '',
  'Describe how GoodVibes Agent should feel and work with you.',
  '',
  '- Be direct about tradeoffs.',
  '- Prefer visible, reversible actions.',
].join('\n');

describe('VIBE body imported as constraint records (file demoted to format)', () => {
  test('each bullet becomes one persona constraint record; the other lines are read and a no leaves them out', async () => {
    const options = await vibeBodyToConstraintOptions(SAMPLE_VIBE, { scope: 'project', sourceRef: '/repo/VIBE.md' });
    expect(options.length).toBe(2);
    expect(options.every((o) => o.cls === 'constraint')).toBe(true);
    expect(options.every((o) => o.scope === 'project')).toBe(true);
    expect(options.every((o) => o.tags?.includes('vibe'))).toBe(true);
    expect(options.map((o) => o.summary)).toEqual([
      'Be direct about tradeoffs.',
      'Prefer visible, reversible actions.',
    ]);
    expect(options[0]!.provenance?.[0]).toEqual({ kind: 'file', ref: '/repo/VIBE.md' });
    // The heading and the template line are read, the bullets and blank lines never are.
    expect(lineRequests.map((request) => request.state)).toEqual([
      { line: '# VIBE.md', body: SAMPLE_VIBE },
      { line: 'Describe how GoodVibes Agent should feel and work with you.', body: SAMPLE_VIBE },
    ]);
  });

  test('a line read yes in a bulleted body becomes its own record, in document order', async () => {
    const body = ['# Persona', 'Always answer in British English.', '', '## Tone', '- Keep replies short.', '# Talk to me like a colleague'].join('\n');
    lineAnswer = (line) => (line === 'Always answer in British English.' || line.startsWith('# Talk') ? 0.97 : 0.03);
    const options = await vibeBodyToConstraintOptions(body);
    expect(options.map((o) => o.summary)).toEqual([
      'Always answer in British English.',
      'Keep replies short.',
      'Talk to me like a colleague',
    ]);
  });

  test('a yes too weak to act on leaves the line out', async () => {
    lineAnswer = (line) => (line === 'Always answer in British English.' ? 0.58 : 0.03);
    const options = await vibeBodyToConstraintOptions(['Always answer in British English.', '- Keep replies short.'].join('\n'));
    expect(options.map((o) => o.summary)).toEqual(['Keep replies short.']);
  });

  test('a prose-only body (no bullets) becomes a single record, with no line read when it has no headings', async () => {
    const options = await vibeBodyToConstraintOptions('Keep things calm and clear.', { name: 'Calm' });
    expect(options.length).toBe(1);
    expect(options[0]!.detail).toBe('Keep things calm and clear.');
    expect(options[0]!.tags).toContain('Calm');
    expect(lineRequests).toHaveLength(0);
  });

  test('in a prose body, a heading read yes stays in the detail and a heading read no is dropped', async () => {
    const body = ['# My vibe', '## Never apologise, just fix it', 'Keep things calm and clear.'].join('\n');
    lineAnswer = (line) => (line.includes('Never apologise') ? 0.97 : 0.03);
    const options = await vibeBodyToConstraintOptions(body);
    expect(options).toHaveLength(1);
    expect(options[0]!.detail).toBe('## Never apologise, just fix it\nKeep things calm and clear.');
    expect(lineRequests).toHaveLength(2);
  });
});

describe('renderVibeProjection (records -> prompt block)', () => {
  test('projects the VIBE block from constraint records with the caveat preserved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-vibe-proj-'));
    tmpRoots.push(root);
    const store = openStore(root);
    await store.init();
    for (const opts of await vibeBodyToConstraintOptions(SAMPLE_VIBE, { scope: 'project' })) {
      await store.add(opts);
    }
    // A non-persona constraint must NOT leak into the projection.
    await store.add({ scope: 'project', cls: 'constraint', summary: 'unrelated constraint', tags: ['policy'] });

    const block = renderVibeProjection(await store.search({}));
    expect(block).not.toBeNull();
    expect(block).toContain(VIBE_PROJECTION_HEADING);
    expect(block).toContain(VIBE_PROJECTION_CAVEAT);
    expect(block).toContain('- Be direct about tradeoffs.');
    expect(block).toContain('- Prefer visible, reversible actions.');
    expect(block).not.toContain('unrelated constraint');
    store.close();
  });

  test('no persona records → no block (null, not an empty header)', () => {
    expect(renderVibeProjection([])).toBeNull();
  });

  test('editing one persona record changes exactly that line of the block', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-vibe-edit-'));
    tmpRoots.push(root);
    const store = openStore(root);
    await store.init();
    const created = [];
    for (const opts of await vibeBodyToConstraintOptions(SAMPLE_VIBE, { scope: 'project' })) {
      created.push(await store.add(opts));
    }
    store.update(created[0]!.id, { summary: 'Be extremely direct about tradeoffs.' });
    const block = renderVibeProjection(await store.search({}));
    expect(block).toContain('- Be extremely direct about tradeoffs.');
    expect(block).not.toContain('- Be direct about tradeoffs.');
    expect(block).toContain('- Prefer visible, reversible actions.');
    store.close();
  });
});

describe('persona records round-trip through the bundle seam', () => {
  test('export from one store, import into another, projection is identical', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'gv-vibe-rt-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'gv-vibe-rt-b-'));
    tmpRoots.push(rootA, rootB);

    const storeA = openStore(rootA);
    await storeA.init();
    for (const opts of await vibeBodyToConstraintOptions(SAMPLE_VIBE, { scope: 'project' })) {
      await storeA.add(opts);
    }
    const projectionA = renderVibeProjection(await storeA.search({}));
    const bundle = storeA.exportBundle({});
    storeA.close();

    const storeB = openStore(rootB);
    await storeB.init();
    await storeB.importBundle(bundle);
    const projectionB = renderVibeProjection(await storeB.search({}));
    expect(projectionB).toBe(projectionA);
    expect(selectVibeRecords(await storeB.search({})).length).toBe(2);
    storeB.close();
  });
});
