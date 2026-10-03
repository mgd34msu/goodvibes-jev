import { describe, expect, test } from 'bun:test';
import {
  buildSandboxReview,
  listSandboxProfiles,
  type ConfigManagerLike,
} from '@goodvibes-jev/engine/sdk/platform/runtime/sandbox';
import { renderSandboxDoctor } from '../../../runtime/sandbox-public-gaps.ts';

function makeManager(): ConfigManagerLike {
  const values: Record<string, unknown> = {
    'sandbox.replIsolation': 'shared-vm',
    'sandbox.mcpIsolation': 'disabled',
    'sandbox.windowsMode': 'native-basic',
    'sandbox.vmBackend': 'local',
  };
  return {
    get(key: string) {
      if (!(key in values)) throw new Error(`Unexpected config read: ${key}`);
      return values[key];
    },
  };
}

describe('local sandbox public adapter', () => {
  test('review retains profiles and reports only the supported local backend', () => {
    const manager = makeManager();
    const review = buildSandboxReview(manager);
    expect(review.backendProbe?.resolvedBackend).toBe('local');
    expect(review.backendProbe?.backends.map((backend) => backend.id)).toEqual(['local']);
    expect(listSandboxProfiles(manager).map((profile) => profile.id)).toContain('eval-py');
  });

  test('doctor uses declared review state without guest configuration or provisioning', () => {
    const rendered = renderSandboxDoctor(makeManager());
    expect(rendered).toContain('Sandbox doctor');
    expect(rendered).toContain('backend: local');
    expect(rendered).toContain('local: available');
    expect(rendered).toContain('host-local processes; no VM guest');
    expect(rendered).not.toContain('qemu');
  });
});
