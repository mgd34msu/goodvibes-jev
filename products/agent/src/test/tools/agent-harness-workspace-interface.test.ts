import { cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import { resetAgentMcpCallRouteForTests } from '../../tools/agent-mcp-call-route.ts';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { redactSensitiveDataAsync } from '@goodvibes-jev/engine/sdk/platform/utils';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { registerOperatorRuntimeCommands } from '../../input/commands/operator-runtime.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../../input/agent-workspace-categories.ts';
import { describeCommandPolicy } from '../../tools/agent-harness-metadata.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { compactRegisteredToolDefinitions } from '../../tools/tool-definition-compaction.ts';
import { authoredPrivacyAnswer, errorSpan, errorText } from '../helpers/authored-diagnostic-readings.ts';
import { makeFixture, registerStubTool, readAuthorizationHeader, expectModelFacingText, expectCompactSummaryFields, expectCompactModelRoute, expectRowsHaveCompactModelRoutes, executeHarnessJson, createHarnessFixtureReadings } from "./agent-harness-tool-fixture.ts";


afterAll(cleanupResearchScreeningFixtures);

describe('agent_harness tool', () => {
let previousPort: JudgmentPort | undefined;
let fixtureLog: SqliteDecisionLog;
beforeEach(() => {
    resetAgentMcpCallRouteForTests();
    fixtureLog = new SqliteDecisionLog(':memory:');
    previousPort = installJudgmentPort(withDecisionLog(createHarnessFixtureReadings(), fixtureLog));
  });
afterEach(() => { resetAgentMcpCallRouteForTests(); installJudgmentPort(previousPort); fixtureLog[Symbol.dispose](); });


  test.each(['workspace', 'categories', 'compactSummary', 'summary', 'search', 'all', 'action'] as const)('exposes Agent workspace categories, actions, and editor schemas to the model: %s', async view => {
    const fixture = makeFixture();
    try {
      const workspacePayload = { actions: AGENT_WORKSPACE_CATEGORIES.reduce((count, category) => count + category.actions.length, 0) };
      if (view === 'workspace') {
        const workspace = await fixture.tool.execute({ mode: 'workspace' });
        expect(workspace.success).toBe(true);
        const workspacePayload = JSON.parse(workspace.output!) as {
          readonly categories: readonly { readonly id: string; readonly actions: number }[];
          readonly actions: number;
        };
        expect(workspacePayload.categories.find((entry) => entry.id === 'home')?.actions).toBeGreaterThan(0);
        expect(workspacePayload.categories.find((entry) => entry.id === 'personal-ops')?.actions).toBeGreaterThan(0);
        expect(workspacePayload.categories.find((entry) => entry.id === 'documents')?.actions).toBeGreaterThan(0);
        expect(workspacePayload.actions).toBeGreaterThan(0);
        expectCompactSummaryFields(workspacePayload);
        return;
      }

      if (view === 'categories') {
        const categories = await fixture.tool.execute({ mode: 'workspace_categories' });
        expect(categories.success).toBe(true);
        const categoryPayload = JSON.parse(categories.output!) as {
          readonly categories: readonly { readonly id: string; readonly actions: number }[];
          readonly actions: number;
        };
        expect(categoryPayload.categories.find((entry) => entry.id === 'memory')?.actions).toBeGreaterThan(0);
        expect(categoryPayload.actions).toBe(workspacePayload.actions);
        expectCompactSummaryFields(categoryPayload);
        return;
      }

      if (view === 'compactSummary') {
        const compactSummary = await fixture.tool.execute({ mode: 'summary' });
        expect(compactSummary.success).toBe(true);
        const compactSummaryJson = JSON.parse(compactSummary.output ?? '{}') as { readonly modelAccess?: unknown };
        expect(compactSummaryJson.modelAccess).toBeUndefined();
        return;
      }

      if (view === 'summary') {
        const summary = await fixture.tool.execute({ mode: 'summary', includeParameters: true });
        expect(summary.success, summary.error).toBe(true);
        const summaryJson = JSON.parse(summary.output ?? '{}') as { readonly modelAccess?: { readonly workspace?: string; readonly documentOps?: string } };
        expect(summaryJson.modelAccess?.workspace).toContain('workspace action:"status');
        expect(summaryJson.modelAccess?.workspace).toContain('|actions');
        expect(summaryJson.modelAccess?.documentOps).toContain('mode:"document_ops"');
        return;
      }

      if (view === 'search') {
        const listed = await fixture.tool.execute({ mode: 'workspace_actions', categoryId: 'memory', query: 'memory create', includeParameters: true });
        expect(listed.success, listed.error).toBe(true);
        const listedPayload = JSON.parse(listed.output!) as {
          readonly actions: readonly { readonly id: string; readonly categoryId: string; readonly modelRoute?: string;
            readonly editor?: { readonly kind: string; readonly fields: readonly { readonly id: string; readonly required: boolean }[] } }[];
        };
        expectCompactSummaryFields(listedPayload);
        expect(listedPayload.actions.map(entry => entry.id)).toEqual(['memory-create']);
        expect(listedPayload.actions[0]).toMatchObject({ categoryId: 'memory', modelRoute: 'agent_local_registry', editor: { kind: 'memory' } });
        expect(listedPayload.actions[0]?.editor?.fields).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'summary', required: true })]));
        return;
      }

      if (view === 'all') {
        const allActions = await fixture.tool.execute({ mode: 'workspace_actions' });
        expect(allActions.success).toBe(true);
        const allActionPayload = JSON.parse(allActions.output!) as {
          readonly actions: readonly { readonly id: string; readonly modelRoute?: string }[];
          readonly returned: number;
          readonly total: number;
        };
        expect(allActionPayload.returned).toBe(workspacePayload.actions);
        expect(allActionPayload.total).toBe(workspacePayload.actions);
        expect(allActionPayload.actions.length).toBe(workspacePayload.actions);
        expect(allActionPayload.actions.filter((entry) => (
          typeof entry.modelRoute !== 'string'
          || entry.modelRoute.length === 0
          || entry.modelRoute.length > 72
        ))).toEqual([]);
        expect(allActionPayload.actions.find((entry) => entry.id === 'assistant-personal-ops-lane')?.modelRoute).toBe('workspace action:"open"');
        expect(allActionPayload.actions.find((entry) => entry.id === 'personal-ops-briefing')?.modelRoute).toBe('personal_ops action:"briefing"');
        expect(allActionPayload.actions.find((entry) => entry.id === 'personal-ops-queue')?.modelRoute).toBe('personal_ops action:"queue"');
        expect(allActionPayload.actions.find((entry) => entry.id === 'personal-ops-intake')?.modelRoute).toBe('personal_ops action:"intake"');
        expect(allActionPayload.actions.find((entry) => entry.id === 'personal-ops-autonomy-queue')?.modelRoute).toBe('autonomy action:"queue"');
        expect(allActionPayload.actions.find((entry) => entry.id === 'voice-workflow-posture')?.modelRoute).toBe('device action:"voice"');
        expect(allActionPayload.actions.find((entry) => entry.id === 'device-capability-map')?.modelRoute).toBe('device action:"status"');
        expect(allActionPayload.actions.find((entry) => entry.id === 'assistant-research-docs-lane')?.modelRoute).toBe('workspace action:"open"');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-create-draft')?.modelRoute).toBe('agent_documents');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-revise-draft')?.modelRoute).toBe('agent_documents');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-comment-draft')?.modelRoute).toBe('agent_documents');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-resolve-comment')?.modelRoute).toBe('agent_documents');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-suggest-draft')?.modelRoute).toBe('agent_documents');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-accept-suggestion')?.modelRoute).toBe('agent_documents');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-reject-suggestion')?.modelRoute).toBe('agent_documents');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-insert-artifact')?.modelRoute).toBe('agent_documents');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-attach-artifact')?.modelRoute).toBe('agent_documents');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-export-draft')?.modelRoute).toBe('agent_documents');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-save-review-packet-preset')?.modelRoute).toBe('agent_review_packet_presets');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-refresh-review-packet-preset')?.modelRoute).toBe('agent_review_packet_presets');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-share-review-packet')?.modelRoute).toBe('agent_review_packet_share');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-browse-artifacts')?.modelRoute).toBe('agent_artifacts');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-export-artifact-file')?.modelRoute).toBe('agent_artifacts');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-export-artifact-package')?.modelRoute).toBe('agent_artifacts');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-promote-artifact')?.modelRoute).toBe('agent_knowledge_ingest');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-ingest-file')?.modelRoute).toBe('agent_knowledge_ingest');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-generate-media')?.modelRoute).toBe('agent_media_generate');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-run-compare')?.modelRoute).toBe('agent_model_compare');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-review-compare')?.modelRoute).toBe('agent_model_compare');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-judge-compare')?.modelRoute).toBe('agent_model_compare');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-compare-analytics')?.modelRoute).toBe('agent_model_compare');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-apply-compare')?.modelRoute).toBe('agent_model_compare');
        expect(allActionPayload.actions.find((entry) => entry.id === 'document-export-compare')?.modelRoute).toBe('agent_model_compare');
        expect(allActionPayload.actions.find((entry) => entry.id === 'knowledge-ingest-url')?.modelRoute).toBe('agent_knowledge_ingest');
        expect(allActionPayload.actions.find((entry) => entry.id === 'research-briefing')?.modelRoute).toBe('research action:"briefing"');
        expect(allActionPayload.actions.find((entry) => entry.id === 'research-workflow-plan')?.modelRoute).toBe('research action:"plan"');
        expect(allActionPayload.actions.find((entry) => entry.id === 'research-runner-readiness')?.modelRoute).toBe('research action:"runner"');
        expect(allActionPayload.actions.find((entry) => entry.id === 'work-background-processes')?.modelRoute).toBe('execution action:"processes"');
        expect(allActionPayload.actions.find((entry) => entry.id === 'work-process-capabilities')?.modelRoute).toBe('process action:"capabilities"');
        expect(allActionPayload.actions.find((entry) => entry.id === 'research-run-queue')?.modelRoute).toBe('research action:"runs"');
        expect(allActionPayload.actions.find((entry) => entry.id === 'research-public-search')?.modelRoute).toBe('research action:"search"');
        expect(allActionPayload.actions.find((entry) => entry.id === 'research-start-run')?.modelRoute).toBe('research action:"create_run"');
        expect(allActionPayload.actions.find((entry) => entry.id === 'research-source-queue')?.modelRoute).toBe('research action:"sources"');
        expect(allActionPayload.actions.find((entry) => entry.id === 'research-add-source')?.modelRoute).toBe('research action:"add_source"');
        expect(allActionPayload.actions.find((entry) => entry.id === 'research-report-artifacts')?.modelRoute).toBe('research action:"reports"');
        expect(allActionPayload.actions.find((entry) => entry.id === 'research-save-report')?.modelRoute).toBe('research action:"report"');
        return;
      }

      if (view === 'action') {
        const action = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'memory-create' });
        expect(action.success).toBe(true);
        expect(action.output).toContain('"editorKind": "memory"');
        expect(action.output).toContain('agent_local_registry');
        expect(action.output).toContain('"route": "agent_local_registry"');
        expect(action.output).toContain('"summary"');
        return;
      }

    } finally {
      fixture.cleanup();
    }
  });


  test('uses runtime context for model-visible profile and routine schedule editor schemas', async () => {
    const fixture = makeFixture();
    try {
      const routine = AgentRoutineRegistry.fromShellPaths(fixture.paths).create({
        name: 'Morning Review',
        description: 'Review current operator state.',
        steps: 'Check work plan, approvals, schedules, and Agent Knowledge status.',
        enabled: true,
      });

      const profileAction = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'runtime-profile-create' });
      expect(profileAction.success).toBe(true);
      expect(profileAction.output).toContain('Starter template');

      const routineAction = await fixture.tool.execute({
        mode: 'workspace_action',
        actionId: 'schedule-promote-routine',
        recordId: routine.id,
      });
      expect(routineAction.success).toBe(true);
      expect(routineAction.output).toContain(`Selected: ${routine.id} (${routine.name})`);
      expect(routineAction.output).toContain(`"default": "${routine.id}"`);
      expect(routineAction.output).toContain(`"default": "${routine.name}"`);

      const scheduleEditAction = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'schedule-edit' });
      expect(scheduleEditAction.success).toBe(true);
      expect(scheduleEditAction.output).toContain('"editorKind": "schedule-edit"');
      expect(scheduleEditAction.output).toContain('"modelRoute": "schedule action:\\"edit\\""');
      expect(scheduleEditAction.output).toContain('"id": "scheduleId"');
    } finally {
      fixture.cleanup();
    }
  });


  test('exposes command policy metadata for slash-command mirror coverage', async () => {
    const fixture = makeFixture();
    try {
      registerOperatorRuntimeCommands(fixture.commandRegistry);

      const settings = await fixture.tool.execute({ mode: 'command', commandName: 'settings' });
      expect(settings.success).toBe(true);
      const settingsJson = JSON.parse(settings.output ?? '{}') as {
        readonly policy?: {
          readonly effect?: string;
          readonly preferredModelTool?: string;
          readonly boundary?: string;
        };
      };
      expect(settingsJson.policy?.effect).toBe('mixed');
      expect(settingsJson.policy?.preferredModelTool).toBe('settings action:"list"|action:"get"|action:"set"|action:"reset"|action:"import"');
      expect(settingsJson.policy?.preferredModelTool).not.toContain('settings/get_setting/set_setting/reset_setting');
      // The boundary told the model that connected-host lifecycle/listener
      // settings were read-only. That stopped being true when those keys became
      // daemon-owned and their writes started routing to the daemon, so the text
      // now describes routing plus the confirmation gate that replaced the lock.
      expect(settingsJson.policy?.boundary).toContain('routes to the runtime that owns the key');
      expect(settingsJson.policy?.boundary).toContain('needs the user to ask first');
      expect(settingsJson.policy?.boundary).not.toContain('remain read-only');
    } finally {
      fixture.cleanup();
    }
  });


  test('exposes every built-in slash command through the model-facing command catalog', async () => {
    const fixture = makeFixture({ builtinCommands: true });
    try {
      const catalog = await fixture.tool.execute({ mode: 'commands', includeParameters: true, limit: 500 });
      expect(catalog.success).toBe(true);
      if (!catalog.success) throw new Error(catalog.error);
      const payload = JSON.parse(catalog.output!) as {
        readonly commands: readonly {
          readonly name: string;
          readonly slash: string;
          readonly policy?: {
            readonly effect?: string;
            readonly preferredModelTool?: string;
          };
        }[];
        readonly returned: number;
        readonly total: number;
      };
      const registeredNames = fixture.commandRegistry.list().map((command) => command.name).sort();
      const catalogNames = payload.commands.map((command) => command.name).sort();

      expect(payload.total).toBe(registeredNames.length);
      expect(payload.returned).toBe(registeredNames.length);
      expect(catalogNames).toEqual(registeredNames);
      expect(catalogNames).toEqual(expect.arrayContaining([
        'agent',
        'agent-profile',
        'channels',
        'commands',
        'knowledge',
        'memory',
        'model',
        'qrcode',
        'schedule',
        'settings',
        'tasks',
        'voice',
        'work',
      ]));
      for (const hidden of [
        'bridge',
        'daemon',
        'panel',
        'profiles',
        'remote',
        'services',
      ] as const) {
        expect(catalogNames).not.toContain(hidden);
      }
      expect(payload.commands.map((command) => command.slash)).toEqual(payload.commands.map((command) => `/${command.name}`));
      expect(payload.commands.filter((command) => !command.policy?.effect || !command.policy.preferredModelTool)).toEqual([]);
      expectModelFacingText(catalog.output!);

      const compactCatalog = await fixture.tool.execute({ mode: 'commands', limit: 500 });
      expect(compactCatalog.success).toBe(true);
      if (!compactCatalog.success) throw new Error(compactCatalog.error);
      const compactPayload = JSON.parse(compactCatalog.output!) as {
        readonly commands: readonly { readonly effect?: string; readonly modelRoute?: string }[];
      };
      expectCompactSummaryFields(compactPayload);
      expect(compactPayload.commands.filter((command) => !command.effect || !command.modelRoute)).toEqual([]);
      expect(compactPayload.commands.filter((command) => (command.modelRoute?.length ?? 0) > 72)).toEqual([]);

      const profileAlias = await fixture.tool.execute({ mode: 'command', command: '/agent-profiles list' });
      expect(profileAlias.success).toBe(true);
      if (!profileAlias.success) throw new Error(profileAlias.error);
      const profilePayload = JSON.parse(profileAlias.output!) as {
        readonly name: string;
        readonly lookup: { readonly resolvedBy: string; readonly parsedArgs: readonly string[] };
        readonly policy?: { readonly preferredModelTool?: string };
      };
      expect(profilePayload.name).toBe('agent-profile');
      expect(profilePayload.lookup.resolvedBy).toBe('alias');
      expect(profilePayload.lookup.parsedArgs).toEqual(['list']);
      expect(profilePayload.policy?.preferredModelTool).toContain('workspace_actions');
    } finally {
      fixture.cleanup();
    }
  });


  test('exposes first-class model tool schemas individually', async () => {
    const fixture = makeFixture();
    try {
      const tool: Tool = {
        definition: {
          name: 'agent_custom_action',
          description: 'Run a confirmed custom Agent action',
          sideEffects: ['state'],
          concurrency: 'serial',
          supportsProgress: true,
          parameters: {
            type: 'object',
            properties: {
              targetId: { type: 'string', description: 'Target record id.' },
              confirm: { type: 'boolean' },
            },
            required: ['targetId'],
            additionalProperties: false,
          },
        },
        execute: async () => ({ success: true, output: 'custom action executed' }),
      };
      fixture.toolRegistry.register(tool);
      fixture.toolRegistry.register({
        definition: {
          name: 'agent_custom_report',
          description: 'Inspect a custom Agent report',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        execute: async () => ({ success: true, output: 'custom report inspected' }),
      });
      fixture.toolRegistry.register({
        definition: {
          name: 'agent_a_notice_template',
          description: 'Inspect notice template before send',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        execute: async () => ({ success: true, output: 'notice template inspected' }),
      });
      fixture.toolRegistry.register({
        definition: {
          name: 'agent_z_send_notice',
          description: 'Send one confirmed notice to a configured target',
          sideEffects: ['network'],
          parameters: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'Notice body.' },
              targetId: { type: 'string', description: 'Configured delivery target id.' },
              confirm: { type: 'boolean' },
            },
            required: ['message', 'targetId', 'confirm'],
            additionalProperties: false,
          },
        },
        execute: async () => ({ success: true, output: 'notice sent' }),
      });
      compactRegisteredToolDefinitions(fixture.toolRegistry);

      const summary = await fixture.tool.execute({ mode: 'summary', includeParameters: true });
      expect(summary.success, summary.error).toBe(true);
      const summaryJson = JSON.parse(summary.output ?? '{}') as { readonly modelAccess?: { readonly tools?: string } };
      expect(summaryJson.modelAccess?.tools).toContain('mode:"tool"');
      expect(summaryJson.modelAccess?.tools).toContain('includeParameters:true');

      const catalog = await fixture.tool.execute({ mode: 'tools', query: 'custom' });
      expect(catalog.success).toBe(true);
      expect(catalog.output).toContain('"name": "agent_custom_action"');
      expect(catalog.output).toContain('"supportsProgress": true');
      expect(catalog.output).not.toContain('"targetId"');
      const catalogJson = JSON.parse(catalog.output ?? '{}') as {
        readonly tools: readonly { readonly summary?: string }[];
      };
      expect(catalogJson.tools.filter((entry) => (entry.summary?.length ?? 0) > 72)).toEqual([]);

      const catalogWithSchemas = await fixture.tool.execute({ mode: 'tools', query: 'confirmed custom Agent action', includeParameters: true });
      expect(catalogWithSchemas.success).toBe(true);
      expect(catalogWithSchemas.output).toContain('"parameters"');
      expect(catalogWithSchemas.output).toContain('"targetId"');

      const taskPhraseCatalog = await fixture.tool.execute({ mode: 'tools', query: 'send notice' });
      expect(taskPhraseCatalog.success).toBe(true);
      const taskPhraseJson = JSON.parse(taskPhraseCatalog.output ?? '{}') as {
        readonly tools: readonly { readonly name: string }[];
      };
      expect(taskPhraseJson.tools[0]?.name).toBe('agent_z_send_notice');

      const parameterCatalog = await fixture.tool.execute({ mode: 'tools', query: 'target id' });
      expect(parameterCatalog.success).toBe(true);
      expect(parameterCatalog.output).toContain('"name": "agent_custom_action"');

      const detail = await fixture.tool.execute({ mode: 'tool', toolName: 'agent_custom_action' });
      expect(detail.success).toBe(true);
      expect(detail.output).toContain('"name": "agent_custom_action"');
      expect(detail.output).toContain('"resolvedBy": "name"');
      expect(detail.output).toContain('"concurrency": "serial"');
      expect(detail.output).toContain('"targetId"');
      expect(detail.output).toContain('Use the returned JSON schema directly');

      const targetLookup = await fixture.tool.execute({ mode: 'tool', target: 'confirmed custom Agent action' });
      expect(targetLookup.success).toBe(true);
      expect(targetLookup.output).toContain('"name": "agent_custom_action"');
      expect(targetLookup.output).toContain('"source": "target"');
      expect(targetLookup.output).toContain('"resolvedBy": "search"');

      const ambiguous = await fixture.tool.execute({ mode: 'tool', query: 'custom Agent' });
      expect(ambiguous.success).toBe(false);
      expect(ambiguous.error).toContain('Ambiguous model tool custom Agent');
      expect(ambiguous.error).toContain('agent_custom_action');
      expect(ambiguous.error).toContain('agent_custom_report');

      const missing = await fixture.tool.execute({ mode: 'tool', toolName: 'not_a_tool' });
      expect(missing.success).toBe(false);
      expect(missing.error).toContain('Unknown model tool');
      // The names of the real, registered tools are right there in the
      // refusal, not a pointer to go look them up somewhere else.
      expect(missing.error).toContain('Known tools:');

      // The exact incident, with no "mcp" tool registered: the refusal says
      // plainly that there is nothing here to call an MCP tool through,
      // rather than a bare "unknown" that leaves the model guessing.
      const mcpQualifiedNoRoute = await fixture.tool.execute({ mode: 'tool', toolName: 'mcp:playwright:browser_tabs' });
      expect(mcpQualifiedNoRoute.success).toBe(false);
      expect(mcpQualifiedNoRoute.error).toContain('mcp:playwright:browser_tabs');
      expect(mcpQualifiedNoRoute.error).toContain('no "mcp" tool is registered');

      // With an "mcp" tool registered (the real shape of the incident): the
      // model saw `mcp:playwright:browser_tabs` listed by `mcp mode:"tools"`,
      // then asked this catalog to describe it as if it were a directly
      // callable tool. A bare "unknown" sent the model looking for a route
      // that does not exist; the fix names the real one.
      fixture.toolRegistry.register({
        definition: {
          name: 'mcp',
          description: 'Inspect and call MCP servers.',
          parameters: { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'], additionalProperties: false },
        },
        execute: async () => ({ success: true, output: '{}' }),
      });
      const mcpQualified = await fixture.tool.execute({ mode: 'tool', toolName: 'mcp:playwright:browser_tabs' });
      expect(mcpQualified.success).toBe(false);
      expect(mcpQualified.error).toContain('mcp:playwright:browser_tabs');
      expect(mcpQualified.error).toContain('not a directly callable tool');
      expect(mcpQualified.error).toContain('mcp mode:"call" qualifiedName:"mcp:playwright:browser_tabs"');
    } finally {
      fixture.cleanup();
    }
  });


  test.each(['summary', 'evidence', 'notesArtifact', 'ambiguousArtifact', 'missingArtifact', 'inventory', 'inventoryWithQuality', 'item', 'ambiguous', 'missing'] as const)('exposes release evidence artifacts and readiness inventory lookup to the model: %s', async view => {
    const fixture = makeFixture();
    try {
      if (view === 'summary') {
        const summary = await fixture.tool.execute({ mode: 'summary', includeParameters: true });
        expect(summary.success, summary.error).toBe(true);
        if (!summary.success) throw new Error(summary.error);
        const summaryJson = JSON.parse(summary.output!) as {
          readonly releaseEvidence?: { readonly status?: string; readonly artifacts?: number; readonly available?: number };
          readonly releaseReadiness?: { readonly status?: string; readonly path?: string; readonly items?: number };
          readonly modelAccess?: { readonly releaseEvidence?: string; readonly releaseReadiness?: string };
        };
        expect(summaryJson.releaseEvidence?.status).toBe('available');
        expect(summaryJson.releaseEvidence?.artifacts).toBe(5);
        expect(summaryJson.releaseEvidence?.available).toBe(5);
        expect(summaryJson.releaseReadiness?.status).toBe('available');
        expect(summaryJson.releaseReadiness?.path).toBe('release/release-readiness.json');
        expect(summaryJson.releaseReadiness?.items).toBeGreaterThan(0);
        expect(summaryJson.modelAccess?.releaseEvidence).toContain('audit action:"evidence|artifact"');
        expect(summaryJson.modelAccess?.releaseReadiness).toContain('audit action:"readiness|item"');
        return;
      }

      if (view === 'evidence') {
        const evidence = await fixture.tool.execute({
          mode: 'release_evidence',
          query: 'live verification',
        });
        expect(evidence.success).toBe(true);
        if (!evidence.success) throw new Error(evidence.error);
        const evidenceJson = JSON.parse(evidence.output!) as {
          readonly mode: string;
          readonly artifacts: number;
          readonly available: number;
          readonly filtered: number;
          readonly artifactsList: readonly { readonly id?: string; readonly path?: string; readonly summary?: Record<string, unknown>; readonly content?: string }[];
        };
        expect(evidenceJson.mode).toBe('release_evidence');
        expect(evidenceJson.artifacts).toBe(5);
        expect(evidenceJson.available).toBe(5);
        expect(evidenceJson.filtered).toBe(2);
        expect(evidenceJson.artifactsList.map((artifact) => artifact.id)).toEqual([
          'live-verification-json',
          'live-verification-markdown',
        ]);
        expect(evidenceJson.artifactsList.map((artifact) => artifact.content)).toEqual([undefined, undefined]);
        return;
      }

      if (view === 'notesArtifact') {
        const notesArtifact = await fixture.tool.execute({
          mode: 'release_evidence_artifact',
          artifactId: 'release-notes',
        });
        expect(notesArtifact.success).toBe(true);
        if (!notesArtifact.success) throw new Error(notesArtifact.error);
        const notesArtifactJson = JSON.parse(notesArtifact.output!) as {
          readonly status: string;
          readonly lookup: { readonly source: string; readonly input?: string; readonly resolvedBy: string };
          readonly artifact: { readonly id: string; readonly path: string; readonly content?: string; readonly summary?: { readonly bullets?: number } };
        };
        expect(notesArtifactJson.status).toBe('found');
        expect(notesArtifactJson.lookup.source).toBe('artifactId');
        expect(notesArtifactJson.lookup.resolvedBy).toBe('id');
        expect(notesArtifactJson.artifact.id).toBe('release-notes');
        expect(notesArtifactJson.artifact.path).toBe('release/release-notes.md');
        // Assert the SHAPE of the notes, never their wording: the live
        // release/release-notes.md is rewritten every release, so pinning a
        // phrase from one release's copy makes this test fail on the next one.
        expect(notesArtifactJson.artifact.content).toBeTruthy();
        expect(notesArtifactJson.artifact.content!.trimStart().startsWith('- ')).toBe(true);
        expect(notesArtifactJson.artifact.summary?.bullets).toBeGreaterThan(0);
        return;
      }

      if (view === 'ambiguousArtifact') {
        const ambiguousArtifact = await fixture.tool.execute({ mode: 'release_evidence_artifact', query: 'live verification' });
        expect(ambiguousArtifact.success).toBe(false);
        expect(ambiguousArtifact.error).toContain('Unknown release evidence artifact');
        return;
      }

      if (view === 'missingArtifact') {
        const missingArtifact = await fixture.tool.execute({ mode: 'release_evidence_artifact', artifactId: 'not-release-evidence' });
        expect(missingArtifact.success).toBe(false);
        expect(missingArtifact.error).toContain('Unknown release evidence artifact not-release-evidence');
        return;
      }

      if (view === 'inventory') {
        const inventory = await fixture.tool.execute({
          mode: 'release_readiness',
          query: 'release-quality inventory',
          limit: 5,
        });
        expect(inventory.success).toBe(true);
        if (!inventory.success) throw new Error(inventory.error);
        const inventoryJson = JSON.parse(inventory.output!) as {
          readonly mode: string;
          readonly path: string;
          readonly totals: {
            readonly items: number;
            readonly filtered: number;
            readonly requiredQualityDimensions: readonly string[];
            readonly completeQualityDimensions: number;
            readonly expectedQualityDimensions: number;
          };
          readonly items: readonly { readonly id?: string; readonly quality?: unknown }[];
        };
        expect(inventoryJson.mode).toBe('release_readiness');
        expect(inventoryJson.path).toBe('release/release-readiness.json');
        expect(inventoryJson.totals.items).toBeGreaterThan(0);
        expect(inventoryJson.totals.filtered).toBeGreaterThan(0);
        expect(inventoryJson.totals.requiredQualityDimensions).toContain('modelAccess');
        expect(inventoryJson.totals.completeQualityDimensions).toBe(inventoryJson.totals.expectedQualityDimensions);
        expect(inventoryJson.items.map((item) => item.id)).toContain('release-readiness-inventory-gate');
        expect(inventoryJson.items.map((item) => item.quality)).toEqual(Array(inventoryJson.items.length).fill(undefined));
        return;
      }

      if (view === 'inventoryWithQuality') {
        const inventoryWithQuality = await fixture.tool.execute({
          mode: 'release_readiness',
          query: 'release-quality inventory',
          includeParameters: true,
          limit: 1,
        });
        expect(inventoryWithQuality.success).toBe(true);
        expect(inventoryWithQuality.output).toContain('"quality"');
        return;
      }

      if (view === 'item') {
        const item = await fixture.tool.execute({
          mode: 'release_readiness_item',
          itemId: 'release-readiness-inventory-gate',
        });
        expect(item.success).toBe(true);
        if (!item.success) throw new Error(item.error);
        const itemJson = JSON.parse(item.output!) as {
          readonly status: string;
          readonly lookup: { readonly source: string; readonly resolvedBy: string };
          readonly item: { readonly id: string; readonly quality: { readonly modelAccess?: string } };
        };
        expect(itemJson.status).toBe('found');
        expect(itemJson.lookup.source).toBe('itemId');
        expect(itemJson.lookup.resolvedBy).toBe('id');
        expect(itemJson.item.id).toBe('release-readiness-inventory-gate');
        expect(itemJson.item.quality.modelAccess).toContain('release_evidence');
        expect(itemJson.item.quality.modelAccess).toContain('release_readiness');
        return;
      }

      if (view === 'ambiguous') {
        const ambiguous = await fixture.tool.execute({ mode: 'release_readiness_item', query: 'Agent' });
        expect(ambiguous.success).toBe(false);
        expect(ambiguous.error).toContain('Unknown release readiness item');
        return;
      }

      if (view === 'missing') {
        const missing = await fixture.tool.execute({ mode: 'release_readiness_item', itemId: 'not-a-readiness-item' });
        expect(missing.success).toBe(false);
        expect(missing.error).toContain('Unknown release readiness item not-a-readiness-item');
        return;
      }

    } finally {
      fixture.cleanup();
    }
  });


  test('exposes operator method catalog and service posture as read-only model surfaces', async () => {
    const fixture = makeFixture();
    try {
      fixture.configManager.setDynamic('controlPlane.enabled', false);
      fixture.configManager.setDynamic('danger.httpListener', false);
      fixture.configManager.setDynamic('web.enabled', false);

      const summary = await fixture.tool.execute({ mode: 'summary', includeParameters: true });
      expect(summary.success, summary.error).toBe(true);
      if (!summary.success) throw new Error(summary.error);
      const summaryJson = JSON.parse(summary.output!) as {
        readonly operatorMethods?: { readonly modes?: readonly string[]; readonly methods?: number; readonly readOnlyMethods?: number };
        readonly servicePosture?: { readonly modes?: readonly string[]; readonly endpointIds?: readonly string[]; readonly readOnly?: boolean };
        readonly modelAccess?: { readonly operatorMethods?: string; readonly servicePosture?: string };
      };
      expect(summaryJson.operatorMethods?.modes).toEqual(['operator_methods', 'operator_method']);
      expect(summaryJson.operatorMethods?.methods).toBeGreaterThan(10);
      expect(summaryJson.operatorMethods?.readOnlyMethods).toBeGreaterThan(5);
      expect(summaryJson.servicePosture?.modes).toEqual(['service_posture', 'service_endpoint']);
      expect(summaryJson.servicePosture?.endpointIds).toEqual(['controlPlane', 'httpListener', 'web']);
      expect(summaryJson.servicePosture?.readOnly).toBe(true);
      expect(summaryJson.modelAccess?.operatorMethods).toContain('host action:"methods|method"');
      expect(summaryJson.modelAccess?.servicePosture).toContain('host action:"services|service"');

      const catalog = await fixture.tool.execute({
        mode: 'operator_methods',
        query: 'knowledge',
        includeParameters: true,
        limit: 120,
      });
      expect(catalog.success).toBe(true);
      if (!catalog.success) throw new Error(catalog.error);
      const catalogJson = JSON.parse(catalog.output!) as {
        readonly methods: readonly { readonly id: string; readonly route: string; readonly preferredModelTool: string; readonly parameters?: readonly unknown[] }[];
      };
      expect(catalogJson.methods.map((method) => method.id)).toContain('knowledge.map');
      expect(catalogJson.methods.map((method) => method.route)).toContain('GET /api/knowledge/connectors/{id}/doctor');
      expect(catalogJson.methods.find((method) => method.id === 'knowledge.ingest.url')?.parameters?.length).toBeGreaterThan(0);

      const schedule = await fixture.tool.execute({ mode: 'operator_method', methodId: 'automation.schedules.create' });
      expect(schedule.success).toBe(true);
      if (!schedule.success) throw new Error(schedule.error);
      const scheduleJson = JSON.parse(schedule.output!) as {
        readonly id: string;
        readonly preferredModelTool: string;
        readonly parameters: readonly { readonly name: string; readonly required: boolean }[];
      };
      expect(scheduleJson.id).toBe('automation.schedules.create');
      expect(scheduleJson.preferredModelTool).toContain('agent_operator_method');
      expect(scheduleJson.parameters.map((parameter) => parameter.name)).toEqual(expect.arrayContaining([
        'prompt',
        'kind',
        'every',
        'delivery',
      ]));

      const posture = await fixture.tool.execute({ mode: 'service_posture', includeParameters: true });
      expect(posture.success).toBe(true);
      if (!posture.success) throw new Error(posture.error);
      const postureJson = JSON.parse(posture.output!) as {
        readonly readOnly: boolean;
        readonly endpoints: readonly { readonly id: string; readonly policy: { readonly lifecycle: string } }[];
      };
      expect(postureJson.readOnly).toBe(true);
      expect(postureJson.endpoints.map((endpoint) => endpoint.id)).toEqual(['controlPlane', 'httpListener', 'web']);
      expect(postureJson.endpoints[0]?.policy.lifecycle).toContain('confirmed GoodVibes daemon operator methods');

      const endpoint = await fixture.tool.execute({ mode: 'service_endpoint', query: 'browser companion route' });
      expect(endpoint.success).toBe(true);
      if (!endpoint.success) throw new Error(endpoint.error);
      const endpointJson = JSON.parse(endpoint.output!) as {
        readonly id: string;
        readonly lookup: { readonly source: string; readonly input?: string; readonly resolvedBy: string };
        readonly policy: { readonly effect: string; readonly lifecycle: string };
      };
      expect(endpointJson.id).toBe('web');
      expect(endpointJson.lookup).toEqual({
        source: 'query',
        input: 'browser companion route',
        resolvedBy: 'label',
      });
      expect(endpointJson.policy.effect).toBe('read-only');
      expect(endpointJson.policy.lifecycle).toContain('confirmed GoodVibes daemon operator methods');
    } finally {
      fixture.cleanup();
    }
  });


  test('exposes top-level CLI mirror metadata without enabling hidden CLI execution', async () => {
    const fixture = makeFixture();
    try {
      const summary = await fixture.tool.execute({ mode: 'summary', includeParameters: true });
      expect(summary.success, summary.error).toBe(true);
      expect(summary.output).toContain('"cliCommands"');
      const summaryJson = JSON.parse(summary.output ?? '{}') as { readonly modelAccess?: { readonly cliCommands?: string } };
      expect(summaryJson.modelAccess?.cliCommands).toContain('workspace action:"cli_commands');

      const catalog = await fixture.tool.execute({ mode: 'cli_commands', query: 'knowledge' });
      expect(catalog.success).toBe(true);
      expect(catalog.output).toContain('"name": "knowledge"');
      expect(catalog.output).toContain('"blockedTokens"');
      expect(catalog.output).toContain('"daemon"');
      expect(catalog.output).toContain('CLI modes are read-only discovery');
      const compactCliJson = JSON.parse(catalog.output!) as {
        readonly commands: readonly { readonly name: string; readonly effect?: string; readonly modelRoute?: string }[];
      };
      expect(compactCliJson.commands.filter((command) => (
        command.name === 'knowledge'
        && command.effect === 'mixed'
        && command.modelRoute === 'agent_knowledge or agent_knowledge_ingest'
      ))).toHaveLength(1);
      expect(compactCliJson.commands.filter((command) => (command.modelRoute?.length ?? 0) > 72)).toEqual([]);

      const detailedCatalog = await fixture.tool.execute({ mode: 'cli_commands', query: 'knowledge', includeParameters: true });
      expect(detailedCatalog.success).toBe(true);
      expect(detailedCatalog.output).toContain('agent_knowledge or agent_knowledge_ingest');

      const parsed = await fixture.tool.execute({
        mode: 'cli_command',
        cliCommand: 'goodvibes-agent status --json --config surfaces.slack.botToken=xoxb-secret-value',
      });
      expect(parsed.success).toBe(true);
      expect(parsed.output).toContain('"name": "status"');
      expect(parsed.output).toContain('"resolvedBy": "invocation"');
      expect(parsed.output).toContain('"outputFormat": "json"');
      expect(parsed.output).toContain('surfaces.slack.botToken=<redacted>');
      expect(parsed.output).not.toContain('xoxb-secret-value');

      const lookedUp = await fixture.tool.execute({
        mode: 'cli_command',
        query: 'Call isolated Agent Knowledge routes',
      });
      expect(lookedUp.success).toBe(true);
      expect(lookedUp.output).toContain('"name": "knowledge"');
      expect(lookedUp.output).toContain('"resolvedBy": "search"');
      expect(lookedUp.output).toContain('agent_knowledge or agent_knowledge_ingest');

      const ambiguous = await fixture.tool.execute({
        mode: 'cli_command',
        query: 'Agent',
      });
      expect(ambiguous.success).toBe(true);
      expect(ambiguous.output).toContain('"status": "ambiguous"');
      expect(ambiguous.output).toContain('"candidates"');
      expect(ambiguous.output).toContain('goodvibes-agent');

      const blocked = await fixture.tool.execute({ mode: 'cli_command', cliCommand: 'daemon start' });
      expect(blocked.success).toBe(true);
      expect(blocked.output).toContain('"supported": false');
      expect(blocked.output).toContain('Unsupported command: daemon');
      expect(blocked.output).toContain('connected-host');
    } finally {
      fixture.cleanup();
    }
  });


  test.each(['summary', 'picker', 'search', 'slash', 'commands', 'blocks', 'operator', 'browser', 'activity', 'output', 'settings', 'cockpit', 'settingsQuery', 'effectsSelection', 'effectsRoutes', 'effectsTts'] as const)('exposes modal and picker UI surfaces with confirmation-gated visible routing: %s', async view => {
    const fixture = makeFixture();
    try {
      if (view === 'summary') {
        const summary = await fixture.tool.execute({ mode: 'summary', includeParameters: true });
        expect(summary.success, summary.error).toBe(true);
        expect(summary.output).toContain('"uiSurfaces"');
        const summaryJson = JSON.parse(summary.output ?? '{}') as { readonly modelAccess?: { readonly uiSurfaces?: string } };
        expect(summaryJson.modelAccess?.uiSurfaces).toContain('workspace action:"surfaces');
        return;
      }

      if (view === 'picker') {
        const catalog = await fixture.tool.execute({ mode: 'ui_surfaces', query: 'picker' });
        expect(catalog.success).toBe(true);
        expect(catalog.output).toContain('"id": "model-picker"');
        expect(catalog.output).toContain('"id": "provider-picker"');
        expect(catalog.output).toContain('"id": "reasoning-effort-picker"');
        expect(catalog.output).toContain('"id": "tts-provider-picker"');
        expect(catalog.output).toContain('"id": "tts-voice-picker"');
        expect(catalog.output).toContain('"id": "file-picker"');
        expect(catalog.output).toContain('modelRoute');
        expect(catalog.output).not.toContain('preferredModelRoute');
        expectCompactSummaryFields(JSON.parse(catalog.output!));
        expectModelFacingText(catalog.output!);
        const catalogJson = JSON.parse(catalog.output!) as {
          readonly surfaces: readonly { readonly id?: string; readonly modelRoute?: string }[];
        };
        expect(catalogJson.surfaces.filter((surface) => (
          typeof surface.modelRoute !== 'string'
          || surface.modelRoute.length === 0
          || surface.modelRoute.length > 72
        ))).toEqual([]);
        expect(catalogJson.surfaces.find((surface) => surface.id === 'model-picker')?.modelRoute).toBe('settings action:"get|set" or workspace action:"run_command"');
        return;
      }

      if (view === 'search') {
        const searchSurfaces = await fixture.tool.execute({ mode: 'ui_surfaces', query: 'search' });
        expect(searchSurfaces.success).toBe(true);
        expect(searchSurfaces.output).toContain('"id": "conversation-search"');
        expect(searchSurfaces.output).toContain('"id": "prompt-history-search"');
        return;
      }

      if (view === 'slash') {
        const commandSurfaces = await fixture.tool.execute({ mode: 'ui_surfaces', query: 'slash-command' });
        expect(commandSurfaces.success).toBe(true);
        expect(commandSurfaces.output).toContain('"id": "slash-command-mode"');
        return;
      }

      if (view === 'commands') {
        const commandBrowserSurfaces = await fixture.tool.execute({ mode: 'ui_surfaces', query: 'command browser' });
        expect(commandBrowserSurfaces.success).toBe(true);
        expect(commandBrowserSurfaces.output).toContain('"id": "command-browser"');
        return;
      }

      if (view === 'blocks') {
        const blockSurfaces = await fixture.tool.execute({ mode: 'ui_surfaces', query: 'block action' });
        expect(blockSurfaces.success).toBe(true);
        expect(blockSurfaces.output).toContain('"id": "block-actions"');
        return;
      }

      if (view === 'operator') {
        const operatorSurfaces = await fixture.tool.execute({ mode: 'ui_surfaces', query: 'operator' });
        expect(operatorSurfaces.success).toBe(true);
        expect(operatorSurfaces.output).toContain('"id": "panel-picker"');
        expect(operatorSurfaces.output).toContain('"id": "security-panel"');
        expect(operatorSurfaces.output).toContain('"id": "knowledge-panel"');
        expect(operatorSurfaces.output).toContain('"id": "subscription-panel"');
        return;
      }

      if (view === 'browser') {
        const browserSurfaces = await fixture.tool.execute({ mode: 'ui_surfaces', query: 'browser cockpit pwa' });
        expect(browserSurfaces.success).toBe(true);
        expect(browserSurfaces.output).toContain('"id": "connected-browser-cockpit"');
        // web.enabled now defaults true (dissolved feature model, default-on
        // with announce-once receipts), so a stock config reports the cockpit
        // route as available/ready instead of unavailable.
        expect(browserSurfaces.output).toContain('"available": true');
        expect(browserSurfaces.output).toContain('"readiness": "ready"');
        return;
      }

      if (view === 'activity') {
        const activitySurfaces = await fixture.tool.execute({ mode: 'ui_surfaces', query: 'activity' });
        expect(activitySurfaces.success).toBe(true);
        expect(activitySurfaces.output).toContain('"id": "process-monitor"');
        expect(activitySurfaces.output).toContain('Visible running-process and live-output monitor.');
        expect(activitySurfaces.output).toContain('first-class tools or workspace action:\\"open\\"');
        return;
      }

      if (view === 'output') {
        const outputSurfaces = await fixture.tool.execute({ mode: 'ui_surfaces', query: 'live-output' });
        expect(outputSurfaces.success).toBe(true);
        expect(outputSurfaces.output).toContain('"id": "live-tail"');
        return;
      }

      if (view === 'settings') {
        const settings = await fixture.tool.execute({ mode: 'ui_surface', surfaceId: 'settings' });
        expect(settings.success).toBe(true);
        const settingsJson = JSON.parse(settings.output ?? '{}') as {
          readonly id?: string;
          readonly modelRoute?: string;
          readonly preferredModelRoute?: string;
        };
        expect(settingsJson.id).toBe('settings');
        expect(settingsJson.modelRoute).toBe('settings action:"list|get|set" or workspace action:"open"');
        expect(settingsJson.preferredModelRoute).toContain('settings action:"list"|action:"get"|action:"set"|action:"reset"|action:"import"');
        expect(settingsJson.preferredModelRoute).not.toContain('settings/get_setting/set_setting/reset_setting');
        expectModelFacingText(settings.output!);

        // web.enabled defaults true now (dissolved feature model, default-on);
        // disable it explicitly so this phase still exercises the honest
        // setup-needed reporting before the enabled phase below.
        return;
      }

      if (view === 'cockpit') {
        fixture.configManager.setDynamic('web.enabled', false);
        const browserCockpit = await fixture.tool.execute({ mode: 'ui_surface', surfaceId: 'connected-browser-cockpit' });
        expect(browserCockpit.success).toBe(true);
        const browserCockpitJson = JSON.parse(browserCockpit.output ?? '{}') as {
          readonly id?: string;
          readonly available?: boolean;
          readonly cockpit?: {
            readonly enabled?: boolean;
            readonly readiness?: string;
            readonly url?: string;
            readonly source?: string;
            readonly setupRoutes?: Record<string, string>;
            readonly workspaceCoverage?: {
              readonly status?: string;
              readonly categoryCount?: number;
              readonly nativeCategoryRoutesPublished?: boolean;
              readonly lanes?: readonly { readonly id?: string; readonly browserStatus?: string; readonly agentRoutes?: readonly string[] }[];
              readonly categories?: readonly { readonly id?: string; readonly browserStatus?: string; readonly agentRoute?: string }[];
            };
            readonly mobile?: { readonly status?: string; readonly controls?: readonly { readonly id?: string; readonly status?: string }[] };
            readonly receipts?: {
              readonly status?: string;
              readonly agentOnboardingCompletion?: { readonly status?: string; readonly exists?: boolean };
              readonly browserFirstRunCompletion?: { readonly status?: string; readonly webEnabled?: boolean };
            };
          };
        };
        expect(browserCockpitJson.id).toBe('connected-browser-cockpit');
        expect(browserCockpitJson.available).toBe(false);
        expect(browserCockpitJson.cockpit?.enabled).toBe(false);
        expect(browserCockpitJson.cockpit?.readiness).toBe('setup-needed');
        expect(browserCockpitJson.cockpit?.url).toBe('http://127.0.0.1:3423');
        expect(browserCockpitJson.cockpit?.setupRoutes?.inspectEndpoint).toContain('endpointId:"web"');
        expect(browserCockpitJson.cockpit?.workspaceCoverage).toMatchObject({
          status: 'web-setup-needed',
          nativeCategoryRoutesPublished: false,
        });
        expect(browserCockpitJson.cockpit?.workspaceCoverage?.categoryCount).toBeGreaterThan(20);
        expect(browserCockpitJson.cockpit?.workspaceCoverage?.lanes?.some((lane) => lane.id === 'setup-and-settings' && lane.browserStatus === 'blocked-by-web-setup')).toBe(true);
        expect(browserCockpitJson.cockpit?.workspaceCoverage?.categories?.some((category) => category.id === 'home' && category.browserStatus === 'blocked-by-web-setup' && category.agentRoute?.includes('categoryId:"home"'))).toBe(true);
        expect(browserCockpitJson.cockpit?.mobile?.status).toBe('setup-needed');
        expect(browserCockpitJson.cockpit?.mobile?.controls?.some((control) => control.id === 'inspect-web-endpoint' && control.status === 'ready')).toBe(true);
        expect(browserCockpitJson.cockpit?.receipts).toMatchObject({
          status: 'needs-agent-closeout-and-browser-receipt',
          agentOnboardingCompletion: { status: 'missing', exists: false },
          browserFirstRunCompletion: { status: 'not-published', webEnabled: false },
        });

        fixture.configManager.setDynamic('web.enabled', true);
        fixture.configManager.setDynamic('web.publicBaseUrl', 'https://agent.example.test');
        const enabledBrowserCockpit = await fixture.tool.execute({ mode: 'ui_surface', surfaceId: 'connected-browser-cockpit' });
        expect(enabledBrowserCockpit.success).toBe(true);
        const enabledBrowserCockpitJson = JSON.parse(enabledBrowserCockpit.output ?? '{}') as typeof browserCockpitJson;
        expect(enabledBrowserCockpitJson.available).toBe(true);
        expect(enabledBrowserCockpitJson.cockpit?.readiness).toBe('ready');
        expect(enabledBrowserCockpitJson.cockpit?.url).toBe('https://agent.example.test');
        expect(enabledBrowserCockpitJson.cockpit?.source).toBe('web.publicBaseUrl');
        expect(enabledBrowserCockpitJson.cockpit?.workspaceCoverage).toMatchObject({
          status: 'needs-browser-native-category-contracts',
          nativeCategoryRoutesPublished: false,
        });
        expect(enabledBrowserCockpitJson.cockpit?.workspaceCoverage?.lanes?.some((lane) => lane.id === 'work-and-automation' && lane.browserStatus === 'needs-browser-native-contract')).toBe(true);
        expect(enabledBrowserCockpitJson.cockpit?.workspaceCoverage?.categories?.some((category) => category.id === 'work' && category.browserStatus === 'terminal-first')).toBe(true);
        expect(enabledBrowserCockpitJson.cockpit?.mobile?.status).toBe('openable');
        expect(enabledBrowserCockpitJson.cockpit?.receipts?.browserFirstRunCompletion).toMatchObject({
          status: 'not-published',
          webEnabled: true,
        });
        fixture.configManager.setDynamic('web.enabled', false);
        fixture.configManager.setDynamic('web.publicBaseUrl', '');
        return;
      }

      if (view === 'settingsQuery') {
        const settingsByQuery = await fixture.tool.execute({
          mode: 'ui_surface',
          query: 'fullscreen settings workspace',
        });
        expect(settingsByQuery.success).toBe(true);
        const settingsByQueryJson = JSON.parse(settingsByQuery.output!);
        expect(settingsByQueryJson.id).toBe('settings');
        expect(settingsByQueryJson.lookup).toEqual({
          source: 'query',
          input: 'fullscreen settings workspace',
          resolvedBy: 'search',
        });
        return;
      }

      if (view === 'effectsSelection') {
        fixture.configManager.setDynamic('web.enabled', false);
        fixture.configManager.setDynamic('web.publicBaseUrl', '');
        const denied = await fixture.tool.execute({
          mode: 'open_ui_surface',
          surfaceId: 'settings',
          target: 'provider.model',
          explicitUserRequest: 'Open settings for the model setting.',
        });
        expect(denied.success).toBe(false);
        expect(denied.error).toContain('recorded effect admission');
        expect(fixture.openedSurfaces).toEqual([]);

        const openedSettings = await fixture.admittedTool.execute({
          mode: 'open_ui_surface',
          surfaceId: 'settings',
          target: 'provider.model',
          confirm: true,
          explicitUserRequest: 'Open settings for the model setting.',
        });
        expect(openedSettings.success).toBe(true);
        expect(openedSettings.output).toContain('"status": "opened"');
        expectModelFacingText(openedSettings.output!);
        expect(fixture.openedSurfaces).toEqual([{ id: 'settings', detail: 'provider.model' }]);

        const ambiguousSurface = await fixture.admittedTool.execute({
          mode: 'open_ui_surface',
          query: 'picker',
          confirm: true,
          explicitUserRequest: 'Open a picker.',
        });
        expect(ambiguousSurface.success).toBe(true);
        expect(ambiguousSurface.output).toContain('"status": "unknown_ui_surface"');
        expect(ambiguousSurface.output).toContain('model-picker');
        expect(fixture.openedSurfaces).toEqual([{ id: 'settings', detail: 'provider.model' }]);

        return;
      }

      if (view === 'effectsRoutes') {
        fixture.configManager.setDynamic('web.enabled', false);
        const openedWorkspace = await fixture.admittedTool.execute({
          mode: 'open_ui_surface',
          surfaceId: 'agent-workspace',
          categoryId: 'knowledge',
          confirm: true,
          explicitUserRequest: 'Open the Knowledge workspace.',
        });
        expect(openedWorkspace.success).toBe(true);
        expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'agent-workspace', detail: 'knowledge' });

        const disabledBrowserCockpit = await fixture.admittedTool.execute({
          mode: 'open_ui_surface',
          surfaceId: 'connected-browser-cockpit',
          confirm: true,
          explicitUserRequest: 'Open the connected browser cockpit.',
        });
        expect(disabledBrowserCockpit.success).toBe(true);
        expect(disabledBrowserCockpit.output).toContain('"status": "setup_needed"');
        const disabledBrowserCockpitJson = JSON.parse(disabledBrowserCockpit.output!) as {
          readonly route?: { readonly setupRoutes?: { readonly inspectEndpoint?: string } };
          readonly descriptor?: { readonly modelRoute?: string };
        };
        expect(disabledBrowserCockpitJson.route?.setupRoutes?.inspectEndpoint).toContain('host action:"service"');
        expect(disabledBrowserCockpitJson.descriptor?.modelRoute).toContain('computer action:"browser|open_browser"');
        expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'agent-workspace', detail: 'knowledge' });

        const openedPanelPicker = await fixture.admittedTool.execute({
          mode: 'open_ui_surface',
          surfaceId: 'panel-picker',
          confirm: true,
          explicitUserRequest: 'Open the operator panel picker.',
        });
        expect(openedPanelPicker.success).toBe(true);
        expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'panel-picker', detail: 'home' });

        const openedSecurity = await fixture.admittedTool.execute({
          mode: 'open_ui_surface',
          surfaceId: 'security-panel',
          confirm: true,
          explicitUserRequest: 'Open the security operator surface.',
        });
        expect(openedSecurity.success).toBe(true);
        expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'agent-workspace', detail: 'tools' });

        const openedKnowledge = await fixture.admittedTool.execute({
          mode: 'open_ui_surface',
          surfaceId: 'knowledge-panel',
          confirm: true,
          explicitUserRequest: 'Open the knowledge operator surface.',
        });
        expect(openedKnowledge.success).toBe(true);
        expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'agent-workspace', detail: 'knowledge' });

        const openedSubscription = await fixture.admittedTool.execute({
          mode: 'open_ui_surface',
          surfaceId: 'subscription-panel',
          confirm: true,
          explicitUserRequest: 'Open the subscription operator surface.',
        });
        expect(openedSubscription.success).toBe(true);
        expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'agent-workspace', detail: 'setup' });

        const openedProcessMonitor = await fixture.admittedTool.execute({
          mode: 'open_ui_surface',
          surfaceId: 'process-monitor',
          confirm: true,
          explicitUserRequest: 'Open the runtime activity monitor.',
        });
        expect(openedProcessMonitor.success).toBe(true);
        expect(openedProcessMonitor.output).toContain('"status": "opened"');
        expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'process-monitor' });

        const openedLiveTail = await fixture.admittedTool.execute({
          mode: 'open_ui_surface',
          surfaceId: 'live-tail',
          target: 'sleep',
          confirm: true,
          explicitUserRequest: 'Open live output for the running sleep process.',
        });
        expect(openedLiveTail.success).toBe(true);
        expect(openedLiveTail.output).toContain('"processId": "bg-test"');
        expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'live-tail', detail: 'sleep' });

        const openedConversationSearch = await fixture.admittedTool.execute({
          mode: 'open_ui_surface',
          surfaceId: 'conversation-search',
          query: 'approval',
          confirm: true,
          explicitUserRequest: 'Open transcript search for approval.',
        });
        expect(openedConversationSearch.success).toBe(true);
        expect(openedConversationSearch.output).toContain('"query": "approval"');
        expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'conversation-search', detail: 'approval' });

        const openedPromptHistorySearch = await fixture.admittedTool.execute({
          mode: 'open_ui_surface',
          surfaceId: 'prompt-history-search',
          query: 'deploy',
          confirm: true,
          explicitUserRequest: 'Open prompt history search for deploy.',
        });
        expect(openedPromptHistorySearch.success).toBe(true);
        expect(openedPromptHistorySearch.output).toContain('"query": "deploy"');
        expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'prompt-history-search', detail: 'deploy' });

        const openedSlashCommandMode = await fixture.admittedTool.execute({
          mode: 'open_ui_surface',
          surfaceId: 'slash-command-mode',
          query: 'help',
          confirm: true,
          explicitUserRequest: 'Open slash command mode for help.',
        });
        expect(openedSlashCommandMode.success).toBe(true);
        expect(openedSlashCommandMode.output).toContain('"query": "help"');
        expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'slash-command-mode', detail: 'help' });

        const openedCommandBrowser = await fixture.admittedTool.execute({
          mode: 'open_ui_surface',
          surfaceId: 'command-browser',
          confirm: true,
          explicitUserRequest: 'Open the command browser.',
        });
        expect(openedCommandBrowser.success).toBe(true);
        expect(openedCommandBrowser.output).toContain('"command": "/commands"');
        expect(fixture.openedSelections.at(-1)).toEqual({
          title: 'Help - Commands',
          itemIds: ['/brief'],
          preSelectId: undefined,
        });

        const openedFilePicker = await fixture.admittedTool.execute({
          mode: 'open_ui_surface',
          surfaceId: 'file-picker',
          target: 'inject',
          query: 'src',
          confirm: true,
          explicitUserRequest: 'Open the file picker for raw source injection.',
        });
        expect(openedFilePicker.success).toBe(true);
        expect(openedFilePicker.output).toContain('"mode": "inject"');
        expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'file-picker', detail: 'inject:src' });

        const openedReasoningEffort = await fixture.admittedTool.execute({
          mode: 'open_ui_surface',
          surfaceId: 'reasoning-effort-picker',
          confirm: true,
          explicitUserRequest: 'Open the reasoning effort picker.',
        });
        expect(openedReasoningEffort.success).toBe(true);
        expect(openedReasoningEffort.output).toContain('"model": "Reasoning Model"');
        expect(fixture.openedSelections.at(-1)).toEqual({
          title: 'Reasoning Effort',
          itemIds: ['low', 'medium', 'high'],
          preSelectId: 'medium',
        });

        const openedBlockActions = await fixture.admittedTool.execute({
          mode: 'open_ui_surface',
          surfaceId: 'block-actions',
          confirm: true,
          explicitUserRequest: 'Open block actions for the nearest transcript block.',
        });
        expect(openedBlockActions.success).toBe(true);
        expect(openedBlockActions.output).toContain('"surface": "block-actions"');
        expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'block-actions' });

        return;
      }

      if (view === 'effectsTts') {
        fixture.configManager.setDynamic('web.enabled', false);
        fixture.configManager.setDynamic('tts.provider', 'stream-voice');
        fixture.configManager.setDynamic('tts.voice', '');
        const openedTtsProvider = await fixture.admittedTool.execute({
          mode: 'open_ui_surface',
          surfaceId: 'tts-provider-picker',
          confirm: true,
          explicitUserRequest: 'Open the TTS provider picker.',
        });
        expect(openedTtsProvider.success).toBe(true);
        expect(openedTtsProvider.output).toContain('"status": "opened"');
        expect(fixture.openedSelections.at(-1)).toEqual({
          title: 'Choose TTS Provider',
          itemIds: ['stream-voice'],
          preSelectId: 'stream-voice',
        });

        const openedTtsProviderByQuery = await fixture.admittedTool.execute({
          mode: 'open_ui_surface',
          query: 'streaming TTS provider picker',
          confirm: true,
          explicitUserRequest: 'Open the TTS provider picker.',
        });
        expect(openedTtsProviderByQuery.success).toBe(true);
        expect(openedTtsProviderByQuery.output).toContain('"status": "opened"');
        expect(openedTtsProviderByQuery.output).toContain('"source": "query"');

        const openedTtsVoice = await fixture.admittedTool.execute({
          mode: 'open_ui_surface',
          surfaceId: 'tts-voice-picker',
          target: 'stream-voice',
          confirm: true,
          explicitUserRequest: 'Open the TTS voice picker for stream-voice.',
        });
        expect(openedTtsVoice.success).toBe(true);
        expect(openedTtsVoice.output).toContain('"providerId": "stream-voice"');
        expect(fixture.openedSelections.at(-1)).toEqual({
          title: 'Choose TTS Voice (stream-voice)',
          itemIds: ['__default__', 'stream-voice-voice-a', 'stream-voice-voice-b'],
          preSelectId: '__default__',
        });
        return;
      }

    } finally {
      fixture.cleanup();
    }
  });


  test('consumes certified browser PWA category routes and first-run receipts', async () => {
    const fixture = makeFixture();
    try {
      fixture.configManager.setDynamic('web.enabled', true);
      fixture.configManager.setDynamic('web.publicBaseUrl', 'https://agent.example.test/app');
      const categoryIds = AGENT_WORKSPACE_CATEGORIES.map((category) => category.id);
      const platform = fixture.context.platform as unknown as { readModels: Record<string, unknown> };
      platform.readModels.browserPwa = {
        categoryRoutes: {
          getSnapshot: () => ({
            records: [{
              id: 'browser-pwa-all-categories',
              routeId: 'browser-pwa-all-categories',
              categoryIds,
              laneId: 'agent-workspace',
              label: 'Browser-native Agent workspace',
              status: 'ready',
              summary: 'Responsive cockpit controls are ready token=browser-summary-secret',
              mobileReady: true,
              pwaReady: true,
              capabilities: ['chat', 'setup', 'approvals', 'automations', 'memory', 'channels', 'research', 'safety', 'mobile touch', 'PWA install'],
              routes: {
                inspect: 'computer action:"browser" includeParameters:true',
                open: 'https://agent.example.test/app/workspaces?token=browser-route-secret',
                chat: 'https://agent.example.test/app/chat?token=browser-chat-secret',
                setup: 'https://agent.example.test/app/setup?token=browser-setup-secret',
                approvals: 'https://agent.example.test/app/approvals?token=browser-approval-secret',
                automations: 'https://agent.example.test/app/automation?token=browser-automation-secret',
                memory: 'https://agent.example.test/app/memory?token=browser-memory-secret',
                channels: 'https://agent.example.test/app/channels?token=browser-channel-secret',
              },
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.browserPwa.categoryRoute.v1',
              publicationGuarantee: 'daemon publishes browser route receipts secret=browser-publication-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method browserPwa.categoryRoutes.list', 'sourceTool connected-host-web'],
              cursor: 'browser-category-cursor-1',
              receiptId: 'browser-category-route-receipt-1',
            }],
          }),
        },
        firstRunReceipts: {
          getSnapshot: () => ({
            records: [{
              id: 'browser-first-run-live-1',
              receiptId: 'browser-first-run-live-1',
              setupStepId: 'browser-pwa',
              methodId: 'browser.pwa.firstRun',
              status: 'published',
              receiptStatus: 'published',
              recordedAt: '1970-01-01T00:00:06.000Z',
              summary: 'Browser/PWA first-run completed token=browser-first-run-secret',
              url: 'https://agent.example.test/app?token=browser-url-secret',
              manifestStatus: 'ready',
              serviceWorkerStatus: 'active',
              installStatus: 'installed',
              offlineStatus: 'ready',
              capabilities: ['manifest', 'service worker', 'offline cache', 'install prompt'],
              routes: {
                inspect: 'computer action:"browser" includeParameters:true',
                open: 'https://agent.example.test/app?token=browser-open-secret',
                install: 'https://agent.example.test/app/install?token=browser-install-secret',
              },
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.browserPwa.firstRun.v1',
              publicationGuarantee: 'browser runtime publishes first-run receipts secret=browser-first-run-publication-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method browser.pwa.firstRun', 'sourceTool connected-host-web'],
              cursor: 'browser-first-run-cursor-1',
            }],
          }),
        },
      };

      const browserCockpit = await executeHarnessJson<{
        readonly id?: string;
        readonly available?: boolean;
        readonly cockpit?: {
          readonly readiness?: string;
          readonly workspaceCoverage?: {
            readonly status?: string;
            readonly categoryCount?: number;
            readonly coveredCategoryCount?: number;
            readonly nativeCategoryRoutesPublished?: boolean;
            readonly lanes?: readonly { readonly id?: string; readonly browserStatus?: string; readonly coveredCategoryCount?: number }[];
            readonly categories?: readonly { readonly id?: string; readonly browserStatus?: string; readonly browserRoute?: string | null; readonly mobileReady?: boolean }[];
            readonly publishedCategoryRoutes?: readonly { readonly certification?: { readonly missingSignals?: readonly string[]; readonly receiptId?: string } }[];
          };
          readonly mobile?: {
            readonly status?: string;
            readonly pwaInstall?: { readonly status?: string };
            readonly touchControls?: { readonly status?: string };
            readonly nativeControls?: readonly { readonly id?: string; readonly status?: string }[];
          };
          readonly receipts?: {
            readonly status?: string;
            readonly browserFirstRunStatus?: string;
            readonly browserFirstRunCompletion?: {
              readonly status?: string;
              readonly certifiedReadModelCount?: number;
              readonly evidence?: {
                readonly certification?: { readonly missingSignals?: readonly string[]; readonly receiptId?: string };
                readonly summary?: string | null;
                readonly url?: string | null;
              } | null;
            };
          };
        };
      }>(fixture, { mode: 'ui_surface', surfaceId: 'connected-browser-cockpit' });

      expect(browserCockpit.id).toBe('connected-browser-cockpit');
      expect(browserCockpit.available).toBe(true);
      expect(browserCockpit.cockpit?.readiness).toBe('browser-native-ready');
      expect(browserCockpit.cockpit?.workspaceCoverage).toMatchObject({
        status: 'browser-native-ready',
        categoryCount: categoryIds.length,
        coveredCategoryCount: categoryIds.length,
        nativeCategoryRoutesPublished: true,
      });
      expect(browserCockpit.cockpit?.workspaceCoverage?.lanes?.every((lane) => lane.browserStatus === 'browser-native-ready')).toBe(true);
      expect(browserCockpit.cockpit?.workspaceCoverage?.categories?.every((category) => category.browserStatus === 'browser-native-ready' && category.browserRoute && category.mobileReady === true)).toBe(true);
      expect(browserCockpit.cockpit?.workspaceCoverage?.publishedCategoryRoutes?.[0]?.certification?.missingSignals).toEqual([]);
      expect(browserCockpit.cockpit?.workspaceCoverage?.publishedCategoryRoutes?.[0]?.certification?.receiptId).toBe('browser-category-route-receipt-1');
      expect(browserCockpit.cockpit?.mobile?.status).toBe('browser-native-ready');
      expect(browserCockpit.cockpit?.mobile?.pwaInstall?.status).toBe('certified-live-receipt');
      expect(browserCockpit.cockpit?.mobile?.touchControls?.status).toBe('ready');
      expect(browserCockpit.cockpit?.mobile?.nativeControls?.every((control) => control.status === 'ready')).toBe(true);
      expect(browserCockpit.cockpit?.receipts?.status).toBe('browser-ready-agent-onboarding-missing');
      expect(browserCockpit.cockpit?.receipts?.browserFirstRunStatus).toBe('certified-live-receipt');
      expect(browserCockpit.cockpit?.receipts?.browserFirstRunCompletion?.status).toBe('certified-live-receipt');
      expect(browserCockpit.cockpit?.receipts?.browserFirstRunCompletion?.certifiedReadModelCount).toBe(1);
      expect(browserCockpit.cockpit?.receipts?.browserFirstRunCompletion?.evidence?.certification?.missingSignals).toEqual([]);
      expect(browserCockpit.cockpit?.receipts?.browserFirstRunCompletion?.evidence?.certification?.receiptId).toBe('browser-first-run-live-1');
      const output = JSON.stringify(browserCockpit);
      expect(output).toContain('<redacted>');
      expect(output).not.toContain('browser-summary-secret');
      expect(output).not.toContain('browser-route-secret');
      expect(output).not.toContain('browser-chat-secret');
      expect(output).not.toContain('browser-setup-secret');
      expect(output).not.toContain('browser-approval-secret');
      expect(output).not.toContain('browser-automation-secret');
      expect(output).not.toContain('browser-memory-secret');
      expect(output).not.toContain('browser-channel-secret');
      expect(output).not.toContain('browser-publication-secret');
      expect(output).not.toContain('browser-first-run-secret');
      expect(output).not.toContain('browser-url-secret');
      expect(output).not.toContain('browser-open-secret');
      expect(output).not.toContain('browser-install-secret');
      expect(output).not.toContain('browser-first-run-publication-secret');
    } finally {
      fixture.cleanup();
    }
  });


  test('exposes shortcuts and confirmation-gated keybinding edits', async () => {
    const fixture = makeFixture();
    try {
      const summary = await fixture.tool.execute({ mode: 'summary', includeParameters: true });
      expect(summary.success, summary.error).toBe(true);
      expect(summary.output).toContain('"shortcuts"');
      const summaryJson = JSON.parse(summary.output ?? '{}') as { readonly modelAccess?: { readonly shortcuts?: string } };
      expect(summaryJson.modelAccess?.shortcuts).toContain('workspace action:"shortcuts');
      expect(summaryJson.modelAccess?.shortcuts).toContain('run_keybinding');

      const shortcuts = await fixture.tool.execute({ mode: 'shortcuts', query: 'help' });
      expect(shortcuts.success).toBe(true);
      expect(shortcuts.output).toContain('"fixedShortcuts"');
      expect(shortcuts.output).toContain('? / F1');
      expect(shortcuts.output).toContain('"configurableKeybindings"');

      const processShortcut = await fixture.tool.execute({ mode: 'shortcuts', query: 'runtime activity' });
      expect(processShortcut.success).toBe(true);
      expect(processShortcut.output).toContain('"key": "F2"');
      expect(processShortcut.output).toContain('Open runtime activity monitor');

      const shortcutsReference = await fixture.tool.execute({ mode: 'shortcuts', query: 'shortcut reference' });
      expect(shortcutsReference.success).toBe(true);
      expect(shortcutsReference.output).toContain('"key": "/shortcuts"');
      expect(shortcutsReference.output).toContain('Open keyboard shortcut reference');

      const keybinding = await fixture.tool.execute({ mode: 'keybinding', actionId: 'search' });
      expect(keybinding.success).toBe(true);
      expect(keybinding.output).toContain('"action": "search"');
      expect(keybinding.output).toContain('Ctrl+F');
      expect(keybinding.output).toContain('"customized": false');
      expect(keybinding.output).toContain('"modelOperation"');
      expect(keybinding.output).toContain('"preferredMode": "run_keybinding"');
      expect(keybinding.output).toContain('"surfaceId": "conversation-search"');

      const keybindingCatalog = await fixture.tool.execute({ mode: 'keybindings', limit: 500 });
      expect(keybindingCatalog.success).toBe(true);
      expectModelFacingText(shortcuts.output!);
      expectModelFacingText(keybindingCatalog.output!);
      expectModelFacingText(keybinding.output!);

      const keybindingByQuery = await fixture.tool.execute({ mode: 'keybinding', query: 'Ctrl+F' });
      expect(keybindingByQuery.success).toBe(true);
      const keybindingByQueryJson = JSON.parse(keybindingByQuery.output!);
      expect(keybindingByQueryJson.action).toBe('search');
      expect(keybindingByQueryJson.lookup).toEqual({
        source: 'query',
        input: 'Ctrl+F',
        resolvedBy: 'key-combo',
      });

      const ambiguousKeybinding = await fixture.tool.execute({ mode: 'keybinding', query: 'workspace' });
      expect(ambiguousKeybinding.success).toBe(true);
      expect(ambiguousKeybinding.output).toContain('"status": "ambiguous"');
      expect(ambiguousKeybinding.output).toContain('workspace-picker');

      const runDenied = await fixture.tool.execute({
        mode: 'run_keybinding',
        actionId: 'search',
        explicitUserRequest: 'Open conversation search.',
      });
      expect(runDenied.success).toBe(false);
      expect(runDenied.error).toContain('recorded effect admission');
      expect(fixture.openedSurfaces.filter((surface) => surface.id === 'conversation-search')).toEqual([]);

      const runSearch = await fixture.admittedTool.execute({
        mode: 'run_keybinding',
        actionId: 'search',
        value: 'release notes',
        confirm: true,
        explicitUserRequest: 'Open conversation search for release notes.',
      });
      expect(runSearch.success).toBe(true);
      expect(runSearch.output).toContain('"status": "executed"');
      expect(runSearch.output).toContain('"effect": "conversation-search-opened"');
      expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'conversation-search', detail: 'release notes' });

      const dismissFixture = makeFixture({ dismissAgentWorkspace: true });
      try {
        const runDismiss = await dismissFixture.admittedTool.execute({
          mode: 'run_keybinding',
          actionId: 'workspace-close',
          confirm: true,
          explicitUserRequest: 'Dismiss the active Agent workspace.',
        });
        expect(runDismiss.success).toBe(true);
        expect(runDismiss.output).toContain('"status": "executed"');
        expect(runDismiss.output).toContain('"effect": "agent-workspace-dismissed"');
        expect(runDismiss.output).toContain('"route": "dismissAgentWorkspace"');
        expect(dismissFixture.openedSurfaces).toEqual([{ id: 'agent-workspace-dismissed', result: true }]);
      } finally {
        dismissFixture.cleanup();
      }

      const surfaceCount = fixture.openedSurfaces.length;
      const unsupportedRun = await fixture.admittedTool.execute({
        mode: 'run_keybinding',
        actionId: 'undo',
        confirm: true,
        explicitUserRequest: 'Undo the last prompt edit.',
      });
      expect(unsupportedRun.success).toBe(true);
      expect(unsupportedRun.output).toContain('"status": "unsupported_keybinding_action"');
      expect(unsupportedRun.output).toContain('"preferredMode": "direct-user-interaction"');
      expect(fixture.openedSurfaces.length).toBe(surfaceCount);

      const denied = await fixture.tool.execute({
        mode: 'set_keybinding',
        actionId: 'search',
        combo: { key: 'g', ctrl: true },
        explicitUserRequest: 'Change search to Ctrl+G.',
      });
      expect(denied.success).toBe(false);
      expect(denied.error).toContain('recorded effect admission');
      expect(fixture.keybindingsManager.matches('search', { logicalName: 'f', ctrl: true })).toBe(true);

      const updated = await fixture.admittedTool.execute({
        mode: 'set_keybinding',
        query: 'Ctrl+F',
        combo: { key: 'g', ctrl: true },
        confirm: true,
        explicitUserRequest: 'Change search to Ctrl+G.',
      });
      expect(updated.success).toBe(true);
      expect(updated.output).toContain('"status": "updated"');
      expect(updated.output).toContain('Ctrl+G');
      expect(updated.output).toContain('"resolvedBy": "key-combo"');
      expect(updated.output).toContain('"customized": true');
      expect(fixture.keybindingsManager.matches('search', { logicalName: 'g', ctrl: true })).toBe(true);
      expect(fixture.keybindingsManager.matches('search', { logicalName: 'f', ctrl: true })).toBe(false);

      const reset = await fixture.admittedTool.execute({
        mode: 'reset_keybinding',
        target: 'Toggle conversation search',
        confirm: true,
        explicitUserRequest: 'Reset search keybinding.',
      });
      expect(reset.success).toBe(true);
      expect(reset.output).toContain('"status": "reset"');
      expect(reset.output).toContain('Ctrl+F');
      expect(reset.output).toContain('"source": "target"');
      expect(reset.output).toContain('"customized": false');
      expect(fixture.keybindingsManager.matches('search', { logicalName: 'f', ctrl: true })).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });


  test('changes and restores an actual keybinding through recorded admission without caller confirmation flags', async () => {
    const fixture = makeFixture();
    try {
      const denied = await fixture.tool.execute({ mode: 'set_keybinding', actionId: 'search', combo: { key: 'g', ctrl: true }, confirm: true, explicitUserRequest: 'Caller flags cannot authorize this write.' });
      expect(denied.success).toBe(false);
      expect(denied.error).toContain('recorded effect admission');
      expect(fixture.keybindingsManager.matches('search', { logicalName: 'f', ctrl: true })).toBe(true);

      const updated = await fixture.admittedTool.execute({ mode: 'set_keybinding', actionId: 'search', combo: { key: 'g', ctrl: true } });
      expect(updated.success).toBe(true);
      expect(fixture.keybindingsManager.matches('search', { logicalName: 'g', ctrl: true })).toBe(true);
      const restored = await fixture.admittedTool.execute({ mode: 'reset_keybinding', actionId: 'search' });
      expect(restored.success).toBe(true);
      expect(fixture.keybindingsManager.matches('search', { logicalName: 'f', ctrl: true })).toBe(true);
    } finally { fixture.cleanup(); }
  });


  test('keeps keybinding discovery available when the live manager is absent', async () => {
    const fixture = makeFixture({ keybindings: false });
    try {
      const listed = await fixture.tool.execute({ mode: 'keybindings', query: 'conversation search' });
      expect(listed.success).toBe(true);
      const listedJson = JSON.parse(listed.output ?? '{}') as {
        readonly status?: string;
        readonly configPath?: string | null;
        readonly keybindings?: readonly { readonly action?: string; readonly source?: string }[];
      };
      expect(listedJson.status).toBe('degraded');
      expect(listedJson.configPath).toBeNull();
      expect(listedJson.keybindings?.[0]?.action).toBe('search');
      expect(listedJson.keybindings?.[0]?.source).toBe('default-fallback');

      const shortcut = await fixture.tool.execute({ mode: 'shortcuts', query: 'shortcut reference' });
      expect(shortcut.success).toBe(true);
      expect(shortcut.output).toContain('"key": "/shortcuts"');
      expect(shortcut.output).toContain('"status": "degraded"');

      const single = await fixture.tool.execute({ mode: 'keybinding', query: 'Ctrl+F' });
      expect(single.success).toBe(true);
      expect(single.output).toContain('"status": "degraded"');
      expect(single.output).toContain('"action": "search"');
      expect(single.output).toContain('Default keybinding descriptor only');

      const diagnostic = 'workspace.keybindingsManager is unavailable in this Agent runtime';
      const readDiagnostic = authoredPrivacyAnswer({ fields: { 'workspace.keybindingsManager': 'other' }, parts: [
        [errorText('workspace.keybindingsManager is '), errorSpan('workspace.keybindingsManager'), errorText('')],
      ] });
      const diagnosticReadings = fakePort((name, question, state) => {
        const answer = readDiagnostic(name, question, state);
        if (answer === undefined) throw new Error('Unexpected authored missing-manager diagnostic reading.');
        return answer;
      });
      const base = judgmentPort('harness missing-manager fixture');
      using diagnosticLog = new SqliteDecisionLog(':memory:');
      const diagnosticPort = withDecisionLog({ model: base.model, ask(request) {
        return ['engine.redaction.field-kind', 'engine.redaction.credential', 'engine.export.credential',
          'engine.redaction.residual-credential', 'engine.redaction.profile-distinctive'].includes(request.context?.battery ?? '')
          ? diagnosticReadings.port.ask(request) : base.ask(request);
      } }, diagnosticLog);
      const previous = installJudgmentPort(diagnosticPort);
      const configBefore = JSON.stringify(fixture.configManager.getRaw());
      const keybindingPath = fixture.paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'keybindings.json');
      const keybindingBefore = existsSync(keybindingPath) ? readFileSync(keybindingPath) : null;
      try {
        expect(await redactSensitiveDataAsync(diagnostic)).toBe(diagnostic);
        expect(await redactSensitiveDataAsync('password=unrelated-private-diagnostic')).not.toContain('unrelated-private-diagnostic');
        const run = await fixture.admittedTool.execute({
          mode: 'run_keybinding',
          actionId: 'search',
          confirm: true,
          explicitUserRequest: 'Open conversation search.',
        });
        expect(run.success).toBe(false);
        expect(run.error).toContain('workspace.keybindingsManager is unavailable');
        expect(fixture.openedSurfaces).toEqual([]);
        expect(JSON.stringify(fixture.configManager.getRaw())).toBe(configBefore);
        expect(existsSync(keybindingPath) ? readFileSync(keybindingPath) : null).toEqual(keybindingBefore);
      } finally { installJudgmentPort(previous); }
    } finally {
      fixture.cleanup();
    }
  });


  test('reports connected-host capabilities, boundaries, and model tool availability', async () => {
    const fixture = makeFixture();
    try {
      for (const name of [
        'agent_operator_briefing',
        'agent_operator_action',
        'agent_artifacts',
        'agent_knowledge',
        'agent_knowledge_ingest',
        'agent_channel_send',
        'agent_notify',
        'schedule',
        'agent_autonomy_schedule',
        'agent_reminder_schedule',
        'agent_media_generate',
        'agent_model_compare',
        'agent_review_packet_presets',
        'agent_research_runs',
        'agent_research_sources',
        'agent_research_report',
      ]) {
        registerStubTool(fixture.toolRegistry, name);
      }

      const compactResult = await fixture.tool.execute({ mode: 'connected_host' });
      expect(compactResult.success).toBe(true);
      expect(compactResult.output).toContain('"counts"');
      expect(compactResult.output).not.toContain('/api/goodvibes-agent/knowledge/*');
      const compactJson = JSON.parse(compactResult.output ?? '{}') as { readonly modelRoute?: string };
      expectCompactModelRoute(compactJson.modelRoute);

      const daemonAlias = await fixture.tool.execute({ mode: 'daemon' });
      expect(daemonAlias.success).toBe(true);
      expect(JSON.parse(daemonAlias.output!)).toEqual(JSON.parse(compactResult.output!));

      const result = await fixture.tool.execute({ mode: 'connected_host', includeParameters: true });
      expect(result.success, result.error).toBe(true);
      expect(result.output).toContain('"routeFamilies"');
      expect(result.output).toContain('/api/goodvibes-agent/knowledge/*');
      expect(result.output).toContain('"capabilities"');
      expect(result.output).toContain('"agent_operator_action"');
      expect(result.output).toContain('"available": true');
      const expandedJson = JSON.parse(result.output ?? '{}') as {
        readonly capabilities?: readonly Record<string, unknown>[];
        readonly blockedCapabilities?: readonly Record<string, unknown>[];
        readonly routeFamilies?: readonly Record<string, unknown>[];
      };
      expectRowsHaveCompactModelRoutes(expandedJson.capabilities ?? []);
      expectRowsHaveCompactModelRoutes(expandedJson.blockedCapabilities ?? []);
      expectRowsHaveCompactModelRoutes(expandedJson.routeFamilies ?? []);
      expect(result.output).toContain('"blockedCapabilities"');
      expect(result.output).toContain('connected-host-lifecycle');
      expect(result.output).toContain('arbitrary-connected-host-mutations');

      const allowed = await fixture.tool.execute({
        mode: 'connected_host_capability',
        capabilityId: 'agent-knowledge-read',
      });
      expect(allowed.success).toBe(true);
      expect(allowed.output).toContain('"status": "allowed"');
      expect(allowed.output).toContain('"agent_knowledge"');
      expect(allowed.output).toContain('"sources"');
      expect(allowed.output).toContain('"map"');
      expect(allowed.output).toContain('"connector_doctor"');
      expect(allowed.output).toContain('/api/goodvibes-agent/knowledge/*');
      const allowedJson = JSON.parse(allowed.output ?? '{}') as { readonly modelRoute?: string };
      expect(allowedJson.modelRoute).toBe('agent_knowledge');

      const blocked = await fixture.tool.execute({
        mode: 'connected_host_capability',
        capabilityId: 'connected-host-lifecycle',
      });
      expect(blocked.success).toBe(true);
      expect(blocked.output).toContain('"status": "blocked"');
      expect(blocked.output).toContain('start');
      expect(blocked.output).toContain('not exposed to the model as an Agent operation');
      const blockedJson = JSON.parse(blocked.output ?? '{}') as { readonly modelRoute?: string };
      expectCompactModelRoute(blockedJson.modelRoute);

      const blockedByTarget = await fixture.tool.execute({
        mode: 'connected_host_capability',
        target: 'default-knowledge',
      });
      expect(blockedByTarget.success).toBe(true);
      expect(blockedByTarget.output).toContain('"status": "blocked"');
      expect(blockedByTarget.output).toContain('non-agent-knowledge');

      const ambiguous = await fixture.tool.execute({
        mode: 'connected_host_capability',
        query: 'agent',
      });
      expect(ambiguous.success).toBe(false);
      expect(ambiguous.error).toContain('Unknown connected-host capability');

      const missing = await fixture.tool.execute({
        mode: 'connected_host_capability',
        capabilityId: 'not-a-capability',
      });
      expect(missing.success).toBe(false);
      expect(missing.error).toContain('Unknown connected-host capability');
    } finally {
      fixture.cleanup();
    }
  });


  test('reports live connected-host status without exposing the operator token', async () => {
    const fixture = makeFixture();
    const originalFetch = globalThis.fetch;
    const token = 'gvop-test-token-value';
    const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
    try {
      writeFileSync(join(fixture.root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token }));
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, authorization: readAuthorizationHeader(init?.headers) });
        if (url.endsWith('/status')) {
          return new Response(JSON.stringify({ status: 'running' }), { status: 200 });
        }
        if (url.endsWith('/api/goodvibes-agent/knowledge/status')) {
          return new Response(JSON.stringify({ ready: true }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }) as typeof globalThis.fetch;

      const result = await fixture.tool.execute({ mode: 'connected_host_status' });
      expect(result.success, result.error).toBe(true);
      if (!result.success) throw new Error(result.error);
      const payload = JSON.parse(result.output!) as {
        readonly modelRoute?: string;
        readonly liveStatus: {
          readonly reachable: boolean;
          readonly compatible: boolean;
          readonly agentKnowledge: { readonly ready: boolean };
        };
        readonly operatorToken: {
          readonly usable: boolean;
          readonly fingerprint: string | null;
        };
      };
      expectCompactModelRoute(payload.modelRoute);
      expect(payload.liveStatus.reachable).toBe(true);
      expect(payload.operatorToken.usable).toBe(true);
      expect(payload.operatorToken.fingerprint?.startsWith('sha256:')).toBe(true);
      expect(result.output).not.toContain(token);

      const alias = await fixture.tool.execute({ mode: 'daemon_status' });
      expect(alias.success).toBe(true);
      if (!alias.success) throw new Error(alias.error);
      const aliasPayload = JSON.parse(alias.output!) as typeof payload;
      expectCompactModelRoute(aliasPayload.modelRoute);
      expect(aliasPayload.liveStatus.reachable).toBe(true);
      expect(aliasPayload.operatorToken.usable).toBe(true);
      expect(alias.output).not.toContain(token);
      expect(requests.map((request) => request.url)).toEqual([
        'http://127.0.0.1:3421/status',
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/status',
        'http://127.0.0.1:3421/status',
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/status',
      ]);
      expect(requests.map((request) => request.authorization)).toEqual(Array(4).fill(`Bearer ${token}`));
    } finally {
      globalThis.fetch = originalFetch;
      fixture.cleanup();
    }
  });


  test('uses the canonical TUI editor schema for learned behavior actions', async () => {
    const fixture = makeFixture();
    try {
      const action = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'learned-behavior' });

      expect(action.success).toBe(true);
      expect(action.output).toContain('"editorKind": "learned-behavior"');
      expect(action.output).toContain('Ctrl-J inserts a new line.');
    } finally {
      fixture.cleanup();
    }
  });


  test('exposes a model-visible editor schema for every user-facing workspace editor action', async () => {
    const fixture = makeFixture();
    try {
      const editorActions = AGENT_WORKSPACE_CATEGORIES.flatMap((category) => (
        category.actions
          .filter((action) => action.kind === 'editor' && action.editorKind)
          .map((action) => ({ category, action }))
      ));

      expect(editorActions.length).toBeGreaterThan(0);
      for (const { action } of editorActions) {
        const result = await fixture.tool.execute({ mode: 'workspace_action', actionId: action.id });
        expect(result.success, action.id).toBe(true);
        expect(result.output, action.id).toContain('"editor"');
        expect(result.output, action.id).toContain('"fields"');
        expect(result.output, action.id).toContain('"modelExecution"');
      }

      const compare = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'document-run-compare' });
      expect(compare.success).toBe(true);
      expect(compare.output).toContain('"id": "artifactId"');
      expect(compare.output).toContain('Optional saved text artifact id');
    } finally {
      fixture.cleanup();
    }
  });


  test('classifies workspace editor model execution routes by route type', async () => {
    const fixture = makeFixture();
    try {
      const local = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'memory-create' });
      const commandBacked = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'conversation-save' });
      const promptBacked = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'research-main' });
      const researchRun = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'research-start-run' });
      const researchSource = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'research-add-source' });
      const researchReport = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'research-save-report' });
      const directLocal = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'learned-behavior' });
      const profile = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'runtime-profile-create' });

      expect(local.success).toBe(true);
      expect(commandBacked.success).toBe(true);
      expect(promptBacked.success).toBe(true);
      expect(researchRun.success).toBe(true);
      expect(researchSource.success).toBe(true);
      expect(researchReport.success).toBe(true);
      expect(directLocal.success).toBe(true);
      expect(profile.success).toBe(true);

      expect(JSON.parse(local.output!).modelExecution).toMatchObject({
        route: 'agent_local_registry',
        tool: 'agent_local_registry',
        domain: 'memory',
      });
      expect(JSON.parse(commandBacked.output!).modelExecution).toMatchObject({
        route: 'slash-command-dispatch',
        dispatcher: 'run_command',
        confirmation: 'required',
      });
      expect(JSON.parse(promptBacked.output!).modelExecution).toMatchObject({
        route: 'main-conversation-prompt',
        result: 'prompt',
        confirmation: 'not-required',
      });
      expect(JSON.parse(researchRun.output!).modelExecution).toMatchObject({
        route: 'agent_research_runs',
        tool: 'agent_research_runs',
        action: 'create_research_run',
        confirmation: 'required',
      });
      expect(JSON.parse(researchSource.output!).modelExecution).toMatchObject({
        route: 'agent_research_sources',
        tool: 'agent_research_sources',
        action: 'add_source_candidate',
        confirmation: 'required',
      });
      expect(JSON.parse(researchReport.output!).modelExecution).toMatchObject({
        route: 'agent_research_report',
        tool: 'agent_research_report',
        action: 'save_research_report_artifact',
        confirmation: 'required',
      });
      expect(JSON.parse(directLocal.output!).modelExecution).toMatchObject({
        route: 'direct-agent-local-create',
        action: 'create_learned_behavior',
      });
      expect(JSON.parse(profile.output!).modelExecution).toMatchObject({
        route: 'slash-command-dispatch',
        command: '/agent-profile create <name> [--template <template>] --yes',
      });
    } finally {
      fixture.cleanup();
    }
  });


  test('exposes model execution metadata for every local workspace action', async () => {
    const fixture = makeFixture();
    try {
      const localActions = AGENT_WORKSPACE_CATEGORIES.flatMap((category) => (
        category.actions
          .filter((action) => action.kind === 'local-selection' || action.kind === 'local-operation')
          .map((action) => ({ category, action }))
      ));

      expect(localActions.length).toBeGreaterThan(0);
      for (const { action } of localActions) {
        const result = await fixture.tool.execute({ mode: 'workspace_action', actionId: action.id });
        expect(result.success, action.id).toBe(true);
        expect(result.output, action.id).toContain('"modelExecution"');
        expect(result.output!.includes('agent_local_registry') || result.output!.includes('agent_knowledge_ingest'), action.id).toBe(true);
      }
    } finally {
      fixture.cleanup();
    }
  });


  test('requires confirmation before invoking slash commands through the harness', async () => {
    const fixture = makeFixture();
    try {
      const preview = await fixture.tool.execute({
        mode: 'run_command',
        command: '/brief',
        explicitUserRequest: 'Show the briefing.',
      });
      expect(preview.success).toBe(true);
      expect(describeCommandPolicy('brief').effect).toBe('read-only');
      expect(preview.output).toContain('Command /brief completed.');
      expect(preview.output).toContain('briefing output');
      expect(fixture.printed).toEqual([]);

      const executed = await fixture.admittedTool.execute({
        mode: 'run_command',
        command: '/brief',
        confirm: true,
        explicitUserRequest: 'Show the briefing.',
      });
      expect(executed.success).toBe(true);
      expect(executed.output).toContain('Command /brief completed.');
      expect(executed.output).toContain('briefing output');
    } finally {
      fixture.cleanup();
    }
  });
});
