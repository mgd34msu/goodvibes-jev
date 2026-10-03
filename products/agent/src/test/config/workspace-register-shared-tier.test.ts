/**
 * workspace-register-shared-tier.test.ts
 *
 * The workspace register is shared by three products: this agent reads and
 * writes it directly, the SDK's gateway verb group writes it, and the daemon
 * reads it to decide checkpoint eligibility. It used to sit at
 * `~/.goodvibes/control-plane/`, the unscoped pre-split orphan, which was the
 * wrong address but at least one all three agreed on.
 *
 * Surface-scoping it (which is right for every other store in that directory)
 * is exactly wrong here: it resolves to whichever product is asking, so this
 * agent and the daemon would each get their own register and workspaces
 * registered in one would vanish from the other. It lives in the platform's
 * shared tier instead, `~/.goodvibes/shared/`, home-scoped, no surface root.
 *
 * These pin the two halves of that: writes go to the shared tier, and reads
 * fall back to the pre-split file until the daemon's boot fold has moved it, so
 * an agent updated ahead of the daemon never reports the operator's registered
 * workspaces as gone.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createWorkspaceRegistrationStore,
  sharedWorkspaceRegistrationStorePath,
} from '../../config/workspace-registration.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function shellPathsFor(home: string) {
  return {
    homeDirectory: home,
    resolveUserPath: (...segments: string[]): string => join(home, '.goodvibes', ...segments),
  };
}

describe('the workspace register lives in the shared tier, not this surface', () => {
  test('a registration written here lands in ~/.goodvibes/shared/, under no surface root', async () => {
    const home = makeProjectTempDir('gv-wsreg-shared');
    const project = join(home, 'projects', 'app');
    mkdirSync(project, { recursive: true });

    await createWorkspaceRegistrationStore(shellPathsFor(home)).add(project);

    const sharedPath = join(home, '.goodvibes', 'shared', 'workspace-registrations.json');
    expect(existsSync(sharedPath)).toBe(true);
    expect(readFileSync(sharedPath, 'utf8')).toContain('app');

    // Not under this agent's own root, that is the split this prevents, and
    // not at the pre-split address the daemon's boot fold is clearing out.
    expect(existsSync(join(home, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'control-plane', 'workspace-registrations.json'))).toBe(false);
    expect(existsSync(join(home, '.goodvibes', 'control-plane', 'workspace-registrations.json'))).toBe(false);
  });

  test('a register still at the pre-split address is READ, not reported as empty', async () => {
    // The version-skew window: this agent updated before the daemon booted and
    // folded. Without the read fallback it would report the operator's
    // registered workspaces as gone.
    const home = makeProjectTempDir('gv-wsreg-fallback');
    const project = join(home, 'projects', 'legacy-only');
    mkdirSync(project, { recursive: true });
    const legacyDir = join(home, '.goodvibes', 'control-plane');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'workspace-registrations.json'), JSON.stringify({
      version: 1,
      workspaces: [{ root: project, registeredAt: '2026-01-01T00:00:00.000Z' }],
      declines: [],
    }));

    const shellPaths = shellPathsFor(home);
    expect(sharedWorkspaceRegistrationStorePath(shellPaths))
      .toBe(join(legacyDir, 'workspace-registrations.json'));

    const snapshot = await createWorkspaceRegistrationStore(shellPaths).snapshot();
    expect(snapshot.workspaces.map((row) => row.root)).toContain(project);
  });

  test('once the shared file exists it wins, and a write never goes back to the legacy address', async () => {
    const home = makeProjectTempDir('gv-wsreg-prefers-shared');
    const first = join(home, 'projects', 'first');
    const second = join(home, 'projects', 'second');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    const legacyDir = join(home, '.goodvibes', 'control-plane');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'workspace-registrations.json'), JSON.stringify({
      version: 1,
      workspaces: [{ root: first, registeredAt: '2026-01-01T00:00:00.000Z' }],
      declines: [],
    }));

    const shellPaths = shellPathsFor(home);
    // Registering reads through the fallback and persists to the shared tier,
    // so the pre-split rows come forward rather than being stranded.
    await createWorkspaceRegistrationStore(shellPaths).add(second);

    const sharedPath = join(home, '.goodvibes', 'shared', 'workspace-registrations.json');
    const written = readFileSync(sharedPath, 'utf8');
    expect(written).toContain('first');
    expect(written).toContain('second');

    // Reads now prefer the shared copy, and the legacy file was not written to.
    expect(sharedWorkspaceRegistrationStorePath(shellPaths)).toBe(sharedPath);
    expect(readFileSync(join(legacyDir, 'workspace-registrations.json'), 'utf8')).not.toContain('second');
  });
});
