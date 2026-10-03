/**
 * capability-advertisement-availability.test.ts
 *
 * Capability-advertisement honesty, agent side: proves the two
 * capability-surfacing seams degrade honestly for a method that is
 * structurally unavailable to the model's HTTP-based operator tool.
 *
 * channels.inbox.list (the previous hardcoded example here) became a
 * genuinely REST-served, invokable method in the 2.0.0 operator contract,
 * so it can no longer stand in for "unavailable." The unavailable example
 * is now picked DYNAMICALLY: the first method (by id) in the live operator
 * contract with no `http` transport binding, a ws-only method such as
 * `sessions.hosted.*` or `acp.agents.list`, because agent_operator_method
 * only ever calls over HTTP (see agent-operator-method-tool.ts's
 * prepareOperatorRoute). If the contract ever stops publishing any ws-only
 * method, the scan below fails loudly rather than silently passing against
 * a stale id.
 *
 * A ws-only method surfaces two different, both-honest degradations rather
 * than one:
 *
 * 1. Discovery (agent-harness-operator-methods.ts): its catalog is built
 *    only from contract methods that carry an `http` route, so a ws-only
 *    method is never advertised at all, operator_methods/operator_method
 *    never offer it as a callable option in the first place, which is a
 *    stronger honesty guarantee than advertising it and marking it
 *    unavailable.
 * 2. Execution (agent-operator-method-tool.ts): agent_operator_method's own
 *    method catalog is NOT filtered by transport, so it does resolve the
 *    id, but prepareOperatorRoute refuses before any fetch because the
 *    method carries no http method/path to build a request from, the
 *    model must not be handed a tool it cannot call as if it were live.
 * 3. Regression guard: genuinely-served methods (automation.schedules.create,
 *    channels.drafts.save, the email.* family) must still render as available
 *    and stay callable through the same paths, the degradation must not cry
 *    wolf on live capabilities.
 *
 * No real daemon runs here, the execution test proves the refusal happens
 * before any fetch is attempted, so it never touches a control-plane port.
 */

import { describe, expect, test } from 'bun:test';
import { getOperatorContract } from '@goodvibes-jev/engine/sdk/contracts';
import { createAgentOperatorMethodTool } from '../../tools/agent-operator-method-tool.ts';
import {
  describeHarnessOperatorMethod,
  operatorMethodSummary,
} from '../../tools/agent-harness-operator-methods.ts';

/**
 * The first (by id) ws-only method in the live operator contract: no
 * `http` entry in its transport list, so it has no REST binding at all.
 * Picked dynamically so this suite tracks the published contract instead
 * of a hardcoded id that can quietly become available (as channels.inbox.list
 * did in 2.0.0). Fails loudly, never silently, if the contract stops
 * publishing any ws-only method.
 */
function firstWsOnlyMethodId(): string {
  const contract = getOperatorContract();
  const methods = Array.isArray(contract.operator?.methods)
    ? contract.operator.methods as readonly { readonly id: string; readonly transport?: readonly string[] }[]
    : [];
  const wsOnlyIds = methods
    .filter((method) => method.id && !(method.transport ?? []).includes('http'))
    .map((method) => method.id)
    .sort((left, right) => left.localeCompare(right));
  const first = wsOnlyIds[0];
  if (!first) {
    throw new Error('no ws-only method exists to exercise the unavailable path; rewrite this test');
  }
  return first;
}

function makeShellPaths(root: string) {
  return {
    workingDirectory: root,
    homeDirectory: root,
    resolveProjectPath: (...parts: string[]) => [root, '.goodvibes', ...parts].join('/'),
    resolveUserPath: (...parts: string[]) => [root, '.goodvibes', ...parts].join('/'),
    resolveWorkspacePath: (...parts: string[]) => [root, ...parts].join('/'),
    isWithinWorkingDirectory: (path: string) => path.startsWith(root),
  };
}

function makeConfigManager(overrides: Record<string, unknown> = {}) {
  return { get: (key: string) => overrides[key] };
}

describe('capability-advertisement honesty (agent side)', () => {
  test('discovery: a ws-only method with no REST binding is never advertised as a live capability', () => {
    const unavailableMethodId = firstWsOnlyMethodId();
    const summary = operatorMethodSummary({ query: unavailableMethodId });
    const methods = summary.methods as readonly Record<string, unknown>[];
    const match = methods.find((method) => method.id === unavailableMethodId);
    // The discovery catalog is built only from contract methods that carry
    // an http route (agent-harness-operator-methods.ts's
    // operatorContractMethods filters on method.http.method/path), so a
    // ws-only method is not offered as an option at all, never advertised,
    // rather than advertised-and-marked-unavailable.
    expect(match).toBeUndefined();
  });

  test('discovery: operator_method lookup for a ws-only method reports it unknown rather than offering a false route', () => {
    const unavailableMethodId = firstWsOnlyMethodId();
    const resolution = describeHarnessOperatorMethod({ methodId: unavailableMethodId });
    expect(resolution.status).toBe('missing_lookup');
    if (resolution.status !== 'missing_lookup') throw new Error('expected missing_lookup');
    expect(resolution.usage).toContain(unavailableMethodId);
    expect(resolution.usage).toContain('host action:"methods"');
  });

  test('discovery: a genuinely-served method (automation.schedules.create) still renders as available', () => {
    const resolution = describeHarnessOperatorMethod({ methodId: 'automation.schedules.create' });
    expect(resolution.status).toBe('found');
    if (resolution.status !== 'found') throw new Error('expected found');
    expect(resolution.method.available).toBe(true);
    expect(String(resolution.method.label)).not.toContain('unavailable');
  });

  test('execution: agent_operator_method refuses a ws-only method honestly, without attempting a network call', async () => {
    const unavailableMethodId = firstWsOnlyMethodId();
    const shellPaths = makeShellPaths('/tmp/capability-advertisement-availability-test-root');
    const configManager = makeConfigManager({ 'controlPlane.host': '127.0.0.1', 'controlPlane.port': 4444 });
    const tool = createAgentOperatorMethodTool(shellPaths as never, configManager);

    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalled = true;
      throw new Error(`unexpected network call in a capability-availability test: ${String(args[0])}`);
    }) as unknown as typeof fetch;

    try {
      // agent-operator-method-tool.ts's own method catalog is not filtered
      // by transport, so it resolves the id, but prepareOperatorRoute
      // refuses before any fetch because the method carries no http
      // method/path to build a request from.
      const result = await tool.execute({ methodId: unavailableMethodId });
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain(unavailableMethodId);
      expect(String(result.error)).toContain('not invokable over HTTP');
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('execution: dryRun preview for a ws-only method still refuses before building a route preview', async () => {
    const unavailableMethodId = firstWsOnlyMethodId();
    const shellPaths = makeShellPaths('/tmp/capability-advertisement-availability-test-root-2');
    const configManager = makeConfigManager();
    const tool = createAgentOperatorMethodTool(shellPaths as never, configManager);

    const result = await tool.execute({ methodId: unavailableMethodId, dryRun: true });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain(unavailableMethodId);
    expect(String(result.error)).toContain('not invokable over HTTP');
  });

  /**
   * The other direction, and the reason the methods above had to change.
   *
   * email.* was the original subject of this test precisely BECAUSE nothing
   * served it. The IMAP/SMTP service is platform capability now
   * (@goodvibes-jev/engine/sdk/platform/email) and the daemon attaches a real
   * handler to each id (platform/control-plane/routes/email.ts), so these are
   * live routes. Asserting that here is what stops the degradation logic from
   * quietly going on describing them as broken after they were fixed.
   */
  test('discovery: the email methods the daemon now serves render as live, not degraded', () => {
    for (const methodId of ['email.inbox.list', 'email.inbox.read', 'email.send', 'email.draft.create']) {
      const resolution = describeHarnessOperatorMethod({ methodId });
      expect(resolution.status, `${methodId} should be catalogued`).toBe('found');
      if (resolution.status !== 'found') throw new Error('expected found');
      expect(resolution.method.available, `${methodId} is served by the daemon now`).toBe(true);
      expect(String(resolution.method.label)).not.toContain('unavailable');
    }
  });

  /**
   * channels.drafts.save (and the rest of the channels.drafts.* family) was
   * this test's other unavailable example until the daemon attached a real
   * route behind it. channels.inbox.list is the one channels.* method still
   * without a served route (see the file header), so it carries that role now.
   * Asserting the drafts family here catches the same staleness if it recurs.
   */
  test('discovery: the channels drafts methods the daemon now serves render as live, not degraded', () => {
    for (const methodId of ['channels.drafts.save', 'channels.drafts.get', 'channels.drafts.list', 'channels.drafts.delete']) {
      const resolution = describeHarnessOperatorMethod({ methodId });
      expect(resolution.status, `${methodId} should be catalogued`).toBe('found');
      if (resolution.status !== 'found') throw new Error('expected found');
      expect(resolution.method.available, `${methodId} is served by the daemon now`).toBe(true);
      expect(String(resolution.method.label)).not.toContain('unavailable');
    }
  });
});
