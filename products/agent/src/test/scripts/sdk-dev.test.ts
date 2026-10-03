// ---------------------------------------------------------------------------
// sdk-dev.test.ts
//
// scripts/sdk-dev.ts is now a thin alias (consolidated from several near-duplicate scripts):
// the overlay lifecycle logic (status states, the devDependencies-first pin
// reader, the restore version-agreement check, workspace-package
// enumeration incl. contracts) moved to the SDK checkout's own
// scripts/sdk-dev.ts and is unit-tested there (goodvibes-sdk/test/sdk-dev-
// tool.test.ts), this is now the ONE place that logic is tested, closing
// the drift the three independently-maintained copies had fallen into.
//
// This file covers what's left in the Agent's copy: the alias's own guard
// clauses (missing checkout, checkout present but stale/missing the tool
// script) and that it actually forwards to the checkout when present. The
// forwarding assertions are skipped when no local SDK checkout exists at the
// resolved path (CI has none, same precedent the pre-consolidation webui
// suite already used for its "real overlay active" case).
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const SCRIPT_PATH = resolve(import.meta.dir, '..', '..', '..', 'scripts/sdk-dev.ts');
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const DEFAULT_SDK_ROOT = resolve(process.env.GOODVIBES_SDK_PATH ?? resolve(homedir(), 'Projects/goodvibes-sdk'));
// Forwarding only succeeds once the checkout HAS the canonical tool (this
// brief's own deliverable), a checkout dir existing without it (e.g. an
// SDK main that hasn't landed the canonical tool yet) must gate the same as "no
// checkout" for these assertions.
const SDK_TOOL_AVAILABLE = existsSync(join(DEFAULT_SDK_ROOT, 'scripts/sdk-dev.ts'));

function run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): { exitCode: number; output: string } {
  const result = Bun.spawnSync(['bun', SCRIPT_PATH, ...args], {
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...opts.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

describe('sdk-dev alias', () => {
  test('fails fast and names the missing checkout when GOODVIBES_SDK_PATH does not exist', () => {
    const dir = makeProjectTempDir('agent-sdk-dev');
    try {
      const missingPath = join(dir, 'does-not-exist');
      const { exitCode, output } = run(['status'], { env: { GOODVIBES_SDK_PATH: missingPath } });
      expect(exitCode).toBe(1);
      expect(output).toContain('local SDK checkout not found');
      expect(output).toContain(missingPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails with a distinct message when the checkout exists but has no scripts/sdk-dev.ts', () => {
    const dir = makeProjectTempDir('agent-sdk-dev');
    try {
      mkdirSync(join(dir, 'scripts'), { recursive: true }); // no sdk-dev.ts inside
      const { exitCode, output } = run(['status'], { env: { GOODVIBES_SDK_PATH: dir } });
      expect(exitCode).toBe(1);
      expect(output).toContain('has no scripts/sdk-dev.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Skipped (not failed) when no local SDK checkout is present at the
  // resolved default path: this is a legitimate CI/sandbox state, not a
  // regression. The substantive status/restore/link behavior is proven once
  // in the SDK's own suite (test/sdk-dev-tool.test.ts) against this exact
  // checkout.
  test.skipIf(!SDK_TOOL_AVAILABLE)('forwards to the canonical SDK tool and reports this repo\'s clean/overlay state', () => {
    const { exitCode, output } = run(['status']);
    // Either state is legitimate depending on whether a `link` session is
    // active locally; both are valid sdk-dev output, proving the forward
    // reached the real tool rather than erroring out.
    expect([0, 2]).toContain(exitCode);
    expect(output).toMatch(/sdk-dev: (clean|OVERLAY ACTIVE)/);
  });

  test('usage message is printed and exit is non-zero for an unknown command', () => {
    // Only meaningful once forwarding succeeds, so gate on the checkout too.
    if (!SDK_TOOL_AVAILABLE) return;
    const { exitCode, output } = run(['bogus']);
    expect(exitCode).toBe(1);
    expect(output).toContain('usage: bun scripts/sdk-dev.ts');
  });
});
