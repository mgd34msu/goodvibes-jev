import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandRegistry } from '../../input/command-registry.ts';
import { createAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { createAgentRouteTool, registerAgentRouteTool } from '../../tools/agent-route-tool.ts';
import { useRouteAdapterFixture, fakeContext, route, preferredId, taskRouteSources } from '../helpers/route-adapter-fixture.ts';

useRouteAdapterFixture();

describe("Personal Ops and route adapter contracts", () => {
  test('returns usage without making a routing guess when no task is supplied', async () => {
    const tool = createAgentRouteTool(fakeContext());
    const result = await tool.execute({});

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    const body = JSON.parse(result.output!) as { readonly status: string; readonly usage: string };
    expect(body.status).toBe('ready');
    expect(body.usage).toContain('route action:"plan"');
  });


  test('routes inbox and reply work to Personal Ops intake', async () => {
    const body = await route('triage my inbox and draft replies');

    expect(preferredId(body)).toBe('personal-ops-intake-route');
    expect(body.preferred).toMatchObject({
      modelRoute: 'personal_ops action:"intake" query:"triage my inbox and draft replies" includeParameters:true',
      userSurface: 'Personal Ops workspace',
    });
  });


  test('routes daily briefing requests to Personal Ops briefing', async () => {
    const body = await route('brief my calendar for today');

    expect(preferredId(body)).toBe('personal-ops-daily-briefing');
    expect(body.preferred).toMatchObject({
      modelRoute: 'personal_ops action:"briefing" query:"brief my calendar for today" includeParameters:true',
      inspectRoute: 'personal_ops action:"status" includeParameters:true',
      requiresConfirmation: false,
    });
  });


  test('routes saved personal review queues to queue inspection', async () => {
    const body = await route('show my saved inbox review queue');

    expect(preferredId(body)).toBe('personal-ops-review-queue');
    expect(body.preferred).toMatchObject({
      modelRoute: 'personal_ops action:"queue" query:"inbox" includeParameters:true',
      inspectRoute: 'personal_ops action:"lane" laneId:"inbox" includeParameters:true',
      requiresConfirmation: false,
    });
  });


  test('routes live Gmail refresh requests to a confirmed fresh-read plan', async () => {
    const body = await route('refresh my Gmail inbox');

    expect(preferredId(body)).toBe('personal-ops-fresh-read-plan');
    expect(body.preferred).toMatchObject({
      modelRoute: 'personal_ops action:"intake" query:"refresh my Gmail inbox" includeParameters:true',
      inspectRoute: 'personal_ops action:"lane" laneId:"inbox" includeParameters:true',
      requiresConfirmation: true,
    });
  });


  test('routes direct reminder requests through the schedule tool', async () => {
    const body = await route('remind me tomorrow to stretch');

    expect(preferredId(body)).toBe('direct-schedule-route');
    expect(body.preferred).toMatchObject({
      modelRoute: 'schedule action:"list" query:"remind me tomorrow to stretch" limit:5',
      inspectRoute: 'schedule action:"list"',
      requiresConfirmation: true,
    });
  });


  test('routes named external memory providers to provider posture', async () => {
    const body = await route('connect Supermemory as an external memory provider');

    expect(preferredId(body)).toBe('external-memory-provider-posture');
    expect(body.preferred).toMatchObject({
      modelRoute: 'memory action:"provider" providerId:"supermemory" includeParameters:true',
      inspectRoute: 'host action:"capability" query:"supermemory memory provider"',
      requiresConfirmation: true,
    });
  });


  test('routes generic external memory setup to the memory provider contract checklist', async () => {
    const body = await route('set up cross-session memory sync');

    expect(preferredId(body)).toBe('external-memory-provider-posture');
    expect(body.preferred).toMatchObject({
      modelRoute: 'memory action:"status" query:"external memory provider" includeParameters:true',
      requiresConfirmation: true,
    });
  });


  test('keeps scheduled background work on visible autonomy intake', async () => {
    const body = await route('run a weekly source-backed research report in background');

    expect(preferredId(body)).toBe('autonomy-intake');
  });


  test('returns catalog matches and scores only when parameters are requested', async () => {
    const compact = await route('compare models for this document');
    const compactPreferred = compact.preferred as { readonly score?: number };
    expect(compactPreferred.score).toBeUndefined();

    const detailed = await route('compare models for this document', true);
    const detailedPreferred = detailed.preferred as { readonly score?: number };
    expect(detailedPreferred.score).toBeGreaterThan(0);
    expect((detailed.workspaceMatches as readonly unknown[]).length).toBeGreaterThan(0);
    expect((detailed.harnessModeMatches as readonly unknown[]).length).toBeGreaterThan(0);
  });


  test('exposes the same planner through agent_harness route_decision', async () => {
    const context = fakeContext();
    const harness = createAgentHarnessTool({
      commandRegistry: {} as CommandRegistry,
      commandContext: context,
      toolRegistry: context.extensions.toolRegistry,
      taskRouteSources,
    });
    const result = await harness.execute({ mode: 'route_decision', query: 'set up ollama local model' });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    const body = JSON.parse(result.output!) as Record<string, unknown>;
    expect(preferredId(body)).toBe('local-model-cookbook-route');
  });


  test('registers the direct route adapter once', () => {
    const registry = new ToolRegistry();

    registerAgentRouteTool(registry, fakeContext());
    registerAgentRouteTool(registry, fakeContext());

    expect(registry.has('route')).toBe(true);
    expect(registry.getToolDefinitions().filter((definition) => definition.name === 'route')).toHaveLength(1);
  });
});

describe('route plan completeness', () => {
  test('says how many routes it ranked, and flags a plan that shows only the top few', async () => {
    const tool = createAgentRouteTool(fakeContext());
    const result = await tool.execute({ action: 'plan', query: 'triage my inbox and draft replies', limit: 1 });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    const body = JSON.parse(result.output!) as {
      readonly alternatives: readonly unknown[];
      readonly routesConsidered: number;
      readonly note?: string;
    };

    expect(body.alternatives).toHaveLength(0);
    expect(body.routesConsidered).toBeGreaterThan(1);
    expect(body.note).toContain(`of ${body.routesConsidered} candidate routes`);
  });

  test('a plan that shows every ranked route makes no partial claim', async () => {
    const tool = createAgentRouteTool(fakeContext());
    const result = await tool.execute({ action: 'plan', query: 'triage my inbox and draft replies', limit: 500 });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    const body = JSON.parse(result.output!) as {
      readonly alternatives: readonly unknown[];
      readonly routesConsidered: number;
      readonly note?: string;
    };

    expect(body.alternatives.length + 1).toBe(body.routesConsidered);
    expect(body.note).toBeUndefined();
  });
});
