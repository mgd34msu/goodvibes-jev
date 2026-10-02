import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { createAgentRouteTool, registerAgentRouteTool } from '../../tools/agent-route-tool.ts';

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

async function route(query: string, includeParameters = false): Promise<Record<string, unknown>> {
  const tool = createAgentRouteTool(fakeContext());
  const result = await tool.execute({ action: 'plan', query, includeParameters });
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(result.error);
  return JSON.parse(result.output!) as Record<string, unknown>;
}

function preferredId(body: Record<string, unknown>): string {
  const preferred = body.preferred as { readonly id?: unknown };
  return typeof preferred?.id === 'string' ? preferred.id : '';
}

describe('route adapter', () => {
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

  test('routes one-off deep research to the research planner', async () => {
    const body = await route('do deep research on the market map and cite sources');

    expect(preferredId(body)).toBe('deep-research-workflow');
    expect(body.preferred).toMatchObject({
      inspectRoute: 'research action:"briefing"',
      userSurface: 'Research workspace',
    });
  });

  test('routes recurring research reports through visible autonomy intake', async () => {
    const body = await route('run a weekly source-backed research report');

    expect(preferredId(body)).toBe('autonomy-intake');
    expect(body.preferred).toMatchObject({
      modelRoute: 'autonomy action:"intake" query:"run a weekly source-backed research report" includeParameters:true',
      requiresConfirmation: true,
    });
  });

  test('sends a request to act on a web page to the browser tool', async () => {
    // Discoverability: a model asking how to open and act on a page must be
    // pointed at the tool that does it, not at a planner that describes it.
    const body = await route('log in to my account on example.com and download the invoice');

    expect(preferredId(body)).toBe('drive-a-browser');
    expect(body.preferred).toMatchObject({
      modelRoute: 'browser action:"navigate" url:"..."',
      inspectRoute: 'browser action:"status"',
    });
  });

  test('sends a request to fill in a form on a site to the browser tool', async () => {
    const body = await route('fill out the contact form on the website and submit it');

    expect(preferredId(body)).toBe('drive-a-browser');
    expect(body.preferred).toMatchObject({ requiresConfirmation: true });
  });

  test('keeps a screen capture request on the desktop-control planner', async () => {
    // Capturing the screen is desktop control, not browsing.
    const body = await route('take a screenshot of the screen');

    expect(preferredId(body)).not.toBe('drive-a-browser');
  });

  test('routes browser-backed research runner wording to runner readiness', async () => {
    const body = await route('check browser-backed research runner readiness');

    expect(preferredId(body)).toBe('research-browser-runner-readiness');
    expect(body.preferred).toMatchObject({
      modelRoute: 'research action:"runner" query:"check browser-backed research runner readiness" includeParameters:true',
      inspectRoute: 'research action:"runner" includeParameters:true',
      requiresConfirmation: false,
    });
  });

  test('routes visual research report rendering to the report workflow contract', async () => {
    const body = await route('render the visual research report in the browser');

    expect(preferredId(body)).toBe('research-visual-report-workflow');
    expect(body.preferred).toMatchObject({
      modelRoute: 'research action:"plan" query:"render the visual research report in the browser" includeParameters:true',
      inspectRoute: 'research action:"reports" query:"visual report" includeParameters:true',
      requiresConfirmation: true,
    });
  });

  test('routes parallel coding work to delegated build posture', async () => {
    const body = await route('fix the failing tests in parallel');

    expect(preferredId(body)).toBe('delegated-build-work');
    expect(body.preferred).toMatchObject({
      modelRoute: 'delegation action:"status" includeParameters:true',
      requiresConfirmation: true,
    });
  });

  test('routes daemon health checks to connected-host diagnostics', async () => {
    const body = await route('check daemon health');

    expect(preferredId(body)).toBe('host-runtime-diagnostics');
    expect(body.preferred).toMatchObject({
      modelRoute: 'host action:"status" includeParameters:true',
      inspectRoute: 'host action:"capabilities" includeParameters:true',
      requiresConfirmation: false,
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

  test('routes channel setup requests to the setup guide', async () => {
    const body = await route('set up Slack notifications');

    expect(preferredId(body)).toBe('channel-setup-route');
    expect(body.preferred).toMatchObject({
      modelRoute: 'channels action:"setup" target:"slack" includeParameters:true',
      inspectRoute: 'channels action:"triage" includeParameters:true',
      requiresConfirmation: true,
    });
  });

  test('routes channel triage requests to channel triage', async () => {
    const body = await route('triage failed Discord delivery retries');

    expect(preferredId(body)).toBe('channel-triage-route');
    expect(body.preferred).toMatchObject({
      modelRoute: 'channels action:"triage" includeParameters:true',
      inspectRoute: 'channels action:"status" includeParameters:true',
      requiresConfirmation: false,
    });
  });

  test('routes delivery receipt requests to channel history', async () => {
    const body = await route('show recent delivery receipts');

    expect(preferredId(body)).toBe('channel-delivery-receipts');
    expect(body.preferred).toMatchObject({
      modelRoute: 'channels action:"deliveries" limit:10 includeParameters:true',
      inspectRoute: 'channels action:"status" includeParameters:true',
      requiresConfirmation: false,
    });
  });

  test('routes channel sends to a confirmed delivery boundary', async () => {
    const body = await route('send message to Telegram');

    expect(preferredId(body)).toBe('channel-delivery-boundary');
    expect(body.preferred).toMatchObject({
      modelRoute: 'channels action:"channel" target:"telegram" includeParameters:true',
      requiresConfirmation: true,
    });
  });

  test('routes normal settings requests to the first-class settings tool', async () => {
    const body = await route('change the theme setting');

    expect(preferredId(body)).toBe('agent-settings-configuration');
    expect(body.preferred).toMatchObject({
      modelRoute: 'settings action:"list" query:"change the theme setting" includeParameters:true',
      inspectRoute: 'settings action:"list" includeParameters:true',
      requiresConfirmation: true,
    });
  });

  test('routes local model recommendations to the cookbook route', async () => {
    const body = await route('recommend an Ollama model for this laptop');

    expect(preferredId(body)).toBe('local-model-cookbook-route');
    expect(body.preferred).toMatchObject({
      modelRoute: 'models action:"local" query:"recommend an Ollama model for this laptop" includeParameters:true',
      inspectRoute: 'models action:"status" query:"local" includeParameters:true',
      requiresConfirmation: false,
    });
  });

  test('routes local model server checks through the confirmed smoke route', async () => {
    const body = await route('check local model servers');

    expect(preferredId(body)).toBe('local-model-smoke-check');
    expect(body.preferred).toMatchObject({
      modelRoute: 'models action:"smoke" query:"check local model servers" includeParameters:true',
      inspectRoute: 'models action:"local" query:"local server health" includeParameters:true',
      requiresConfirmation: true,
    });
  });

  test('routes provider account setup through provider posture', async () => {
    const body = await route('connect OpenRouter subscription');

    expect(preferredId(body)).toBe('model-provider-account-posture');
    expect(body.preferred).toMatchObject({
      modelRoute: 'models action:"provider" providerId:"openrouter" includeParameters:true',
      inspectRoute: 'models action:"providers" includeParameters:true',
      requiresConfirmation: true,
    });
  });

  test('routes route-fit requests through model route readiness', async () => {
    const body = await route('choose the best model route for long context coding');

    expect(preferredId(body)).toBe('model-route-readiness');
    expect(body.preferred).toMatchObject({
      modelRoute: 'models action:"route" query:"choose the best model route for long context coding" includeParameters:true',
      inspectRoute: 'models action:"status" includeParameters:true',
      requiresConfirmation: false,
    });
  });

  test('routes permission posture questions to security status', async () => {
    const body = await route('show current permissions and approval mode');

    expect(preferredId(body)).toBe('security-permission-status');
    expect(body.preferred).toMatchObject({
      modelRoute: 'security action:"status" query:"show current permissions and approval mode" includeParameters:true',
      inspectRoute: 'security action:"status" includeParameters:true',
      requiresConfirmation: false,
    });
  });

  test('routes blocked-action questions to read-only policy explanation', async () => {
    const body = await route('why was that terminal command blocked');

    expect(preferredId(body)).toBe('security-policy-explanation');
    expect(body.preferred).toMatchObject({
      modelRoute: 'security action:"explain" target:"terminal" toolArgs:{...} includeParameters:true',
      inspectRoute: 'security action:"status" includeParameters:true',
      requiresConfirmation: false,
    });
  });

  test('routes security finding requests to finding inspection', async () => {
    const body = await route('inspect the leaked secret security finding');

    expect(preferredId(body)).toBe('security-finding-inspection');
    expect(body.preferred).toMatchObject({
      modelRoute: 'security action:"finding" target:"inspect the leaked secret security finding" includeParameters:true',
      inspectRoute: 'security action:"status" includeParameters:true',
      requiresConfirmation: false,
    });
  });

  test('does not treat generic market risk research as a security policy question', async () => {
    const body = await route('research market risk with citations');

    expect(preferredId(body)).toBe('deep-research-workflow');
  });

  test('routes support bundle export requests to redacted bundle posture first', async () => {
    const body = await route('export a support bundle for diagnostics');

    expect(preferredId(body)).toBe('support-bundle-route');
    expect(body.preferred).toMatchObject({
      modelRoute: 'support action:"status" query:"export a support bundle for diagnostics" includeParameters:true',
      inspectRoute: 'support action:"status" includeParameters:true',
      requiresConfirmation: true,
    });
  });

  test('routes saved session searches to the session catalog', async () => {
    const body = await route('search saved sessions for the onboarding thread');

    expect(preferredId(body)).toBe('saved-session-route');
    expect(body.preferred).toMatchObject({
      modelRoute: 'sessions action:"list" query:"search saved sessions for the onboarding thread" includeParameters:true',
      inspectRoute: 'sessions action:"list" includeParameters:true',
      requiresConfirmation: false,
    });
  });

  test('routes release readiness questions to the audit inventory', async () => {
    const body = await route('show release readiness inventory');

    expect(preferredId(body)).toBe('release-readiness-route');
    expect(body.preferred).toMatchObject({
      modelRoute: 'audit action:"readiness" query:"show release readiness inventory" includeParameters:true',
      inspectRoute: 'audit action:"readiness" includeParameters:true',
      requiresConfirmation: false,
    });
  });

  test('routes release evidence questions to evidence artifacts', async () => {
    const body = await route('inspect release evidence artifact live verification');

    expect(preferredId(body)).toBe('release-evidence-route');
    expect(body.preferred).toMatchObject({
      modelRoute: 'audit action:"evidence" query:"inspect release evidence artifact live verification" includeParameters:true',
      inspectRoute: 'audit action:"evidence" includeParameters:true',
      requiresConfirmation: false,
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

  test('routes command-shaped background work to local process controls', async () => {
    const body = await route('run pytest -v tests/ in background');

    expect(preferredId(body)).toBe('local-background-process');
    expect(body.preferred).toMatchObject({
      modelRoute: 'execution action:"processes" includeParameters:true',
      inspectRoute: 'execution action:"capabilities"',
      requiresConfirmation: true,
    });
  });

  test('routes interactive terminal and sudo requests to process capability posture first', async () => {
    const body = await route('run claude code with pty=true and handle sudo prompts');

    expect(preferredId(body)).toBe('interactive-process-capability');
    expect(body.preferred).toMatchObject({
      modelRoute: 'execution action:"process_capabilities"',
      inspectRoute: 'setup action:"item" setupItemId:"sudo-execution-posture"',
      requiresConfirmation: true,
    });
  });

  test('does not confuse process documentation wording with stdin process control', async () => {
    const body = await route('write process documentation');

    expect(preferredId(body)).not.toBe('interactive-process-capability');
  });

  test('keeps scheduled background work on visible autonomy intake', async () => {
    const body = await route('run a weekly source-backed research report in background');

    expect(preferredId(body)).toBe('autonomy-intake');
  });

  test('routes file undo requests to recovery inspection', async () => {
    const body = await route('undo the last file edit');

    expect(preferredId(body)).toBe('local-file-recovery');
    expect(body.preferred).toMatchObject({
      modelRoute: 'execution action:"recovery" includeParameters:true',
      inspectRoute: 'execution action:"history" includeParameters:true',
      requiresConfirmation: true,
    });
  });

  test('routes screenshot and browser-control tasks through the computer planner', async () => {
    const body = await route('take a screenshot of the logged-in browser dashboard');

    expect(preferredId(body)).toBe('browser-control-workflow-plan');
    expect(body.preferred).toMatchObject({
      modelRoute: 'computer action:"plan" query:"take a screenshot of the logged-in browser dashboard" includeParameters:true',
      inspectRoute: 'computer action:"control" includeParameters:true',
      requiresConfirmation: true,
    });
  });

  test('routes image generation through confirmed media artifacts', async () => {
    const body = await route('generate an image of a clean product dashboard');

    expect(preferredId(body)).toBe('media-generation-artifact');
    expect(body.preferred).toMatchObject({
      modelRoute: 'device action:"provider" target:"media" includeParameters:true',
      inspectRoute: 'agent_harness mode:"media_posture" includeParameters:true',
      requiresConfirmation: true,
    });
  });

  test('routes voice workflow requests through voice posture', async () => {
    const body = await route('set up push-to-talk and voice memo transcription');

    expect(preferredId(body)).toBe('voice-workflow-posture');
    expect(body.preferred).toMatchObject({
      modelRoute: 'device action:"voice" query:"set up push-to-talk and voice memo transcription" includeParameters:true',
      inspectRoute: 'device action:"voice" includeParameters:true',
      requiresConfirmation: true,
    });
  });

  test('routes TTS provider setup through provider posture', async () => {
    const body = await route('choose a TTS provider for spoken responses');

    expect(preferredId(body)).toBe('tts-provider-posture');
    expect(body.preferred).toMatchObject({
      modelRoute: 'device action:"provider" target:"tts" includeParameters:true',
      inspectRoute: 'device action:"voice" includeParameters:true',
      requiresConfirmation: true,
    });
  });

  test('keeps plain browser-open requests on the Browser/PWA readiness route', async () => {
    const body = await route('open the browser dashboard');

    expect(preferredId(body)).toBe('browser-cockpit-readiness');
    expect(body.preferred).toMatchObject({
      modelRoute: 'computer action:"browser" includeParameters:true',
      inspectRoute: 'workspace action:"surface" surfaceId:"connected-browser-cockpit" includeParameters:true',
      requiresConfirmation: true,
    });
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
    const harness = createAgentHarnessTool({
      commandRegistry: {} as CommandRegistry,
      commandContext: fakeContext(),
      toolRegistry: new ToolRegistry(),
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
