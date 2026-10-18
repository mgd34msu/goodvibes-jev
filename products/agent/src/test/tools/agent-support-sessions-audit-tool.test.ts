import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures, researchScreeningFixture, exactSensitiveSpans } from '../helpers/research-screening.ts';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentAuditTool, registerAgentAuditTool } from '../../tools/agent-audit-tool.ts';
import { createAgentSessionsTool, registerAgentSessionsTool } from '../../tools/agent-sessions-tool.ts';
import { createAgentSupportTool, registerAgentSupportTool } from '../../tools/agent-support-tool.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
afterAll(cleanupResearchScreeningFixtures);
function intentPort(index: number, confidence = 0.99) {
  return fakePort((name, question) => name === 'pick' ? choiceAnswer(question, String(index), confidence)
    : noulAnswer(name === `fits_${index}` ? 0.99 : 0.01));
}

function fakeHarness(calls: Record<string, unknown>[]): Tool {
  return {
    definition: {
      name: 'agent_harness',
      description: 'Fake harness',
      parameters: { type: 'object', additionalProperties: true },
    },
    execute: async (args: Record<string, unknown>) => {
      calls.push(args);
      return { success: true, output: JSON.stringify({ args }) };
    },
  };
}

function fakeContext(): CommandContext {
  return {
    workspace: {},
    platform: {
      config: {
        behavior: { autoApprove: false },
        permissions: { mode: 'prompt', tools: {} },
      },
    },
    session: { runtime: {} },
  } as CommandContext;
}

describe('support adapter', () => {
  test('routes bundle catalog and single bundle inspection through the harness', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = createAgentSupportTool({
      commandRegistry: {} as CommandRegistry,
      commandContext: fakeContext(),
      toolRegistry: new ToolRegistry(),
      harnessTool: fakeHarness(calls),
    });

    await tool.execute({ action: 'status', query: 'diagnostics', includeParameters: true });
    await tool.execute({ action: 'bundle', bundlePath: 'support/bundle.json' });

    expect(calls).toEqual([
      { mode: 'support_bundles', query: 'diagnostics', includeParameters: true },
      { mode: 'support_bundle', bundlePath: 'support/bundle.json' },
    ]);
  });

  test('registers once', () => {
    const registry = new ToolRegistry();
    const context = fakeContext();

    registerAgentSupportTool(registry, {} as CommandRegistry, context);
    registerAgentSupportTool(registry, {} as CommandRegistry, context);

    expect(registry.has('support')).toBe(true);
    expect(registry.getToolDefinitions().filter((definition) => definition.name === 'support')).toHaveLength(1);
  });
});

describe('sessions adapter', () => {
  test('routes session list and detail inspection through the harness', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = createAgentSessionsTool({
      commandRegistry: {} as CommandRegistry,
      commandContext: fakeContext(),
      toolRegistry: new ToolRegistry(),
      harnessTool: fakeHarness(calls),
    });

    await tool.execute({ action: 'search', query: 'onboarding', limit: 5 });
    await tool.execute({ action: 'get', sessionId: 'session-123', includeParameters: true });

    expect(calls).toEqual([
      { mode: 'sessions', query: 'onboarding', limit: 5 },
      { mode: 'session', sessionId: 'session-123', includeParameters: true },
    ]);
  });

  test('registers once', () => {
    const registry = new ToolRegistry();
    const context = fakeContext();

    registerAgentSessionsTool(registry, {} as CommandRegistry, context);
    registerAgentSessionsTool(registry, {} as CommandRegistry, context);

    expect(registry.has('sessions')).toBe(true);
    expect(registry.getToolDefinitions().filter((definition) => definition.name === 'sessions')).toHaveLength(1);
  });
});

describe('audit adapter', () => {
  test('routes readiness and evidence surfaces through the harness', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = createAgentAuditTool({
      commandRegistry: {} as CommandRegistry,
      commandContext: fakeContext(),
      toolRegistry: new ToolRegistry(),
      harnessTool: fakeHarness(calls),
    });

    await tool.execute({ action: 'readiness', query: 'gate', includeParameters: true });
    await tool.execute({ action: 'item', itemId: 'route-planning' });
    await tool.execute({ action: 'evidence', query: 'live verification' });
    await tool.execute({ action: 'artifact', artifactId: 'live-verification-json', includeParameters: true });

    expect(calls).toEqual([
      { mode: 'release_readiness', query: 'gate', includeParameters: true },
      { mode: 'release_readiness_item', itemId: 'route-planning' },
      { mode: 'release_evidence', query: 'live verification' },
      { mode: 'release_evidence_artifact', artifactId: 'live-verification-json', includeParameters: true },
    ]);
  });

  test('reads implicit audit intent from the complete protected query', async () => {
    const calls: Record<string, unknown>[] = [];
    const registry = new ToolRegistry(); bindAgentResearchSourceOwner(registry, ordinaryResearchOwner());
    const fake = intentPort(2); installJudgmentPort(fake.port);
    const tool = createAgentAuditTool({ commandRegistry: {} as CommandRegistry, commandContext: fakeContext(), toolRegistry: registry, harnessTool: fakeHarness(calls) });
    const query = 'show the packaged proof that shipped with this release';
    await tool.execute({ query });
    expect(calls).toEqual([{ mode: 'release_evidence', query }]);
    expect(fake.requests).toHaveLength(1);
    expect(JSON.stringify(fake.requests[0]!.state)).toContain(query);
  });

  test('an incidental evidence word follows the reading; explicit actions and ids bypass Jev', async () => {
    const calls: Record<string, unknown>[] = [];
    const registry = new ToolRegistry(); bindAgentResearchSourceOwner(registry, ordinaryResearchOwner());
    const fake = intentPort(0); installJudgmentPort(fake.port);
    const tool = createAgentAuditTool({ commandRegistry: {} as CommandRegistry, commandContext: fakeContext(), toolRegistry: registry, harnessTool: fakeHarness(calls) });
    await tool.execute({ query: 'show overall readiness, not the evidence ledger' });
    await tool.execute({ action: 'evidence', query: 'readiness' });
    await tool.execute({ artifactId: 'artifact-a' });
    expect(calls.map(call => call.mode)).toEqual(['release_readiness', 'release_evidence', 'release_evidence_artifact']);
    expect(fake.requests).toHaveLength(1);
  });

  test('missing ownership, weak readings and unknown explicit actions do not silently choose readiness', async () => {
    const calls: Record<string, unknown>[] = [];
    const registry = new ToolRegistry();
    const tool = createAgentAuditTool({ commandRegistry: {} as CommandRegistry, commandContext: fakeContext(), toolRegistry: registry, harnessTool: fakeHarness(calls) });
    expect((await tool.execute({ query: 'show release proof' })).success).toBe(false);
    bindAgentResearchSourceOwner(registry, ordinaryResearchOwner()); installJudgmentPort(intentPort(2, 0.55).port);
    expect((await tool.execute({ query: 'show release proof' })).success).toBe(false);
    expect((await tool.execute({ action: 'unregistered', query: 'show release proof' })).success).toBe(false);
    expect(calls).toEqual([]);
  });

  test('the full original input is screened and a changed query cannot be forwarded', async () => {
    const calls: Record<string, unknown>[] = [];
    const registry = new ToolRegistry();
    const protectedSource = researchScreeningFixture({ spans: exactSensitiveSpans(['synthetic-private-value']) });
    bindAgentResearchSourceOwner(registry, protectedSource.owner);
    const fake = intentPort(2); installJudgmentPort(fake.port);
    const tool = createAgentAuditTool({ commandRegistry: {} as CommandRegistry, commandContext: fakeContext(), toolRegistry: registry, harnessTool: fakeHarness(calls) });
    expect((await tool.execute({ query: 'show release proof', omittedMetadata: 'synthetic-private-value' })).success).toBe(false);
    expect(fake.requests).toHaveLength(0);
    bindAgentResearchSourceOwner(registry, ordinaryResearchOwner());
    const args = { query: 'show release proof' };
    installJudgmentPort({ model: fake.port.model, ask: async request => { args.query = 'show readiness'; return fake.port.ask(request); } });
    expect((await tool.execute(args)).success).toBe(false);
    expect(calls).toEqual([]);
  });

  test('registers once', () => {
    const registry = new ToolRegistry();
    const context = fakeContext();

    registerAgentAuditTool(registry, {} as CommandRegistry, context);
    registerAgentAuditTool(registry, {} as CommandRegistry, context);

    expect(registry.has('audit')).toBe(true);
    expect(registry.getToolDefinitions().filter((definition) => definition.name === 'audit')).toHaveLength(1);
  });
});
