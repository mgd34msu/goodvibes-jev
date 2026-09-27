/**
 * The repl tool with local host execution as the only sandbox backend.
 *
 * Local execution runs a command directly on the host and does not isolate it,
 * so every eval path refuses before running anything, with one fixed message.
 * What still happens: the sandbox session for the runtime's eval profile starts
 * (and runs no command in it), the attempt lands in the runtime-tagged history
 * with the refusal as its error, history mode reads the file back, and a
 * workspaceRoot is required.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { SandboxSessionRegistry } from '../sdk/src/platform/runtime/sandbox/session-registry.ts';
import { createReplTool, REPL_NO_ISOLATING_BACKEND_ERROR } from '../sdk/src/platform/tools/repl/index.ts';
import { REPL_TOOL_SCHEMA } from '../sdk/src/platform/tools/repl/schema.ts';
import type { Tool } from '../sdk/src/platform/types/tools.ts';

const EXPECTED_REFUSAL =
  'REPL eval needs an isolating sandbox backend, and none is available: the only sandbox backend is local host execution (sandbox.vmBackend "local"), which does not isolate evaluated code.';

let workspaceRoot = '';
let registry: SandboxSessionRegistry;
let replTool: Tool;

function withWorkspace(input: Record<string, unknown>): Record<string, unknown> {
  return { workspaceRoot, ...input };
}

function historyPath(): string {
  return join(workspaceRoot, '.goodvibes', 'tui', 'repl-history.json');
}

beforeEach(() => {
  workspaceRoot = makeProjectTempDir('goodvibes-repl-');
  const configManager = new ConfigManager({ configDir: join(workspaceRoot, 'config') });
  registry = new SandboxSessionRegistry(workspaceRoot);
  replTool = createReplTool(configManager, registry, { surfaceRoot: 'tui' });
});

const RUNTIMES = [
  { runtime: 'javascript', expression: '1 + 2', profileId: 'eval-js' },
  { runtime: 'typescript', expression: 'const value: number = 4; value * 2;', profileId: 'eval-ts' },
  { runtime: 'python', expression: '[x * 2 for x in range(3)]', profileId: 'eval-py' },
  { runtime: 'sql', expression: 'select value from sandbox_eval order by id;', profileId: 'eval-sql' },
  { runtime: 'graphql', expression: 'query Viewer { viewer { id name } }', profileId: 'eval-graphql' },
] as const;

describe('repl tool', () => {
  test('the refusal is the fixed message the tool exports', () => {
    expect(REPL_NO_ISOLATING_BACKEND_ERROR).toBe(EXPECTED_REFUSAL);
  });

  for (const { runtime, expression, profileId } of RUNTIMES) {
    test(`${runtime} eval refuses with the exact message and starts one ${profileId} session that runs nothing`, async () => {
      const result = await replTool.execute(withWorkspace({ mode: 'eval', runtime, expression }));
      expect(result.success).toBe(false);
      expect(result.error).toBe(EXPECTED_REFUSAL);
      const sessions = registry.list();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.profileId).toBe(profileId);
      expect(sessions[0]?.label).toBe(`repl:${runtime}`);
      expect(sessions[0]?.executionCount).toBeUndefined();
    });
  }

  test('eval defaults to javascript: one eval-js session labelled repl:javascript with no execution', async () => {
    const result = await replTool.execute(withWorkspace({ mode: 'eval', expression: '21 + 21' }));
    expect(result.error).toBe(EXPECTED_REFUSAL);
    const sessions = registry.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.profileId).toBe('eval-js');
    expect(sessions[0]?.label).toBe('repl:javascript');
    expect(sessions[0]?.executionCount).toBeUndefined();
  });

  test('evaluated code never runs on the host', async () => {
    const jsMarker = join(workspaceRoot, 'js-ran');
    const pyMarker = join(workspaceRoot, 'py-ran');
    await replTool.execute(withWorkspace({
      mode: 'eval',
      runtime: 'javascript',
      expression: `require('node:fs').writeFileSync(${JSON.stringify(jsMarker)}, 'x')`,
    }));
    await replTool.execute(withWorkspace({
      mode: 'eval',
      runtime: 'python',
      expression: `open(${JSON.stringify(pyMarker)}, 'w').write('x')`,
    }));
    expect(existsSync(jsMarker)).toBe(false);
    expect(existsSync(pyMarker)).toBe(false);
  });

  test('records runtime-tagged history entries carrying the refusal', async () => {
    await replTool.execute(withWorkspace({ mode: 'eval', runtime: 'javascript', expression: '7 * 6' }));
    await replTool.execute(withWorkspace({ mode: 'eval', runtime: 'sql', expression: 'select 1;' }));
    expect(existsSync(historyPath())).toBe(true);
    const onDisk = JSON.parse(readFileSync(historyPath(), 'utf-8')) as Array<Record<string, unknown>>;
    const sessionIds = registry.list().map((session) => session.id).sort();
    expect(onDisk.map((entry) => [entry.runtime, entry.expression, entry.error, entry.backend])).toEqual([
      ['javascript', '7 * 6', EXPECTED_REFUSAL, 'local'],
      ['sql', 'select 1;', EXPECTED_REFUSAL, 'local'],
    ]);
    expect(onDisk.every((entry) => entry.result === undefined)).toBe(true);
    expect(onDisk.map((entry) => entry.sessionId).sort()).toEqual(sessionIds);
  });

  test('history mode returns the recorded attempts', async () => {
    const empty = await replTool.execute(withWorkspace({ mode: 'history' }));
    expect(empty).toEqual({ success: true, output: JSON.stringify({ count: 0, history: [] }) });
    await replTool.execute(withWorkspace({ mode: 'eval', runtime: 'javascript', expression: '7 * 6' }));
    const history = await replTool.execute(withWorkspace({ mode: 'history' }));
    expect(history.success).toBe(true);
    const parsed = JSON.parse(history.output ?? '') as { count: number; history: Array<Record<string, unknown>> };
    expect(parsed.count).toBe(1);
    expect(parsed.history[0]).toMatchObject({ runtime: 'javascript', expression: '7 * 6', error: EXPECTED_REFUSAL });
    expect(history.output).toContain('"runtime":"javascript"');
  });

  test('requires an explicit workspace root', async () => {
    const result = await replTool.execute({ mode: 'history' });
    expect(result).toEqual({ success: false, error: 'repl requires workspaceRoot.' });
    expect(registry.list()).toHaveLength(0);
  });

  test('eval without an expression starts no session and records nothing', async () => {
    const result = await replTool.execute(withWorkspace({ mode: 'eval', runtime: 'javascript' }));
    expect(result).toEqual({ success: false, error: 'eval requires expression.' });
    expect(registry.list()).toHaveLength(0);
    expect(existsSync(historyPath())).toBe(false);
  });

  test('the tool definition keeps its name and parameter schema', () => {
    expect(replTool.definition.name).toBe('repl');
    expect(replTool.definition.parameters).toBe(REPL_TOOL_SCHEMA.parameters);
    expect(replTool.definition.description).toBe(REPL_TOOL_SCHEMA.description);
  });
});
