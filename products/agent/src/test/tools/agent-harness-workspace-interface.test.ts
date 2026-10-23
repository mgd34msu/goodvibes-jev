import { cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { resetAgentMcpCallRouteForTests } from '../../tools/agent-mcp-call-route.ts';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';



import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';


import { registerOperatorRuntimeCommands } from '../../input/commands/operator-runtime.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../../input/agent-workspace-categories.ts';

import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { compactRegisteredToolDefinitions } from '../../tools/tool-definition-compaction.ts';

import { makeFixture, expectModelFacingText, expectCompactSummaryFields, executeHarnessJson, createHarnessFixtureReadings } from "./agent-harness-tool-fixture.ts";


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


  test.each(['catalog', 'invocation', 'lookup', 'ambiguous', 'blocked'] as const)('CLI discovery preserves routing, privacy and effect boundaries: %s', async view => {
    const fixture = makeFixture();
    try {
      if (view === 'catalog') {
        const result = await executeHarnessJson<{ readonly commands: readonly { readonly name: string; readonly effect?: string; readonly modelRoute?: string }[] }>(fixture,
          { mode: 'cli_commands', query: 'knowledge' });
        expect(result.commands.filter(command => command.name === 'knowledge')).toEqual([
          expect.objectContaining({ effect: 'mixed', modelRoute: 'agent_knowledge or agent_knowledge_ingest' }),
        ]);
      } else if (view === 'invocation') {
        const result = await executeHarnessJson<{ readonly name: string; readonly lookup: { readonly resolvedBy: string };
          readonly parsed: { readonly flags: { readonly outputFormat: string; readonly configOverrides: readonly string[] } } }>(fixture,
          { mode: 'cli_command', cliCommand: 'goodvibes-agent status --json --config surfaces.slack.botToken=xoxb-secret-value' });
        expect(result.name).toBe('status'); expect(result.lookup.resolvedBy).toBe('invocation');
        expect(result.parsed.flags.outputFormat).toBe('json');
        expect(result.parsed.flags.configOverrides).toContain('surfaces.slack.botToken=<redacted>');
        expect(JSON.stringify(result)).not.toContain('xoxb-secret-value');
      } else if (view === 'lookup') {
        const result = await executeHarnessJson<{ readonly name: string; readonly lookup: { readonly resolvedBy: string }; readonly modelRoute: string }>(fixture,
          { mode: 'cli_command', query: 'Call isolated Agent Knowledge routes' });
        expect(result).toMatchObject({ name: 'knowledge', lookup: { resolvedBy: 'search' }, modelRoute: 'agent_knowledge or agent_knowledge_ingest' });
      } else if (view === 'ambiguous') {
        const result = await executeHarnessJson<{ readonly status: string; readonly supported: boolean; readonly candidates: readonly unknown[] }>(fixture,
          { mode: 'cli_command', query: 'Agent' });
        expect(result).toMatchObject({ status: 'ambiguous', supported: false });
        expect(result.candidates.length).toBeGreaterThan(1);
      } else {
        const result = await executeHarnessJson<{ readonly supported: boolean; readonly token: string; readonly errors: readonly string[] }>(fixture,
          { mode: 'cli_command', cliCommand: 'daemon start' });
        expect(result).toMatchObject({ supported: false, token: 'daemon' }); expect(result.errors.length).toBeGreaterThan(0);
      }
      expect(fixture.printed).toEqual([]);
    } finally { fixture.cleanup(); }
  });


});
