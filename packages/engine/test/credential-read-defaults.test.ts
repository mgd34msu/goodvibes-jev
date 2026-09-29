/**
 * credential-read-defaults.test.ts
 *
 * Whether a read-only tool call touches secret or credential material is
 * Jev's reading (the side-effect battery's `secrets`), not a shipped path
 * list. A read that does is read in full (at least high stakes) and reaches
 * the prompt in the normal preset; one that does not runs; a path is asked
 * once per process.
 */
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

describe('PermissionManager: reads that touch secrets (normal preset)', () => {
  const gateLog = useGateReadings([
    ['id_rsa', { mutates: false, secrets: true, family: 'generic', kind: 'read' }],
    ['hosts.yml', { mutates: false, secrets: true, family: 'generic', kind: 'read' }],
  ]);

  test('a credential read is NOT auto-allowed: Jev reads it (secrets, high stakes) and it reaches the prompt', async () => {
    let prompted = false;
    const manager = new PermissionManager(
      async () => { prompted = true; return { approved: false, remember: false }; },
      makeConfigReader(),
      makePolicyRuntimeState(),
      null,
      null,
    );
    const result = await manager.checkDetailed('read', { path: '/home/alice/.ssh/id_rsa' });
    expect(prompted).toBe(true);
    expect(result.approved).toBe(false);
    expect(result.reading?.stakes).toBe('high');
    expect(gateLog.requests.length).toBeGreaterThan(0);
  });

  test('an ordinary read is asked one question and runs without a prompt', async () => {
    let prompted = false;
    const manager = new PermissionManager(
      async () => { prompted = true; return { approved: false, remember: false }; },
      makeConfigReader(),
      makePolicyRuntimeState(),
      null,
      null,
    );
    const result = await manager.checkDetailed('read', { path: `${WORKSPACE}/src/index.ts` });
    expect(prompted).toBe(false);
    expect(result.approved).toBe(true);
    expect(gateLog.requests).toHaveLength(1); // only the secrets question
    expect(Object.keys(gateLog.requests[0]!.questions ?? {})).toEqual(['secrets']);
  });

  test('an unlisted credential file is read too, and a path is asked once', async () => {
    let prompts = 0;
    const manager = new PermissionManager(
      async () => { prompts += 1; return { approved: false, remember: false }; },
      makeConfigReader(),
      makePolicyRuntimeState(),
      null,
      null,
    );
    const path = '/home/alice/.config/gh/hosts.yml';
    expect((await manager.checkDetailed('read', { path })).approved).toBe(false);
    expect(prompts).toBe(1);
    const secretsOnly = () => gateLog.requests.filter((r) => Object.keys(r.questions ?? {}).join() === 'secrets').length;
    expect(secretsOnly()).toBe(1);
    // The search filter reads the same path the read tool did: remembered, not asked again.
    expect(await manager.readAccess(path)).toBe('restricted');
    expect(await manager.readAccess(path)).toBe('restricted');
    expect(secretsOnly()).toBe(1);
  });
});
