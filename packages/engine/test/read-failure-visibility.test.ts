/**
 * A read whose every requested file fails is a failed operation: it must not
 * surface as a green check with zero returned lines. Partial failures stay a
 * successful operation with per-file diagnostics, and failed operations keep
 * their complete structured output for diagnosis.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectIndex } from '../sdk/src/platform/state/project-index.js';
import { ReadTool } from '../sdk/src/platform/tools/read/index.js';

let root: string;
let index: ProjectIndex;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'read-failure-'));
  writeFileSync(join(root, 'present.ts'), 'export const PRESENT = 1;\n');
  index = new ProjectIndex(root);
});
afterEach(async () => { await index.dispose(); rmSync(root, { recursive: true, force: true }); });

test('a read in which every requested file fails reports failure and retains per-file diagnostics', async () => {
  const tool = new ReadTool(index);
  const result = await tool.execute({ files: [{ path: 'missing-one.ts' }, { path: 'missing-two.ts' }] });
  expect(result.success).toBe(false);
  expect(result.error).toContain('2 requested file reads failed');
  const output = JSON.parse(result.output!);
  expect(output.success).toBe(false);
  expect(output.summary).toMatchObject({ files_read: 0, files_errored: 2 });
  expect(output.files.map((file: { path: string }) => file.path)).toEqual(['missing-one.ts', 'missing-two.ts']);
  for (const file of output.files) expect(typeof file.error).toBe('string');
});

test('a partially failed read stays a successful operation with the failure visible per file', async () => {
  const tool = new ReadTool(index);
  const result = await tool.execute({ files: [{ path: 'present.ts' }, { path: 'missing.ts' }] });
  expect(result.success).toBe(true);
  const output = JSON.parse(result.output!);
  expect(output.success).toBe(true);
  expect(output.summary).toMatchObject({ files_read: 1, files_errored: 1 });
  expect(output.files[0].content).toContain('PRESENT');
  expect(typeof output.files[1].error).toBe('string');
});
