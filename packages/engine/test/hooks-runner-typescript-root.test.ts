/**
 * The TypeScript hook runner loads a module only from inside the project
 * directory, judged on real paths: a symlink inside the project that points
 * outside it is refused, as a plain path outside it is.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../sdk/src/platform/hooks/runners/typescript.ts';
import type { HookDefinition, HookEvent } from '../sdk/src/platform/hooks/types.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const HOOK = "export default () => ({ ok: true, decision: 'allow' });\n";
const event = { path: 'Pre:tool:read', phase: 'Pre', category: 'tool', specific: 'read', sessionId: 's', timestamp: 0, payload: {} } as unknown as HookEvent;

function layout(): { project: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), 'gv-ts-hook-'));
  roots.push(base);
  const project = join(base, 'project');
  const outside = join(base, 'outside');
  mkdirSync(join(project, 'hooks'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(project, 'hooks', 'inside.ts'), HOOK);
  writeFileSync(join(outside, 'escape.ts'), HOOK);
  symlinkSync(join(outside, 'escape.ts'), join(project, 'hooks', 'link.ts'));
  return { project, outside };
}

function hook(path: string): HookDefinition {
  return { match: 'Pre:tool:read', type: 'ts', path } as HookDefinition;
}

describe('ts hook containment', () => {
  test('a module inside the project runs', async () => {
    const { project } = layout();
    expect(await run(hook('hooks/inside.ts'), event, project)).toMatchObject({ ok: true });
  });

  test('a symlink inside the project pointing outside it is refused', async () => {
    const { project } = layout();
    const result = await run(hook('hooks/link.ts'), event, project);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('outside the project directory');
  });

  test('a relative path climbing out of the project is refused', async () => {
    const { project } = layout();
    const result = await run(hook('../outside/escape.ts'), event, project);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('outside the project directory');
  });
});
