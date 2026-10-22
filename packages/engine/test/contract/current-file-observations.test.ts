import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentFileObservations } from '../../sdk/src/platform/contract/current-file-observations.js';

test('current native file observations refuse symlinked parents and nested runtime metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'current-file-observation-'));
  try {
    const tree = join(root, 'tree'), outside = join(root, 'outside');
    mkdirSync(tree); mkdirSync(outside);
    writeFileSync(join(outside, 'report.md'), 'OUTSIDE-TREE-CONTENT');
    symlinkSync(outside, join(tree, 'redirect'), 'dir');
    expect(currentFileObservations(tree, ['redirect/report.md'], { includeText: true })).toEqual([]);
    mkdirSync(join(tree, 'nested', '.goodvibes'), { recursive: true });
    writeFileSync(join(tree, 'nested', '.goodvibes', 'private.json'), 'RUNTIME-METADATA');
    expect(currentFileObservations(tree, ['nested/.goodvibes/private.json'], { includeText: true })).toEqual([]);
    writeFileSync(join(tree, 'report.md'), 'The accepted report.');
    expect(currentFileObservations(tree, ['report.md'], { includeText: true })).toMatchObject([
      { success: true, path: 'report.md', text: 'The accepted report.' },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
