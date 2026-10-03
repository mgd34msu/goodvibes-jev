/**
 * /calendar dispatcher-level tests: the unknown-subcommand usage message
 * (F7b). The subcommand-specific flows (subscribe/connect/import/etc.) are
 * covered in calendar-subscription-runtime.test.ts and calendar-oauth.test.ts;
 * this file only proves the fallback usage line a typo'd or unrecognized
 * subcommand gets.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext } from '../../input/command-registry.ts';
import { runCalendarRuntimeCommand } from '../../input/commands/calendar-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const dirs: string[] = [];
function tmpRoot(): string {
  const dir = makeProjectTempDir(`gv-cal-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

function makeContext(root: string): { ctx: CommandContext; output: () => string } {
  const lines: string[] = [];
  const shellPaths = { resolveUserPath: (_root: string, ...parts: string[]) => join(root, ...parts) };
  const ctx = {
    session: {}, provider: {}, ops: {}, extensions: {}, clients: {},
    workspace: { shellPaths },
    platform: { secretsManager: { get: async () => null, set: async () => {}, delete: async () => {} } },
    print: (t: string) => { lines.push(t); },
    renderRequest: () => {}, exit: () => {},
  } as unknown as CommandContext;
  return { ctx, output: () => lines.join('\n') };
}

describe('/calendar unknown-subcommand usage (F7b)', () => {
  test('replaces the old 13-verb run-on with a short, grouped usage message', async () => {
    const { ctx, output } = makeContext(tmpRoot());
    await runCalendarRuntimeCommand(['not-a-real-subcommand'], ctx);
    const out = output();
    expect(out).toContain('Usage: /calendar <command>');
    expect(out).toContain('Viewing');
    expect(out).toContain('Connecting');
    expect(out).toContain('Subscriptions');
    expect(out).toContain('Local events');
    // Grouped, not the old single 13-verb pipe-separated run-on line.
    expect(out.split('\n').length).toBeGreaterThan(1);
  });
});
