import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager, isEffectiveDangerMode } from '../sdk/src/platform/config/index.js';
import { ProjectIndex } from '../sdk/src/platform/state/project-index.js';
import { ReadTool } from '../sdk/src/platform/tools/read/index.js';
import { createFindTool } from '../sdk/src/platform/tools/find/executor.js';
import { createRepoMapTool } from '../sdk/src/platform/tools/repo-map/index.js';

let previous: ReturnType<typeof installJudgmentPort>;
let root: string;
let workspace: string;
let sibling: string;
let index: ProjectIndex;
let config: ConfigManager;
beforeEach(() => {
  previous = installJudgmentPort(fakePort(() => noulAnswer(0.001)).port);
  root = mkdtempSync(join(tmpdir(), 'external-read-'));
  workspace = join(root, 'workspace'); sibling = join(root, 'sibling');
  mkdirSync(workspace); mkdirSync(sibling); mkdirSync(join(root, 'home'));
  writeFileSync(join(workspace, 'local.ts'), 'export const LOCAL_ONLY = 1;\n');
  writeFileSync(join(sibling, 'external.ts'), 'export const EXTERNAL_RESULT = 7;\n');
  symlinkSync(sibling, join(workspace, 'linked'));
  config = new ConfigManager({ surfaceRoot: 'tui', workingDir: workspace, homeDir: join(root, 'home') });
  config.set('permissions.mode', 'prompt'); config.set('behavior.autoApprove', false);
  index = new ProjectIndex(workspace);
});
afterEach(async () => { installJudgmentPort(previous); await index.dispose(); rmSync(root, { recursive: true, force: true }); });
const allowsOutside = () => isEffectiveDangerMode(config);

test.each(['behavior.autoApprove', 'permissions.mode'] as const)('%s permits sibling reads, pagination and aliases, and revocation applies to the next read', async key => {
  const tool = new ReadTool(index, undefined, undefined, undefined, allowsOutside);
  const paths = ['../sibling/external.ts', join(sibling, 'external.ts'), 'linked/external.ts'];
  for (const path of paths) {
    const blocked = await tool.execute({ files: [{ path }] });
    expect(JSON.parse(blocked.output!).files[0].error).toContain('outside the project root');
  }
  if (key === 'behavior.autoApprove') config.set(key, true); else config.set(key, 'allow-all');
  for (const path of paths) {
    const result = await tool.execute({ files: [{ path }], token_budget: 10, output: { include_line_numbers: false } });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output!).files[0].content).toContain('export const EXTERNAL_RESULT = 7;');
  }
  expect(index.getFile(join(sibling, 'external.ts'))).toBeNull();
  if (key === 'behavior.autoApprove') config.set(key, false); else config.set(key, 'prompt');
  const blocked = await tool.execute({ files: [{ path: paths[0] }] });
  expect(JSON.parse(blocked.output!).files[0].error).toContain('outside the project root');
});

test('auto mode lists and searches the requested sibling and maps its own exports', async () => {
  writeFileSync(join(sibling, '.gitignore'), 'ignored.ts\n');
  writeFileSync(join(sibling, 'ignored.ts'), 'export const IGNORED = 9;\n');
  const find = createFindTool(workspace, undefined, undefined, undefined, undefined, allowsOutside);
  const args = { queries: [{ id: 'listing', mode: 'files', path: sibling, patterns: ['**/*.ts'] }], output: { format: 'files_only' } };
  expect(JSON.parse((await find.execute(args)).output!).listing.error).toContain('outside the project root');
  config.set('permissions.mode', 'allow-all');
  const listed = JSON.parse((await find.execute(args)).output!).listing;
  expect(listed.files).toEqual([join(sibling, 'external.ts')]);
  const searched = await find.execute({ queries: [{ id: 'content', mode: 'content', path: sibling, pattern: 'EXTERNAL_RESULT', glob: '*.ts' }] });
  expect(JSON.parse(searched.output!).content.matches[0].text).toContain('EXTERNAL_RESULT');
  const symbols = await find.execute({ queries: [{ id: 'symbols', mode: 'symbols', path: sibling, query: 'EXTERNAL_RESULT' }] });
  expect(symbols.success).toBe(true); expect(symbols.output).toContain('EXTERNAL_RESULT');
  const map = createRepoMapTool({ projectRoot: workspace, allowOutsideProject: allowsOutside });
  const mapped = await map.execute({ path: sibling });
  expect(mapped.success).toBe(true); expect(mapped.output).toContain('EXTERNAL_RESULT'); expect(mapped.output).not.toContain('LOCAL_ONLY');
  config.set('permissions.mode', 'prompt');
  expect(JSON.parse((await find.execute(args)).output!).listing.error).toContain('outside the project root');
  expect((await map.execute({ path: sibling })).success).toBe(false);
});
