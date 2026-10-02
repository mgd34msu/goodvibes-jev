import { describe, expect, test } from 'bun:test';
import { createAgentRuntimeProfile, setAgentRuntimeProfileSelection } from '../../agent/runtime-profile.ts';
import { resolveShellEntrypointOwnership } from '../../cli/entrypoint.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeRoots() {
  const root = makeProjectTempDir('goodvibes-agent-entrypoint-profile');
  return {
    defaultWorkingDirectory: root,
    homeDirectory: root,
  };
}

describe('shell entrypoint profile ownership', () => {
  test('uses selected default profile for plain launches', () => {
    const roots = makeRoots();
    const profile = createAgentRuntimeProfile(roots.homeDirectory, 'Research Desk', { templateId: 'research' });
    setAgentRuntimeProfileSelection(roots.homeDirectory, 'research-desk');

    const ownership = resolveShellEntrypointOwnership(roots);

    expect(ownership.homeDirectory).toBe(profile.homeDirectory);
    expect(ownership.workingDirectory).toBe(roots.defaultWorkingDirectory);
  });

  test('explicit agent profile overrides the selected default profile', () => {
    const roots = makeRoots();
    createAgentRuntimeProfile(roots.homeDirectory, 'Research Desk', { templateId: 'research' });
    const ops = createAgentRuntimeProfile(roots.homeDirectory, 'Operations', { templateId: 'operations' });
    setAgentRuntimeProfileSelection(roots.homeDirectory, 'research-desk');

    const ownership = resolveShellEntrypointOwnership(roots, undefined, {
      agentProfile: 'operations',
      useSelectedProfile: true,
    });

    expect(ownership.homeDirectory).toBe(ops.homeDirectory);
  });

  test('profile management commands can opt out of selected default profile resolution', () => {
    const roots = makeRoots();
    createAgentRuntimeProfile(roots.homeDirectory, 'Research Desk', { templateId: 'research' });
    setAgentRuntimeProfileSelection(roots.homeDirectory, 'research-desk');

    const ownership = resolveShellEntrypointOwnership(roots, undefined, {
      useSelectedProfile: false,
    });

    expect(ownership.homeDirectory).toBe(roots.homeDirectory);
  });
});
