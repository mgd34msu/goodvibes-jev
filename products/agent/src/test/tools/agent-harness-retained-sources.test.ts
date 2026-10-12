import { afterAll, expect, test } from 'bun:test';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { captureCatalogSnapshot } from '../../tools/agent-harness-catalog-ranking.ts';
import { withModelReadingSource } from '../../tools/agent-harness-model-reading-source.ts';
import { forwardHarnessCatalogCall, retainHarnessCatalogCurrent } from '../../tools/agent-harness-catalog-ingress.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);

function nativeCatalogSource(path: string, body: string) {
  writeFileSync(path, body);
  const read = () => { const stat = lstatSync(path); return { dev: stat.dev, ino: stat.ino, body: readFileSync(path, 'utf8') }; };
  const original = captureCatalogSnapshot(read());
  return { view: { text: original.captured.body }, assertCurrent: () => original.assertCurrent(read()) };
}

test('nested model readings retain both native sources at the same advisory site', async () => {
  const root = makeProjectTempDir('catalog-model-retention');
  const first = nativeCatalogSource(join(root, 'first.txt'), 'First native catalog.'), secondPath = join(root, 'second.txt');
  const second = nativeCatalogSource(secondPath, 'Second native catalog.');
  let published = 0;
  const operation = withModelReadingSource(first.view, { sourceOwner: ordinaryResearchOwner() }, async (_first, outer) => {
    outer.retainCurrent?.(first.assertCurrent, 'native catalog');
    const value = await withModelReadingSource(second.view, outer, async (_second, inner) => {
      inner.retainCurrent?.(second.assertCurrent, 'native catalog');
      inner.assertCurrent?.();
      return 'Native catalog publication';
    });
    writeFileSync(secondPath, 'Retired second native catalog.');
    outer.assertCurrent?.();
    return value;
  }).then(value => { published++; return value; });
  await expect(operation).rejects.toBeInstanceOf(ToolInputProjectionError);
  expect(published).toBe(0); first.assertCurrent();
  expect(readFileSync(secondPath, 'utf8')).toBe('Retired second native catalog.');
});

test('nested native dispatcher translations retain the second same-site source through publication', async () => {
  const root = makeProjectTempDir('catalog-dispatch-retention');
  const first = nativeCatalogSource(join(root, 'first.txt'), 'First native catalog.'), secondPath = join(root, 'second.txt');
  const second = nativeCatalogSource(secondPath, 'Second native catalog.');
  const original = { mode: 'modes', query: 'Inspect native catalogs' };
  retainHarnessCatalogCurrent(original)(first.assertCurrent, 'native catalog');
  let executed = 0, published = 0;
  const inner: Tool = { definition: { name: 'native_catalog_inner', description: 'Read captured native metadata.', parameters: { type: 'object', properties: {} }, sideEffects: [] },
    async execute(input) {
      retainHarnessCatalogCurrent(input)(second.assertCurrent, 'native catalog');
      executed++; writeFileSync(secondPath, 'Retired second native catalog.');
      return { success: true, output: 'Captured native metadata' };
    } };
  const outer: Tool = { definition: { name: 'native_catalog_outer', description: 'Forward the same native read.', parameters: { type: 'object', properties: {} }, sideEffects: [] },
    execute(input, options) { return forwardHarnessCatalogCall(inner, input, { mode: 'modes', query: 'Inspect native catalogs' }, options); } };
  const operation = forwardHarnessCatalogCall(outer, original, { mode: 'modes', query: 'Inspect native catalogs' }).then(value => { published++; return value; });
  await expect(operation).rejects.toBeInstanceOf(ToolInputProjectionError);
  expect(executed).toBe(1); expect(published).toBe(0); first.assertCurrent();
  expect(readFileSync(secondPath, 'utf8')).toBe('Retired second native catalog.');
});
