import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkWorkflowDirectory, workflowStructureProblems } from '../scripts/workflow-structure.ts';

const valid = 'name: Check\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n';
test('executing jobs and reusable workflow callers are accepted without executing either', () => {
  expect(workflowStructureProblems(valid)).toEqual([]);
  expect(workflowStructureProblems('name: Check\non: workflow_dispatch\njobs:\n  call:\n    uses: ./.github/workflows/shared.yml\n')).toEqual([]);
});
test('malformed, empty and non-mapping documents refuse', () => {
  for (const text of ['', '[]', 'hello', 'name: [', 'name: Check\non: push\njobs: {}']) {
    expect(workflowStructureProblems(text).length).toBeGreaterThan(0);
  }
});
test('name, on, nonempty jobs, job maps, runs-on and steps are independent requirements', () => {
  for (const text of [valid.replace('name: Check\n', ''), valid.replace('name: Check', 'name: " "'),
    valid.replace('on: push\n', ''), valid.replace('    runs-on: ubuntu-latest\n', ''),
    valid.replace('    steps:\n      - run: echo ok', '    steps: []'),
    'name: Check\non: push\njobs:\n  bad: false']) expect(workflowStructureProblems(text).length).toBeGreaterThan(0);
});
test('all job types reject true and dynamic continue-on-error, while explicit false and step annotations remain allowed', () => {
  for (const body of ['runs-on: ubuntu-latest\n    steps:\n      - run: echo ok', 'uses: ./.github/workflows/shared.yml']) {
    for (const value of ['true', '${{ always() }}']) {
      expect(workflowStructureProblems(`name: Check\non: push\njobs:\n  job:\n    ${body}\n    continue-on-error: ${value}\n`).join()).toContain('continue-on-error');
    }
  }
  expect(workflowStructureProblems(valid + '    continue-on-error: false\n')).toEqual([]);
  expect(workflowStructureProblems(valid + '        continue-on-error: true\n')).toEqual([]);
});
test('directory discovery validates .yaml and .yml and rejects an empty directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-structure-'));
  try {
    expect(checkWorkflowDirectory(dir)).toEqual(['no workflow files found']);
    writeFileSync(join(dir, 'valid.yml'), valid);
    writeFileSync(join(dir, 'invalid.yaml'), '[]');
    writeFileSync(join(dir, 'ignored.txt'), '[]');
    expect(checkWorkflowDirectory(dir)).toEqual(['invalid.yaml: top-level document is not a mapping']);
    writeFileSync(join(dir, 'invalid.yaml'), valid);
    expect(checkWorkflowDirectory(dir)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
