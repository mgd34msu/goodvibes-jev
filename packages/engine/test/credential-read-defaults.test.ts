import { describe, expect, test } from 'bun:test';
import { useGateReadings } from './_helpers/gate-readings.ts';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.ts';
import type { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';

const WORKSPACE = '/tmp/gv-cred-read-workspace';

function makeConfigReader(): PermissionConfigReader {
  return {
    isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => WORKSPACE,
    getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }),
  } as unknown as PermissionConfigReader;
}

function makePolicyRuntimeState(): Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'> {
  return {
    recordPermissionRequest: () => {},
    recordPermissionDecision: () => {},
    getRegistry: () => ({ getCurrent: () => undefined }) as unknown as ReturnType<PolicyRuntimeState['getRegistry']>,
  };
}

describe('read access uses owner rules without per-path permission readings', () => {
  const gateLog = useGateReadings();
  test.each(['/home/alice/.ssh/id_rsa', `${WORKSPACE}/src/index.ts`, '/home/alice/.config/gh/hosts.yml'])('does not infer authority from %s', async path => {
    let prompts = 0;
    const manager = new PermissionManager(async () => { prompts++; return { approved: false }; }, makeConfigReader(), makePolicyRuntimeState(), null, null);
    expect(await manager.checkDetailed('read', { path })).toMatchObject({ approved: true, sourceLayer: 'config_policy' });
    expect(await manager.readAccess(path)).toBe('allow');
    expect(prompts).toBe(0);
    expect(gateLog.requests).toEqual([]);
  });
});
