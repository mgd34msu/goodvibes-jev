/**
 * remote-capabilities.test.ts
 *
 * The shared-sandbox capability of a remote runner: supported when a write
 * scope path is equal to or under the workspace root the runner contract
 * carries (resolved, normalized paths; a relative scope path is taken relative
 * to the root). It replaced a substring test for `.goodvibes` or `/workspace`
 * anywhere in the path. Also pins that the runner registry puts the runtime's
 * working directory on the contracts it builds.
 */
import { describe, expect, test } from 'bun:test';
import { deriveRemoteCapabilities } from '../sdk/src/platform/runtime/remote/capabilities.ts';
import { RemoteRunnerRegistry } from '../sdk/src/platform/runtime/remote/runner-registry.ts';
import type { RemoteRunnerContract } from '../sdk/src/platform/runtime/remote/types.ts';
import type { AgentRecord } from '../sdk/src/platform/tools/agent/manager.ts';

const ROOT = '/home/dev/projects/shop-api';

function contract(writeScope: readonly string[], workspaceRoot: string | null = ROOT): RemoteRunnerContract {
  return {
    id: 'runner:a1',
    runnerId: 'a1',
    label: 'engineer runner',
    sourceTransport: 'daemon',
    trustClass: 'local-daemon',
    template: 'engineer',
    capabilityCeiling: {
      allowedTools: ['read', 'write'],
      capabilityCeilingTools: ['read', 'write'],
      executionProtocol: 'direct',
      reviewMode: 'none',
      communicationLane: 'parent-only',
      orchestrationDepth: 0,
      successCriteria: [],
      requiredEvidence: [],
      writeScope,
    },
    ...(workspaceRoot === null ? {} : { workspaceRoot }),
    createdAt: 1,
    lastUpdatedAt: 1,
    transport: { state: 'disconnected', messageCount: 0, errorCount: 0 },
  };
}

const sharedSandbox = (value: RemoteRunnerContract): boolean =>
  deriveRemoteCapabilities(value).find((capability) => capability.id === 'shared-sandbox')!.supported;

describe('shared-sandbox support is path containment against the workspace root', () => {
  test('a scope equal to the root, under it, or relative inside it is supported', () => {
    expect(sharedSandbox(contract([ROOT]))).toBe(true);
    expect(sharedSandbox(contract([`${ROOT}/src/routes`]))).toBe(true);
    expect(sharedSandbox(contract(['src/routes/**']))).toBe(true);
    expect(sharedSandbox(contract([`${ROOT}/src/../.goodvibes/state`]))).toBe(true);
  });

  test('a scope outside the root is not, whatever words its path contains', () => {
    // The old substring test said yes to both of these.
    expect(sharedSandbox(contract(['/workspace/other-repo/src']))).toBe(false);
    expect(sharedSandbox(contract(['/home/dev/.goodvibes/cache']))).toBe(false);
    // A sibling whose name starts with the root's name is not under the root.
    expect(sharedSandbox(contract([`${ROOT}-legacy/src`]))).toBe(false);
    expect(sharedSandbox(contract(['../billing-api/src']))).toBe(false);
  });

  test('one scope inside the root is enough', () => {
    expect(sharedSandbox(contract(['/tmp/build-cache', 'docs']))).toBe(true);
  });

  test('no write scope, or no workspace root on the contract, is not supported', () => {
    expect(sharedSandbox(contract([]))).toBe(false);
    expect(sharedSandbox(contract(['src'], null))).toBe(false);
  });
});

describe('the runner registry carries the workspace root', () => {
  test('a contract built for an agent has the root the registry was given', () => {
    const agent = {
      id: 'a1',
      task: 'add a route',
      template: 'engineer',
      tools: ['read', 'write'],
      status: 'running',
      startedAt: 1,
      toolCallCount: 0,
      orchestrationDepth: 0,
      executionProtocol: 'direct',
      reviewMode: 'none',
      communicationLane: 'parent-only',
      writeScope: ['src/routes'],
    } as unknown as AgentRecord;
    const registry = new RemoteRunnerRegistry({ getStatus: () => agent, list: () => [agent] }, ROOT);
    const built = registry.upsertContractForAgent('a1')!;
    expect(built.workspaceRoot).toBe(ROOT);
    expect(sharedSandbox(built)).toBe(true);
  });
});
