import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import { resetAgentMcpCallRouteForTests } from '../../tools/agent-mcp-call-route.ts';
import { gateJudgmentRegistry } from '@goodvibes-jev/engine/sdk/platform/gate';
import { SqliteDecisionLog, withDecisionLog, score, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChannelDeliveryRequest } from '@goodvibes-jev/engine/sdk/platform/channels';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { ToolInputProjectionError, assertCurrentToolEffect, assertCurrentToolExecution } from '@goodvibes-jev/engine/sdk/platform/tools';
import { createLocalMemoryAccess } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { CONFIG_SCHEMA } from '../../config/index.ts';
import { buildGoodVibesSecretKey, buildGoodVibesSecretRef } from '../../config/secret-config.ts';
import { isAgentHiddenSettingKey } from '../../config/agent-settings-policy.ts';
import { registerOperatorRuntimeCommands } from '../../input/commands/operator-runtime.ts';
import { describeCliCommandPolicy, describeCommandPolicy } from '../../tools/agent-harness-metadata.ts';
import { registerAgentArtifactsTool } from '../../tools/agent-artifacts-tool.ts';
import { createAgentModelCompareTool } from '../../tools/agent-model-compare-tool.ts';
import { registerAgentKnowledgeIngestTool } from '../../tools/agent-knowledge-ingest-tool.ts';
import { registerAgentDocumentsTool } from '../../tools/agent-documents-tool.ts';
import { registerAgentSettingsTool } from '../../tools/agent-settings-tool.ts';
import { registerAgentLocalRegistryTool } from '../../tools/agent-local-registry-tool.ts';
import { registerAgentResearchReportTool } from '../../tools/agent-research-report-tool.ts';
import { registerAgentReviewPacketPresetsTool } from '../../tools/agent-review-packet-presets-tool.ts';
import { registerAgentReviewPacketShareTool } from '../../tools/agent-review-packet-share-tool.ts';
import { registerAgentResearchRunsTool } from '../../tools/agent-research-runs-tool.ts';
import { registerAgentResearchSourcesTool } from '../../tools/agent-research-sources-tool.ts';
import { AgentNoteRegistry } from '../../agent/note-registry.ts';
import { AgentDocumentRegistry } from '../../agent/document-registry.ts';
import { AgentResearchRunRegistry } from '../../agent/research-run-registry.ts';
import { AgentResearchSourceRegistry } from '../../agent/research-source-registry.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { listGoodVibesCliCommands } from '../../cli/parser.ts';
import { createHarnessArtifactStore, makeFixture, createMemoryRegistry, refusePreparedHarnessSetting, fakeChannelDeliveryRouter, expectCompactSummaryFields, executeHarnessJson, CONNECTED_HOST_AUTH_ENV_KEYS, clearEnvForTest, restoreEnvForTest, writeConnectedHostOperatorToken, createHarnessFixtureReadings } from "./agent-harness-tool-fixture.ts";


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


  test('describes native work navigation without bypassing slash command confirmation', async () => {
    const fixture = makeFixture({ builtinCommands: true });
    try {
      const inspected = await fixture.tool.execute({ mode: 'command', command: '/work daemon-project' });
      expect(inspected.success).toBe(true);
      if (!inspected.success) throw new Error(inspected.error);
      const payload = JSON.parse(inspected.output!) as {
        readonly policy: { readonly effect: string; readonly preferredModelTool: string; readonly confirmation: string; readonly boundary: string };
        readonly lookup: { readonly parsedArgs: readonly string[] };
      };
      expect(payload.policy.effect).toBe('ui-navigation');
      expect(payload.policy.preferredModelTool).toBe('agent_harness mode:"run_command" commandName:"work"');
      expect(payload.policy.confirmation).toContain('current recorded engine admission');
      expect(payload.policy.boundary).toContain('native read-only work ledger');
      expect(payload.policy.boundary).toContain('existing read permissions');
      expect(payload.policy.boundary).toContain('access revocation invalidate the view');
      expect(payload.lookup.parsedArgs).toEqual(['daemon-project']);
      expect(fixture.openedSurfaces).toEqual([]);

      for (const approval of [{ explicitUserRequest: 'Open the native work ledger.' }, { confirm: true }]) {
        await expect(fixture.tool.execute({ mode: 'run_command', command: '/work', ...approval }))
          .rejects.toBeInstanceOf(ToolInputProjectionError);
        expect(fixture.openedSurfaces).toEqual([]);
      }
      const opened = await fixture.admittedTool.execute({
        mode: 'run_command', command: '/work', confirm: true,
        explicitUserRequest: 'Open the native work ledger.',
      });
      expect(opened.success).toBe(true);
      expect(fixture.openedSurfaces).toEqual([{ id: 'agent-workspace', detail: 'work' }]);
    } finally {
      fixture.cleanup();
    }
  });


  test('runs slash commands through the shared command lookup resolver', async () => {
    const fixture = makeFixture();
    try {
      fixture.commandRegistry.register({
        name: 'echoargs',
        description: 'Echo command arguments for resolver coverage',
        handler: (args, ctx) => {
          ctx.print(`args:${args.join('|')}`);
        },
      });
      fixture.commandRegistry.register({
        name: 'memory',
        aliases: ['mem'],
        description: 'Manage Agent-local memory records',
        usage: '<action>',
        handler: (_args, ctx) => {
          ctx.print('memory output');
        },
      });
      fixture.commandRegistry.register({
        name: 'memory-review',
        description: 'Review Agent-local memory records',
        usage: '<id>',
        handler: (_args, ctx) => {
          ctx.print('memory review output');
        },
      });

      const byCommandName = await fixture.admittedTool.execute({
        mode: 'run_command',
        commandName: 'ECHOARGS',
        args: ['one', 'two'],
        confirm: true,
        explicitUserRequest: 'Run echoargs with two arguments.',
      });
      expect(byCommandName.success).toBe(true);
      expect(byCommandName.output).toContain('Command /echoargs completed.');
      expect(byCommandName.output).toContain('Resolved by commandName case-insensitive-name.');
      expect(byCommandName.output).toContain('args:one|two');

      let briefingRuns = 0;
      fixture.commandRegistry.unregister('brief');
      fixture.commandRegistry.register({
        name: 'brief', description: 'Test briefing command',
        handler: (_args, ctx) => { briefingRuns++; ctx.print('briefing output'); },
      });
      const byQuery = await fixture.admittedTool.execute({
        mode: 'run_command',
        query: 'Test briefing command',
        confirm: true,
        explicitUserRequest: 'Show the briefing.',
      });
      expect(byQuery.success).toBe(true);
      expect(JSON.parse(byQuery.output!)).toMatchObject({
        status: 'selection_required', reason: 'exact_command_identity_required',
        candidates: [{ commandName: 'brief', inspectRoute: 'workspace action:"command" commandName:"brief"' }],
      });
      expect(briefingRuns).toBe(0);
      expect(byQuery.output).not.toContain('briefing output');

      const ambiguous = await fixture.admittedTool.execute({
        mode: 'run_command',
        query: 'Agent-local memory records',
        confirm: true,
        explicitUserRequest: 'Run the memory command.',
      });
      expect(ambiguous.success).toBe(false);
      expect(ambiguous.error).toContain('Ambiguous slash command');
      expect(ambiguous.error).toContain('"name":"memory"');
      expect(ambiguous.error).toContain('"name":"memory-review"');
      expect(fixture.printed).not.toContain('memory output');
      expect(fixture.printed).not.toContain('memory review output');
    } finally {
      fixture.cleanup();
    }
  });


  test('inspects one slash command from typed command, target, query, and alias lookups', async () => {
    const fixture = makeFixture();
    try {
      fixture.commandRegistry.register({
        name: 'memory',
        aliases: ['mem'],
        description: 'Manage Agent-local memory records',
        usage: '<action>',
        handler: () => {},
      });
      fixture.commandRegistry.register({
        name: 'memory-review',
        description: 'Review Agent-local memory records',
        usage: '<id>',
        handler: () => {},
      });

      const typed = await fixture.tool.execute({ mode: 'command', command: '/mem list --reviewed' });
      expect(typed.success).toBe(true);
      if (!typed.success) throw new Error(typed.error);
      const typedPayload = JSON.parse(typed.output!) as {
        readonly name: string;
        readonly lookup: {
          readonly source: string;
          readonly parsedName: string;
          readonly parsedArgs: readonly string[];
          readonly resolvedBy: string;
        };
        readonly policy: { readonly preferredModelTool?: string };
      };
      expect(typedPayload.name).toBe('memory');
      expect(typedPayload.lookup.source).toBe('command');
      expect(typedPayload.lookup.parsedName).toBe('mem');
      expect(typedPayload.lookup.parsedArgs).toEqual(['list', '--reviewed']);
      expect(typedPayload.lookup.resolvedBy).toBe('alias');
      expect(typedPayload.policy.preferredModelTool).toBe('agent_local_registry');

      const target = await fixture.tool.execute({ mode: 'command', target: '/BRIEF' });
      expect(target.success).toBe(true);
      expect(target.output).toContain('"resolvedBy": "case-insensitive-name"');
      expect(target.output).toContain('"name": "brief"');

      const described = await fixture.tool.execute({ mode: 'command', query: 'Test briefing command' });
      expect(described.success).toBe(true);
      expect(described.output).toContain('"resolvedBy": "description"');
      expect(described.output).toContain('"name": "brief"');

      const ambiguous = await fixture.tool.execute({ mode: 'command', query: 'Agent-local memory records' });
      expect(ambiguous.success).toBe(true);
      expect(ambiguous.output).toContain('"status": "ambiguous"');
      expect(ambiguous.output).toContain('"name": "memory"');
      expect(ambiguous.output).toContain('"name": "memory-review"');

      const missing = await fixture.tool.execute({ mode: 'command', query: 'not-a-command' });
      expect(missing.success).toBe(false);
      expect(missing.error).toContain('Unknown slash command');
      expect(missing.error).toContain('mode:"commands"');
    } finally {
      fixture.cleanup();
    }
  });


  test('assigns concrete model policy metadata to every built-in slash command', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    const unknownPolicies = registry.list()
      .filter((command) => describeCommandPolicy(command.name).effect === 'unknown')
      .map((command) => command.name)
      .sort((a, b) => a.localeCompare(b));
    expect(unknownPolicies).toEqual([]);

    const missingPreferredRoutes = registry.list()
      .filter((command) => !describeCommandPolicy(command.name).preferredModelTool)
      .map((command) => command.name)
      .sort((a, b) => a.localeCompare(b));
    expect(missingPreferredRoutes).toEqual([]);

    const staleHarnessRoutes = registry.list()
      .map((command) => [command.name, describeCommandPolicy(command.name).preferredModelTool ?? ''] as const)
      .filter(([, route]) => /agent_harness (?!mode:")/.test(route))
      .map(([command, route]) => `${command}: ${route}`)
      .sort((a, b) => a.localeCompare(b));
    expect(staleHarnessRoutes).toEqual([]);

    expect(describeCommandPolicy('agent')).toMatchObject({
      effect: 'ui-navigation',
      preferredModelTool: expect.stringContaining('workspace_actions'),
    });
    // /context window <size> writes a persisted override: never labelled read-only.
    expect(describeCommandPolicy('context')).toMatchObject({ effect: 'mixed' });
    expect(describeCommandPolicy('context').boundary).toContain('/context window <size> writes');
    expect(describeCommandPolicy('status').effect).toBe('read-only');
    expect(describeCommandPolicy('brief')).toMatchObject({
      effect: 'read-only',
      preferredModelTool: 'agent_operator_briefing',
    });
    expect(describeCommandPolicy('refresh-models')).toMatchObject({
      effect: 'external-network',
    });
    expect(describeCommandPolicy('export')).toMatchObject({
      effect: 'local-state',
      preferredModelTool: expect.stringContaining('workspace_actions'),
    });
    expect(describeCommandPolicy('delegate')).toMatchObject({
      effect: 'delegated-work',
      preferredModelTool: expect.stringContaining('run_workspace_action'),
    });
    expect(describeCommandPolicy('next-error')).toMatchObject({
      effect: 'ui-navigation',
      preferredModelTool: 'agent_harness mode:"run_command"',
    });
    expect(describeCommandPolicy('clear')).toMatchObject({
      effect: 'session-lifecycle',
      preferredModelTool: expect.stringContaining('run_command'),
    });
    expect(describeCommandPolicy('notes')).toMatchObject({
      effect: 'ui-navigation',
      preferredModelTool: expect.stringContaining('agent_local_registry'),
    });
    expect(describeCommandPolicy('bookmarks')).toMatchObject({
      effect: 'ui-navigation',
      preferredModelTool: expect.stringContaining('open_ui_surface'),
    });
    expect(describeCommandPolicy('bookmarks').preferredModelTool).toContain('run_command');
    expect(describeCommandPolicy('keybindings')).toMatchObject({
      effect: 'read-only',
      preferredModelTool: expect.stringContaining('run_keybinding'),
    });
  });


  test('assigns preferred model routes to every supported top-level CLI mirror', () => {
    const missingPreferredRoutes = listGoodVibesCliCommands()
      .filter((command) => command !== 'unknown')
      .filter((command) => !describeCliCommandPolicy(command).preferredModelTool)
      .sort((a, b) => a.localeCompare(b));
    expect(missingPreferredRoutes).toEqual([]);

    const staleHarnessRoutes = listGoodVibesCliCommands()
      .filter((command) => command !== 'unknown')
      .map((command) => [command, describeCliCommandPolicy(command).preferredModelTool ?? ''] as const)
      .filter(([, route]) => /agent_harness (?!mode:")/.test(route))
      .map(([command, route]) => `${command}: ${route}`)
      .sort((a, b) => a.localeCompare(b));
    expect(staleHarnessRoutes).toEqual([]);

    expect(describeCliCommandPolicy('run')).toMatchObject({
      effect: 'mixed',
      preferredModelTool: expect.stringContaining('current Agent conversation'),
    });
    expect(describeCliCommandPolicy('delegate')).toMatchObject({
      effect: 'delegated-work',
      preferredModelTool: expect.stringContaining('run_workspace_action'),
    });
    expect(describeCliCommandPolicy('pair')).toMatchObject({
      effect: 'external-network',
      preferredModelTool: expect.stringContaining('workspace_actions'),
    });
    expect(describeCliCommandPolicy('secrets')).toMatchObject({
      effect: 'mixed',
      preferredModelTool: expect.stringContaining('settings'),
    });
    expect(describeCliCommandPolicy('subscription')).toMatchObject({
      effect: 'mixed',
      preferredModelTool: expect.stringContaining('workspace_actions'),
    });
  });


  // DELETED: 'runs command-backed workspace actions through id and command lookups'
  // brief action was removed from the workspace.;

  test('previews and applies GoodVibes settings import through workspace action route', async () => {
    const fixture = makeFixture();
    try {
      const nextSaveHistory = !Boolean(fixture.configManager.get('behavior.saveHistory'));
      mkdirSync(fixture.paths.resolveUserPath('tui'), { recursive: true });
      writeFileSync(fixture.paths.resolveUserPath('tui', 'settings.json'), JSON.stringify({
        behavior: { saveHistory: nextSaveHistory },
        surfaces: {
          slack: { botToken: 'xoxb-import-secret' },
        },
      }, null, 2));

      const preview = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'import-goodvibes-tui-settings',
      });
      expect(preview.success).toBe(true);
      expect(preview.output).toContain('"status": "confirmation_required"');
      expect(preview.output).toContain('"settingsToImport": 2');
      expect(preview.output).toContain('<redacted>');
      expect(preview.output).not.toContain('xoxb-import-secret');
      expect(fixture.configManager.get('behavior.saveHistory')).toBe(!nextSaveHistory);

      fixture.configManager.flushConfigFileChanges();
      const configBefore = JSON.stringify(fixture.configManager.getRaw());
      const configPaths = [fixture.configManager.getConfigPath(), fixture.configManager.getProjectConfigPath()]
        .filter((path): path is string => typeof path === 'string');
      const configFilesBefore = configPaths.map(path => existsSync(path) ? readFileSync(path) : null);
      const importSourcePath = fixture.paths.resolveUserPath('tui', 'settings.json');
      const importSourceBefore = readFileSync(importSourcePath);
      const secretBefore = await fixture.secretsManager?.get(buildGoodVibesSecretKey('surfaces.slack.botToken'));
      const missingUserRequest = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'import-goodvibes-tui-settings',
        confirm: true,
      });
      expect(missingUserRequest.success).toBe(false);
      expect(missingUserRequest.error).toContain('current recorded effect-owner admission');
      expect(JSON.stringify(fixture.configManager.getRaw())).toBe(configBefore);
      expect(configPaths.map(path => existsSync(path) ? readFileSync(path) : null)).toEqual(configFilesBefore);
      expect(readFileSync(importSourcePath)).toEqual(importSourceBefore);
      expect(await fixture.secretsManager?.get(buildGoodVibesSecretKey('surfaces.slack.botToken'))).toBe(secretBefore);

      const originalSource = { goal: 'Verify the exact Agent harness operation requested by this isolated test',
        criteria: ['Only modify temporary fixture files, stubbed service owners, and explicitly configured loopback hosts'] };
      const expectedSettingsProposal = {
        key: 'behavior.saveHistory', value: 'null',
        invocation: { mode: 'set', actionId: 'import-goodvibes-tui-settings', confirm: true,
          explicitUserRequest: 'Import my existing GoodVibes settings into Agent.', key: 'behavior.saveHistory' },
        source: originalSource, request: JSON.stringify(originalSource),
        effect: { operation: 'set', key: 'behavior.saveHistory', appliedBy: 'local', import: 'goodvibes-tui',
          sources: [{ path: importSourcePath, present: true }, { path: importSourcePath, present: true },
            { path: fixture.paths.resolveUserPath('tui', 'subscriptions.json'), present: false }],
          effects: [{ operation: 'set', key: 'behavior.saveHistory', value: nextSaveHistory,
            destinations: [{ path: fixture.paths.resolveUserPath('agent', 'settings.json'), tier: 'global', operation: 'set' }] },
          { operation: 'set', key: 'surfaces.slack.botToken',
            value: buildGoodVibesSecretRef(buildGoodVibesSecretKey('surfaces.slack.botToken')),
            destinations: [{ path: fixture.paths.resolveUserPath('daemon', 'settings.json'), tier: 'daemon', operation: 'set' }] }],
          credential: { operation: 'import', beforeGeneration: 0,
            items: [{ key: buildGoodVibesSecretKey('surfaces.slack.botToken'), scope: 'daemon', configured: true }],
            destinations: [{ path: join(fixture.root, '.goodvibes', 'secrets.key'), operation: 'set', tier: 'keyfile' },
              { path: fixture.paths.resolveUserPath('daemon', 'secrets.enc'), operation: 'set', tier: 'daemon' }] },
          skippedSubscriptions: 0 },
      };
      const battery = gateJudgmentRegistry.get('engine.gate.settings-hazard');
      if (!battery || !('items' in battery) || !battery.items || typeof battery.items !== 'object') {
        throw new Error('Canonical settings import question schema is unavailable.');
      }
      const questions = Object.fromEntries(Object.entries(battery.items).map(([name, item]) => {
        if (!item || typeof item !== 'object' || !('question' in item)) throw new Error('Invalid canonical settings import question.');
        return [name, item.question];
      }));
      expect(Object.keys(questions).sort()).toEqual(['hazard', 'requested']);
      const settingsReadings = fakePort((name, question, state) => {
        expect<unknown>(state).toEqual(expectedSettingsProposal);
        expect<unknown>(question).toEqual(questions[name]);
        if (name === 'hazard' && question.type === 'choice' && Object.hasOwn(question.criteria, 'none')) {
          return choiceAnswer(question, 'none', 0.999);
        }
        if (name === 'requested' && question.type === 'noul') return noulAnswer(0.001);
        throw new Error('Unexpected exact settings import observation.');
      });
      const base = judgmentPort('agent.harness.settings-import-fixture');
      using settingsLog = new SqliteDecisionLog(':memory:');
      const scoped: JudgmentPort = { model: base.model, ask(request) {
        if (request.context?.battery !== 'engine.gate.settings-hazard') return base.ask(request);
        if (request.context.site !== 'engine.gate.settings-write') throw new Error('Unexpected settings import observation site.');
        expect<unknown>(request.questions).toEqual(questions);
        expect<unknown>(request.state).toEqual(expectedSettingsProposal);
        return settingsReadings.port.ask(request);
      } };
      const previous = installJudgmentPort(withDecisionLog(scoped, settingsLog));
      let applied: Awaited<ReturnType<Tool['execute']>>;
      try {
        applied = await fixture.admittedTool.execute({
          mode: 'run_workspace_action',
          actionId: 'import-goodvibes-tui-settings',
          confirm: true,
          explicitUserRequest: 'Import my existing GoodVibes settings into Agent.',
        });
      } finally { installJudgmentPort(previous); }
      expect(applied.success, JSON.stringify(applied)).toBe(true);
      if (!applied.success || typeof applied.output !== 'string') throw new Error('Native settings import did not return its committed receipt.');
      const receipt: unknown = JSON.parse(applied.output);
      expect(receipt).toMatchObject({ status: 'committed', action: 'import_goodvibes_settings',
        verifiedInOwningStore: true, completedPaths: expect.any(Array) });
      expect(applied.output).not.toContain('xoxb-import-secret');
      expect(fixture.configManager.get('behavior.saveHistory')).toBe(nextSaveHistory);
      expect(fixture.configManager.get('surfaces.slack.botToken')).toBe(
        buildGoodVibesSecretRef(buildGoodVibesSecretKey('surfaces.slack.botToken')),
      );
      expect(await fixture.secretsManager?.get(buildGoodVibesSecretKey('surfaces.slack.botToken'))).toBe('xoxb-import-secret');
      expect(configPaths.map(path => existsSync(path) ? readFileSync(path) : null)).not.toEqual(configFilesBefore);
      expect(readFileSync(importSourcePath)).toEqual(importSourceBefore);
    } finally {
      fixture.cleanup();
    }
  });


  test('runs workspace actions by target and query without guessing ambiguous requests', async () => {
    const fixture = makeFixture();
    try {
      const memoryRegistry = await createMemoryRegistry(fixture.paths, fixture.configManager);
      registerAgentLocalRegistryTool(fixture.toolRegistry, fixture.paths, memoryRegistry, createLocalMemoryAccess(memoryRegistry));

      const targetRun = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        categoryId: 'notes',
        target: 'Create note',
        fields: {
          title: 'Lookup mirror note',
          body: 'Target lookup should execute the same workspace editor as an exact action id.',
          tags: 'harness,lookup',
        },
        confirm: true,
        explicitUserRequest: 'Create a note through workspace action lookup.',
      });
      expect(targetRun.success).toBe(true);
      expect(targetRun.output).toContain('"status": "executed_model_tool"');
      expect(targetRun.output).toContain('Created Agent-local note');
      const note = AgentNoteRegistry.fromShellPaths(fixture.paths).get('lookup-mirror-note');
      expect(note?.body).toContain('Target lookup should execute');

      const queryRun = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        query: 'durable non-secret default knowledge fallback',
        fields: {
          summary: 'Lookup execution preserves Agent-local memory only.',
          detail: 'Query lookup should execute the same workspace editor as an exact memory action id.',
          tags: 'harness,lookup',
        },
        confirm: true,
        explicitUserRequest: 'Create a memory through workspace action lookup.',
      });
      expect(queryRun.success).toBe(true);
      expect(queryRun.output).toContain('"status": "executed_model_tool"');
      expect(queryRun.output).toContain('Created Agent-local memory');
      expect(memoryRegistry.getAll().map((entry) => entry.summary)).toContain('Lookup execution preserves Agent-local memory only.');

      const ambiguous = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        query: 'memory',
        confirm: true,
        explicitUserRequest: 'Run the memory action.',
      });
      expect(ambiguous.success).toBe(false);
      expect(ambiguous.error).toContain('requires a valid actionId, command, target, or query');
    } finally {
      fixture.cleanup();
    }
  });


  test('routes selection-based local workspace actions through model tools', async () => {
    const fixture = makeFixture();
    try {
      const memoryRegistry = await createMemoryRegistry(fixture.paths, fixture.configManager);
      registerAgentLocalRegistryTool(fixture.toolRegistry, fixture.paths, memoryRegistry, createLocalMemoryAccess(memoryRegistry));
      const note = AgentNoteRegistry.fromShellPaths(fixture.paths).create({
        title: 'Daily triage',
        body: 'Read the queue, sort urgent items first, and summarize blocked work.',
        tags: ['workflow'],
        source: 'agent',
        provenance: 'test',
      });

      const preview = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'notes-to-skill',
        recordId: note.id,
      });
      expect(preview.success).toBe(true);
      expect(preview.output).toContain('"status": "editor"');
      expect(preview.output).toContain('Create Skill From Note');
      expect(preview.output).toContain('Read the queue');

      const promoted = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'notes-to-skill',
        recordId: note.id,
        fields: { enabled: 'yes' },
        confirm: true,
        explicitUserRequest: 'Promote the triage note into a skill.',
      });
      expect(promoted.success).toBe(true);
      expect(promoted.output).toContain('executed_model_tool');
      const skill = AgentSkillRegistry.fromShellPaths(fixture.paths).get('daily-triage');
      expect(skill?.procedure).toContain('Read the queue');
      expect(skill?.enabled).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });


  test('runs direct local create workspace editors through model tools', async () => {
    const fixture = makeFixture();
    try {
      const memoryRegistry = await createMemoryRegistry(fixture.paths, fixture.configManager);
      registerAgentLocalRegistryTool(fixture.toolRegistry, fixture.paths, memoryRegistry, createLocalMemoryAccess(memoryRegistry));

      const missingFields = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'notes-create',
        fields: { title: 'Source triage' },
        confirm: true,
        explicitUserRequest: 'Create a source-triage note.',
      });
      expect(missingFields.success).toBe(true);
      expect(missingFields.output).toContain('"status": "missing_required_fields"');
      expect(missingFields.output).toContain('"body"');

      const created = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'notes-create',
        fields: {
          title: 'Source triage',
          body: 'Capture reviewed sources before deciding what belongs in Agent Knowledge.',
          tags: 'research,triage',
        },
        confirm: true,
        explicitUserRequest: 'Create a source-triage note.',
      });
      expect(created.success).toBe(true);
      expect(created.output).toContain('"status": "executed_model_tool"');
      expect(created.output).toContain('Created Agent-local note');

      const note = AgentNoteRegistry.fromShellPaths(fixture.paths).get('source-triage');
      expect(note?.title).toBe('Source triage');
      expect(note?.body).toContain('reviewed sources');
      expect(note?.tags).toEqual(['research', 'triage']);
    } finally {
      fixture.cleanup();
    }
  });


  test('runs Agent document workspace editors through agent_documents', async () => {
    const artifacts = createHarnessArtifactStore();
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      registerAgentDocumentsTool(fixture.toolRegistry, fixture.paths, artifacts.store);

      const unconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-create-draft',
        confirm: true,
        explicitUserRequest: 'Create a launch document draft.',
        fields: {
          title: 'Launch Plan',
          body: 'Initial launch draft.',
          confirm: 'no',
        },
      });
      expect(unconfirmed.success).toBe(false);
      expect(unconfirmed.error).toContain('current recorded effect admission');
      expect(AgentDocumentRegistry.fromShellPaths(fixture.paths).list()).toEqual([]);
      expect(artifacts.store.list()).toEqual([]);

      const created = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-create-draft',
        confirm: true,
        explicitUserRequest: 'Create a launch document draft.',
        fields: {
          title: 'Launch Plan',
          body: 'Initial launch draft.',
          tags: 'launch,docs',
          confirm: 'yes',
        },
      });
      expect(created.success).toBe(true);
      expect(created.output).toContain('"tool": "agent_documents"');
      expect(created.output).toContain('Created Agent document');
      expect(created.output).toContain('launch-plan');

      const revised = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-revise-draft',
        confirm: true,
        explicitUserRequest: 'Revise the launch document draft.',
        fields: {
          documentId: 'launch-plan',
          body: 'Initial launch draft.\n\nAdd rollout checklist.',
          changeSummary: 'Added rollout checklist.',
          confirm: 'yes',
        },
      });
      expect(revised.success).toBe(true);
      expect(revised.output).toContain('versions 2');

      const commented = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-comment-draft',
        confirm: true,
        explicitUserRequest: 'Add a review comment to the launch document draft.',
        fields: {
          documentId: 'launch-plan',
          comment: 'Confirm launch owner.',
          confirm: 'yes',
        },
      });
      expect(commented.success).toBe(true);
      expect(commented.output).toContain('"tool": "agent_documents"');
      expect(commented.output).toContain('Added Agent document comment');
      expect(commented.output).toContain('comment c1');

      const resolvedComment = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-resolve-comment',
        confirm: true,
        explicitUserRequest: 'Resolve the launch document review comment.',
        fields: {
          documentId: 'launch-plan',
          commentId: 'c1',
          confirm: 'yes',
        },
      });
      expect(resolvedComment.success).toBe(true);
      expect(resolvedComment.output).toContain('Resolved Agent document comment');

      const suggested = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-suggest-draft',
        confirm: true,
        explicitUserRequest: 'Propose an AI suggestion for the launch document draft.',
        fields: {
          documentId: 'launch-plan',
          body: 'Initial launch draft.\n\nAdd rollout checklist.\n\nOwner: Launch team.',
          changeSummary: 'Added launch owner.',
          suggestionRationale: 'The launch plan needs a visible owner before review.',
          confirm: 'yes',
        },
      });
      expect(suggested.success).toBe(true);
      expect(suggested.output).toContain('"tool": "agent_documents"');
      expect(suggested.output).toContain('Added Agent document suggestion');
      expect(suggested.output).toContain('suggestion s1');
      expect(suggested.output).toContain('versions 2');

      const acceptedSuggestion = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-accept-suggestion',
        confirm: true,
        explicitUserRequest: 'Accept the launch document suggestion.',
        fields: {
          documentId: 'launch-plan',
          suggestionId: 's1',
          confirm: 'yes',
        },
      });
      expect(acceptedSuggestion.success).toBe(true);
      expect(acceptedSuggestion.output).toContain('Accepted Agent document suggestion');
      expect(acceptedSuggestion.output).toContain('versions 3');

      const rejectCandidate = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-suggest-draft',
        confirm: true,
        explicitUserRequest: 'Propose a second launch document suggestion.',
        fields: {
          documentId: 'launch-plan',
          body: 'Rejected launch rewrite.',
          changeSummary: 'Alternative rewrite.',
          suggestionRationale: 'This is a less useful option.',
          confirm: 'yes',
        },
      });
      expect(rejectCandidate.success).toBe(true);
      expect(rejectCandidate.output).toContain('suggestion s2');

      const rejectedSuggestion = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-reject-suggestion',
        confirm: true,
        explicitUserRequest: 'Reject the second launch document suggestion.',
        fields: {
          documentId: 'launch-plan',
          suggestionId: 's2',
          confirm: 'yes',
        },
      });
      expect(rejectedSuggestion.success).toBe(true);
      expect(rejectedSuggestion.output).toContain('Rejected Agent document suggestion');
      expect(rejectedSuggestion.output).toContain('versions 3');

      const sourceArtifact = await artifacts.store.create({
        kind: 'document',
        mimeType: 'text/markdown',
        filename: 'source-note.md',
        text: 'Reusable source note.',
        metadata: { purpose: 'source-note' },
      });
      const attached = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-attach-artifact',
        confirm: true,
        explicitUserRequest: 'Attach the source artifact to the launch document draft.',
        fields: {
          documentId: 'launch-plan',
          artifactId: sourceArtifact.id,
          attachmentLabel: 'Source Note',
          attachmentNote: 'Reusable evidence for this draft.',
          confirm: 'yes',
        },
      });
      expect(attached.success).toBe(true);
      expect(attached.output).toContain('"tool": "agent_documents"');
      expect(attached.output).toContain('Attached artifact to Agent document');
      expect(attached.output).toContain('attachments 1');
      expect(attached.output).toContain('versions 3');

      const inserted = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-insert-artifact',
        confirm: true,
        explicitUserRequest: 'Insert the source artifact into the launch document draft.',
        fields: {
          documentId: 'launch-plan',
          artifactId: sourceArtifact.id,
          sectionTitle: 'Source Note',
          confirm: 'yes',
        },
      });
      expect(inserted.success).toBe(true);
      expect(inserted.output).toContain('"tool": "agent_documents"');
      expect(inserted.output).toContain('Inserted artifact into Agent document');
      expect(inserted.output).toContain('versions 4');

      const exported = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-export-draft',
        confirm: true,
        explicitUserRequest: 'Export the launch document draft.',
        fields: {
          documentId: 'launch-plan',
          confirm: 'yes',
        },
      });
      expect(exported.success).toBe(true);
      expect(exported.output).toContain('Exported Agent document');
      expect(artifacts.store.list(5)[0]?.metadata).toMatchObject({
        purpose: 'agent-document-export',
        documentId: 'launch-plan',
        attachmentIds: [sourceArtifact.id],
      });
    } finally {
      fixture.cleanup();
    }
  });


  test('runs review packet preset workspace editor through agent_review_packet_presets', async () => {
    const artifacts = createHarnessArtifactStore();
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      registerAgentReviewPacketPresetsTool(fixture.toolRegistry, artifacts.store);
      const documentRegistry = AgentDocumentRegistry.fromShellPaths(fixture.paths);
      const draft = documentRegistry.create({
        title: 'Launch Packet',
        body: 'Reviewed launch packet body.',
        tags: ['launch'],
      });
      const docExport = await artifacts.store.create({
        kind: 'document',
        mimeType: 'text/markdown',
        filename: 'launch-packet.md',
        text: '# Launch Packet',
        metadata: {
          purpose: 'agent-document-export',
          documentId: draft.id,
          versionId: draft.versions.at(-1)?.id ?? '',
        },
      });
      const revealedJudgment = await artifacts.store.create({
        kind: 'data',
        mimeType: 'application/json',
        filename: 'blind-model-comparison-judgment-launch.json',
        text: '{}',
        metadata: {
          purpose: 'agent-model-compare-judgment',
          judgmentId: 'jdg_launch',
          comparisonId: 'cmp_launch',
          winnerBlindId: 'B',
          winnerModel: 'openai:gpt-5.5',
          revealIncludedInJudgment: true,
        },
      });

      const artifactsBefore = artifacts.store.list();
      const unconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-save-review-packet-preset',
        confirm: true,
        explicitUserRequest: 'Save the current review packet preset.',
        fields: {
          confirm: 'no',
        },
      });
      expect(unconfirmed.success).toBe(false);
      expect(unconfirmed.error).toContain('current recorded effect admission');
      expect(artifacts.store.list()).toEqual(artifactsBefore);
      expect(documentRegistry.get(draft.id)).toEqual(draft);

      const saved = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-save-review-packet-preset',
        confirm: true,
        explicitUserRequest: 'Save the current review packet preset.',
        fields: {
          name: 'Launch packet reviewer preset',
          documentId: draft.id,
          documentTitle: 'Launch Packet',
          documentExportArtifactId: docExport.id,
          revealedJudgmentArtifactId: revealedJudgment.id,
          relatedArtifactIds: `${docExport.id}\n${revealedJudgment.id}`,
          confirm: 'yes',
        },
      });
      expect(saved.success).toBe(true);
      expect(saved.output).toContain('"status": "executed_model_tool"');
      expect(saved.output).toContain('"tool": "agent_review_packet_presets"');
      expect(saved.output).toContain('Review packet preset saved');
      expect(artifacts.store.list(1)[0]?.metadata).toMatchObject({
        purpose: 'agent-review-packet-preset',
        name: 'Launch packet reviewer preset',
        documentId: draft.id,
        documentExportArtifactId: docExport.id,
        revealedJudgmentArtifactId: revealedJudgment.id,
        relatedArtifactIds: [docExport.id, revealedJudgment.id],
      });

      const savedPresetId = artifacts.store.list(1)[0]?.id;
      expect(savedPresetId).toBeTruthy();
      const newerDocExport = await artifacts.store.create({
        kind: 'document',
        mimeType: 'text/markdown',
        filename: 'launch-packet-v2.md',
        text: '# Launch Packet v2',
        metadata: {
          purpose: 'agent-document-export',
          documentId: draft.id,
          versionId: `${draft.versions.at(-1)?.id ?? ''}-refresh`,
        },
      });
      const refreshed = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-refresh-review-packet-preset',
        confirm: true,
        explicitUserRequest: 'Refresh the stale review packet preset.',
        fields: {
          artifactId: savedPresetId ?? '',
          name: 'Launch packet refreshed preset',
          confirm: 'yes',
        },
      });
      expect(refreshed.success).toBe(true);
      expect(refreshed.output).toContain('"status": "executed_model_tool"');
      expect(refreshed.output).toContain('"tool": "agent_review_packet_presets"');
      expect(refreshed.output).toContain('Review packet preset refreshed');
      expect(artifacts.store.list(1)[0]?.metadata).toMatchObject({
        purpose: 'agent-review-packet-preset',
        name: 'Launch packet refreshed preset',
        documentId: draft.id,
        documentExportArtifactId: newerDocExport.id,
        refreshOfArtifactId: savedPresetId ?? '',
      });
      const wizard = await executeHarnessJson<{
        readonly reviewPacketWizard?: {
          readonly finalReview?: string;
          readonly presetLineage?: {
            readonly artifactId: string;
            readonly refreshed: boolean;
            readonly refreshedFromArtifactId: string | null;
            readonly freshnessSupersededCount: number | null;
            readonly summary: string;
            readonly inspectRoute: string;
          };
        };
      }>(fixture, { mode: 'document_ops_lane', laneId: 'review_packet_wizard', includeParameters: true });
      expect(wizard.reviewPacketWizard?.presetLineage).toMatchObject({
        artifactId: artifacts.store.list(1)[0]?.id,
        refreshed: true,
        refreshedFromArtifactId: savedPresetId,
        freshnessSupersededCount: 1,
      });
      expect(wizard.reviewPacketWizard?.presetLineage?.summary).toContain('refreshed from');
      expect(wizard.reviewPacketWizard?.presetLineage?.inspectRoute).toContain('agent_review_packet_presets show');
    } finally {
      fixture.cleanup();
    }
  });


  test('runs review packet share workspace editor through agent_review_packet_share', async () => {
    const artifacts = createHarnessArtifactStore();
    const channelRequests: ChannelDeliveryRequest[] = [];
    const archive = await artifacts.store.create({
      kind: 'archive',
      mimeType: 'application/zip',
      filename: 'launch-handoff-archive.zip',
      text: 'zip-bytes-never-printed',
      metadata: {
        purpose: 'agent-model-compare-handoff-archive',
        archiveId: 'hndarc_launch',
        handoffArtifactId: 'artifact-handoff',
        handoffId: 'hnd_launch',
        sourceArtifactId: 'artifact-judgment',
        sourceKind: 'judgment',
        relatedArtifactIds: ['artifact-doc'],
        routeDecisionArtifactIds: ['artifact-route'],
        includedArtifactIds: ['artifact-handoff', 'artifact-judgment', 'artifact-doc', 'artifact-route'],
        comparisonId: 'cmp_launch',
        artifactCount: 4,
        archiveBytes: 4096,
        revealIncludedInHandoff: true,
      },
    });
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      registerAgentReviewPacketShareTool(fixture.toolRegistry, artifacts.store, fakeChannelDeliveryRouter(channelRequests));

      const unconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-share-review-packet',
        confirm: true,
        explicitUserRequest: 'Share the current review packet.',
        fields: {
          channel: 'slack:review:Review',
          confirm: 'no',
        },
      });
      expect(unconfirmed.success).toBe(false);
      expect(unconfirmed.error).toContain('current recorded effect admission');
      expect(artifacts.store.list()).toEqual([archive]);
      expect(channelRequests).toEqual([]);

      const shared = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-share-review-packet',
        confirm: true,
        explicitUserRequest: 'Share the current review packet with the review channel.',
        fields: {
          archiveArtifactId: archive.id,
          title: 'Launch packet',
          message: 'Please review the final packet.',
          channel: 'slack:review:Review',
          confirm: 'yes',
        },
      });
      expect(shared.success).toBe(true);
      expect(shared.output).toContain('"status": "executed_model_tool"');
      expect(shared.output).toContain('"tool": "agent_review_packet_share"');
      expect(shared.output).toContain('Agent review packet shared');
      expect(shared.output).not.toContain('zip-bytes-never-printed');
      const sharedPayload = JSON.parse(shared.output ?? '{}') as { readonly output?: string | null };
      expect(sharedPayload.output).toContain('agent_artifacts mode:"export" artifactId:"artifact-1"');
      expect(channelRequests).toHaveLength(1);
      expect(channelRequests[0]?.body).toContain('Please review the final packet.');
      expect(channelRequests[0]?.body).toContain('Archive: artifact-1');
      expect(channelRequests[0]?.body).toContain('Included artifacts: 4');
    } finally {
      fixture.cleanup();
    }
  });


  test('runs artifact browser workspace editors through agent_artifacts', async () => {
    const artifacts = createHarnessArtifactStore();
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'text/markdown',
      filename: 'comparison-export.md',
      text: 'Saved comparison report\n\nThe winning answer was more concrete.',
      metadata: {
        purpose: 'agent-model-compare-export',
        source: 'agent-model-compare',
        apiKey: 'not-for-transcript',
      },
    });
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'comparison-judgment.json',
      text: '{"winner":"A","reason":"More concrete"}',
      metadata: {
        purpose: 'agent-model-compare-judgment',
        source: 'agent-model-compare',
        secretToken: 'not-for-package',
      },
    });
    const token = 'fixture-artifact-promotion-token';
    const requests: unknown[] = [];
    const host = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const body: unknown = await request.json();
      requests.push(body);
      expect(request.method).toBe('POST');
      expect(new URL(request.url).pathname).toBe('/api/goodvibes-agent/knowledge/ingest/artifact');
      expect(request.headers.get('authorization')).toBe(`Bearer ${token}`);
      expect(body).toEqual({ artifactId: 'artifact-1', title: 'Reviewed comparison report', tags: ['artifact', 'reviewed'],
        connectorId: 'goodvibes-agent-artifact-browser', metadata: { originSurface: 'goodvibes-agent',
          explicitUserRequest: 'Promote the reviewed comparison artifact into Agent Knowledge.' } });
      return Response.json({ source: { id: 'synthetic-promoted-source', canonicalUri: 'artifact:artifact-1' }, artifactId: 'artifact-1' });
    } });
    if (host.port === undefined) throw new Error('Synthetic Knowledge handoff listener is unavailable.');
    const fixture = makeFixture({ artifactStore: artifacts.store, controlPlanePort: host.port });
    const previousEnv = clearEnvForTest(CONNECTED_HOST_AUTH_ENV_KEYS);
    try {
      registerAgentArtifactsTool(fixture.toolRegistry, artifacts.store, { projectRoot: fixture.root });
      writeConnectedHostOperatorToken(fixture, token);
      registerAgentKnowledgeIngestTool(fixture.toolRegistry, fixture.paths, fixture.configManager);

      const browse = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-browse-artifacts',
        fields: {
          purpose: 'model-compare-export',
          limit: '10',
        },
      });
      expect(browse.success).toBe(true);
      expect(browse.output).toContain('"status": "executed_model_tool"');
      expect(browse.output).toContain('"tool": "agent_artifacts"');
      expect(browse.output).toContain('comparison-export.md');
      expect(browse.output).not.toContain('not-for-transcript');

      const show = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-show-artifact',
        fields: {
          artifactId: 'artifact-1',
          includeContent: 'yes',
          previewBytes: '48',
        },
      });
      expect(show.success).toBe(true);
      expect(show.output).toContain('"status": "executed_model_tool"');
      expect(show.output).toContain('"tool": "agent_artifacts"');
      const showPayload = JSON.parse(show.output ?? '{}') as { readonly output?: string | null };
      expect(showPayload.output).toContain('Saved comparison report');
      expect(showPayload.output).toContain('"apiKey": "<redacted>"');
      expect(showPayload.output).not.toContain('not-for-transcript');

      const unconfirmedExport = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-export-artifact-file',
        confirm: true,
        explicitUserRequest: 'Export the reviewed comparison artifact to a workspace file.',
        fields: {
          artifactId: 'artifact-1',
          destinationPath: 'exports/comparison-export.md',
          confirm: 'no',
        },
      });
      expect(unconfirmedExport.success).toBe(false);
      expect(unconfirmedExport.error).toContain('current recorded effect admission');
      expect(existsSync(join(fixture.root, 'exports', 'comparison-export.md'))).toBe(false);

      const artifactExport = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-export-artifact-file',
        confirm: true,
        explicitUserRequest: 'Export the reviewed comparison artifact to a workspace file.',
        fields: {
          artifactId: 'artifact-1',
          destinationPath: 'exports/comparison-export.md',
          confirm: 'yes',
        },
      });
      expect(artifactExport.success).toBe(true);
      expect(artifactExport.output).toContain('"tool": "agent_artifacts"');
      expect(artifactExport.output).toContain('Exported Agent artifact');
      expect(readFileSync(join(fixture.root, 'exports', 'comparison-export.md'), 'utf-8')).toContain('Saved comparison report');

      const unconfirmedPackage = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-export-artifact-package',
        confirm: true,
        explicitUserRequest: 'Export the reviewed comparison artifacts to a workspace package directory.',
        fields: {
          artifactIds: 'artifact-1\nartifact-2',
          destinationPath: 'exports/comparison-package',
          confirm: 'no',
        },
      });
      expect(unconfirmedPackage.success).toBe(false);
      expect(unconfirmedPackage.error).toContain('current recorded effect admission');
      expect(existsSync(join(fixture.root, 'exports', 'comparison-package'))).toBe(false);

      const packageExport = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-export-artifact-package',
        confirm: true,
        explicitUserRequest: 'Export the reviewed comparison artifacts to a workspace package directory.',
        fields: {
          artifactIds: 'artifact-1\nartifact-2',
          destinationPath: 'exports/comparison-package',
          confirm: 'yes',
        },
      });
      expect(packageExport.success).toBe(true);
      expect(packageExport.output).toContain('"tool": "agent_artifacts"');
      expect(packageExport.output).toContain('Exported Agent artifact package');
      const packageRoot = join(fixture.root, 'exports', 'comparison-package');
      expect(existsSync(join(packageRoot, 'README.md'))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'manifest.json'), 'utf-8')) as {
        readonly artifacts: Array<{ readonly id: string; readonly file: string; readonly metadata: Record<string, unknown> }>;
      };
      expect(manifest.artifacts.map((entry) => entry.id)).toEqual(['artifact-1', 'artifact-2']);
      expect(manifest.artifacts[1]?.metadata.secretToken).toBe('<redacted>');
      const packageFile = manifest.artifacts.find((entry) => entry.id === 'artifact-2')?.file;
      expect(readFileSync(join(packageRoot, packageFile ?? ''), 'utf-8')).toContain('"winner"');
      expect(packageExport.output).not.toContain('not-for-package');

      const unconfirmedPromotion = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-promote-artifact',
        confirm: true,
        explicitUserRequest: 'Promote the reviewed comparison artifact into Agent Knowledge.',
        fields: {
          artifactId: 'artifact-1',
          confirm: 'no',
        },
      });
      expect(unconfirmedPromotion.success).toBe(false);
      expect(unconfirmedPromotion.error).toContain('current recorded effect admission');
      expect(requests).toEqual([]);

      const promotion = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-promote-artifact',
        confirm: true,
        explicitUserRequest: 'Promote the reviewed comparison artifact into Agent Knowledge.',
        fields: {
          artifactId: 'artifact-1',
          title: 'Reviewed comparison report',
          tags: 'artifact,reviewed',
          confirm: 'yes',
        },
      });
      expect(promotion.success).toBe(true);
      expect(promotion.output).toContain('"status": "executed_model_tool"');
      expect(promotion.output).toContain('"tool": "agent_knowledge_ingest"');
      expect(promotion.output).toContain('Agent Knowledge artifact ingest accepted');
      expect(promotion.output).toContain('synthetic-promoted-source');
      expect(promotion.output).not.toContain(token);
      expect(requests).toHaveLength(1);
    } finally {
      fixture.cleanup();
      restoreEnvForTest(previousEnv);
      host.stop(true);
    }
  });


  test('runs confirmed research report workspace editor through agent_research_report', async () => {
    const artifacts = createHarnessArtifactStore();
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      registerAgentResearchReportTool(fixture.toolRegistry, artifacts.store, ordinaryResearchOwner());

      const unconfirmedArgs = {
        mode: 'run_workspace_action',
        actionId: 'research-save-report',
        confirm: true,
        explicitUserRequest: 'Save the reviewed local-model research report.',
        fields: {
          title: 'Local Model Options',
          question: 'Which local model route should we try?',
          summary: 'Ollama is easiest.',
          sources: 'Ollama docs | https://example.test/ollama?token=secret | high | Official docs.',
          confirm: 'no',
        },
      };
      fixture.configManager.set('permissions.mode', 'plan');
      fixture.configManager.flushConfigFileChanges();
      const configBefore = JSON.stringify(fixture.configManager.getRaw());
      const configPaths = [fixture.configManager.getConfigPath(), fixture.configManager.getProjectConfigPath()]
        .filter((path): path is string => typeof path === 'string');
      const configFilesBefore = configPaths.map(path => existsSync(path) ? readFileSync(path) : null);
      const id = 'harness-research-report-refusal';
      const call = await fixture.toolRegistry.prepareCall(id, fixture.tool.definition.name, unconfirmedArgs);
      const source = { goal: 'Verify the exact Agent harness operation requested by this isolated test',
        criteria: ['Only modify temporary fixture files, stubbed service owners, and explicitly configured loopback hosts'] };
      const admission = await fixture.permissionManager.admitAutonomous(id, call.name, call.args, {
        sourceOf: () => source, schemaRevision: call.schemaRevision, preparedCall: { registry: fixture.toolRegistry, call },
      });
      expect(admission.result.approved).toBe(false);
      expect(admission.result.autonomousDecision).toBeUndefined();
      await expect(fixture.toolRegistry.executePrepared(call, admission)).rejects.toThrow(
        'Autonomous admission does not authenticate this prepared tool call',
      );
      expect(artifacts.records).toEqual([]);
      expect(JSON.stringify(fixture.configManager.getRaw())).toBe(configBefore);
      expect(configPaths.map(path => existsSync(path) ? readFileSync(path) : null)).toEqual(configFilesBefore);

      fixture.configManager.set('permissions.mode', 'prompt');
      const saved = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'research-save-report',
        confirm: true,
        explicitUserRequest: 'Save the reviewed local-model research report.',
        fields: {
          title: 'Local Model Options',
          question: 'Which local model route should we try?',
          summary: 'Ollama is easiest.',
          reportMarkdown: 'Ollama is easiest [S1].',
          sources: 'Ollama docs | https://example.test/ollama?token=secret | high | Official docs.',
          findings: 'Use Ollama first.',
          gaps: 'Benchmark latency locally.',
          recommendations: 'Try Ollama before adding another provider.',
          methodology: 'Reviewed only source lines explicitly provided in the form.',
          confidence: 'medium',
          tags: 'research,local',
          confirm: 'yes',
        },
      });
      expect(saved.success).toBe(true);
      expect(saved.output).toContain('"status": "executed_model_tool"');
      expect(saved.output).toContain('"tool": "agent_research_report"');
      expect(saved.output).toContain('Saved Agent research report artifact');
      expect(saved.output).toContain('visualReport markdown-visual-report-packet');
      expect(saved.output).not.toContain('Ollama is easiest [S1].');
      expect(saved.output).not.toContain('token=secret');

      const artifact = artifacts.store.list(1)[0];
      expect(artifact?.filename).toBe('local-model-options.md');
      expect(artifact?.metadata).toMatchObject({
        purpose: 'agent-research-report',
        source: 'agent-research-report',
        title: 'Local Model Options',
        question: 'Which local model route should we try?',
        sourceCount: 1,
        tags: ['research', 'local'],
        visualReport: {
          format: 'markdown-visual-report-packet',
          sourceCount: 1,
          findingCount: 1,
          gapCount: 1,
          recommendationCount: 1,
        },
      });
      expect(artifact?.metadata.sources).toEqual([{
        id: 'S1',
        title: 'Ollama docs',
        urlOmitted: true,
        credibility: 'high',
        note: 'Official docs.',
      }]);
      expect(JSON.stringify(artifact?.metadata)).not.toContain('token=secret');
    } finally {
      fixture.cleanup();
    }
  });


  test('runs confirmed research source workspace editor through agent_research_sources', async () => {
    const fixture = makeFixture();
    try {
      registerAgentResearchSourcesTool(fixture.toolRegistry, fixture.paths);

      const unconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'research-add-source',
        confirm: true,
        explicitUserRequest: 'Add the reviewed Ollama source to the research queue.',
        fields: {
          question: 'Which local model route should we try?',
          title: 'Ollama docs',
          url: 'https://example.test/ollama?token=secret',
          summary: 'Official docs for the simplest local model setup.',
          confirm: 'no',
        },
      });
      expect(unconfirmed.success).toBe(false);
      expect(unconfirmed.error).toContain('current recorded effect admission');
      expect(AgentResearchSourceRegistry.fromShellPaths(fixture.paths).list()).toEqual([]);

      const saved = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'research-add-source',
        confirm: true,
        explicitUserRequest: 'Add the reviewed Ollama source to the research queue.',
        fields: {
          question: 'Which local model route should we try?',
          title: 'Ollama docs',
          url: 'https://example.test/ollama?token=secret',
          publisher: 'Ollama',
          publishedAt: '2026-06-01',
          summary: 'Official docs for the simplest local model setup.',
          evidence: 'Setup is local and minimal.',
          credibility: 'high',
          score: '92',
          tags: 'research,local',
          note: 'Official source for the first recommendation.',
          confirm: 'yes',
        },
      });
      expect(saved.success).toBe(true);
      expect(saved.output).toContain('"status": "executed_model_tool"');
      expect(saved.output).toContain('"tool": "agent_research_sources"');
      expect(saved.output).toContain('Added Agent research source');
      expect(saved.output).not.toContain('token=secret');

      const source = AgentResearchSourceRegistry.fromShellPaths(fixture.paths).get('ollama-docs');
      expect(source?.question).toBe('Which local model route should we try?');
      expect(source?.url).toContain('token=%3Credacted%3E');
      expect(source?.url).not.toContain('token=secret');
      expect(source?.credibility).toBe('high');
      expect(source?.status).toBe('reviewed');
      expect(source?.score).toBe(92);
      expect(source?.tags).toEqual(['research', 'local']);
    } finally {
      fixture.cleanup();
    }
  });


  test('runs confirmed research run workspace editor through agent_research_runs', async () => {
    const fixture = makeFixture();
    try {
      registerAgentResearchRunsTool(fixture.toolRegistry, fixture.paths);

      const unconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'research-start-run',
        confirm: true,
        explicitUserRequest: 'Create a visible competitor research run.',
        fields: {
          title: 'Competitor Research',
          question: 'Which competitor features should we match?',
          goal: 'Produce a sourced parity plan.',
          confirm: 'no',
        },
      });
      expect(unconfirmed.success).toBe(false);
      expect(unconfirmed.error).toContain('current recorded effect admission');
      expect(AgentResearchRunRegistry.fromShellPaths(fixture.paths).list()).toEqual([]);

      const saved = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'research-start-run',
        confirm: true,
        explicitUserRequest: 'Create a visible competitor research run.',
        fields: {
          title: 'Competitor Research',
          question: 'Which competitor features should we match?',
          goal: 'Produce a sourced parity plan.',
          plan: 'Inventory OpenClaw\nInventory Hermes',
          nextSteps: 'Capture official source ids',
          sourceIds: 'openclaw-docs,hermes-docs',
          note: 'Visible run state only.',
          confirm: 'yes',
        },
      });
      expect(saved.success).toBe(true);
      expect(saved.output).toContain('"status": "executed_model_tool"');
      expect(saved.output).toContain('"tool": "agent_research_runs"');
      expect(saved.output).toContain('Created Agent research run');

      const run = AgentResearchRunRegistry.fromShellPaths(fixture.paths).get('competitor-research');
      expect(run?.question).toBe('Which competitor features should we match?');
      expect(run?.goal).toBe('Produce a sourced parity plan.');
      expect(run?.status).toBe('planned');
      expect(run?.plan).toEqual(['Inventory OpenClaw', 'Inventory Hermes']);
      expect(run?.nextSteps).toEqual(['Capture official source ids']);
      expect(run?.sourceIds).toEqual(['openclaw-docs', 'hermes-docs']);
    } finally {
      fixture.cleanup();
    }
  });


  test('runs confirmed model compare workspace editor through agent_model_compare', async () => {
    const artifacts = createHarnessArtifactStore();
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      const modelCompareCalls: Record<string, unknown>[] = [];
      let providerCalls = 0;
      const nativeComparison = createAgentModelCompareTool({
        modelCatalog: { listModels: () => [] },
        providerRegistry: { getForModel() { providerCalls++; throw new Error('Provider access is forbidden in this translation observer.'); } },
        artifactStore: artifacts.store,
      });
      const syntheticTranslationObserver: Tool = {
        definition: nativeComparison.definition,
        async execute(rawArgs, options) {
          options?.signal?.throwIfAborted();
          expect(assertCurrentToolExecution(rawArgs, options)).toBe(true);
          const mode = rawArgs.mode;
          if (mode === 'run') expect(assertCurrentToolEffect(rawArgs, options, 'send')).toBe(true);
          else if (['judge', 'apply', 'routeDecision', 'export', 'handoff', 'handoffArchive'].includes(String(mode))) {
            expect(assertCurrentToolEffect(rawArgs, options, 'write')).toBe(true);
          }
          modelCompareCalls.push(rawArgs);
          return { success: true, output: 'agent_model_compare executed by the synthetic translation observer' };
        },
      };
      fixture.toolRegistry.register(syntheticTranslationObserver);

      const unconfirmedCallsBefore = modelCompareCalls.length;
      const unconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-run-compare',
        fields: {
          prompt: 'Write a release note for the document workflow.',
          confirm: 'no',
        },
        confirm: true,
        explicitUserRequest: 'Compare release-note candidates.',
      });
      expect(unconfirmed.success).toBe(false);
      expect(unconfirmed.error).toContain('current recorded effect admission');
      expect(modelCompareCalls).toHaveLength(unconfirmedCallsBefore);
      expect(providerCalls).toBe(0);
      expect(artifacts.store.list()).toEqual([]);

      const executed = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-run-compare',
        fields: {
          prompt: 'Write a release note for the document workflow.',
          modelRefs: 'openai:gpt-4.1, anthropic:claude-sonnet',
          rubric: 'Prefer concise and concrete.',
          confirm: 'yes',
        },
        confirm: true,
        explicitUserRequest: 'Compare release-note candidates.',
      });
      expect(executed.success).toBe(true);
      expect(executed.output).toContain('"status": "executed_model_tool"');
      expect(executed.output).toContain('"tool": "agent_model_compare"');
      expect(executed.output).toContain('agent_model_compare executed');

      const localBenchmark = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'account-run-local-model-benchmark',
        fields: {
          modelRefs: 'ollama:qwen2.5-coder:7b, openai:gpt-4.1',
          confirm: 'yes',
        },
        confirm: true,
        explicitUserRequest: 'Compare this local route before making it default.',
      });
      expect(localBenchmark.success).toBe(true);
      expect(localBenchmark.output).toContain('"status": "executed_model_tool"');
      expect(localBenchmark.output).toContain('"tool": "agent_model_compare"');
      expect(localBenchmark.output).toContain('agent_model_compare executed');
      expect(modelCompareCalls.at(-1)).toMatchObject({
        mode: 'run',
        benchmarkKind: 'local-model-route',
        taskType: 'local-model-route',
        modelRefs: ['ollama:qwen2.5-coder:7b', 'openai:gpt-4.1'],
      });
      expect(modelCompareCalls.at(-1)).not.toHaveProperty('confirm');
      expect(String(modelCompareCalls.at(-1)?.prompt)).toContain('Benchmark this local route');

      const review = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-review-compare',
        fields: {
          artifactId: 'artifact-1',
          reveal: 'no',
        },
      });
      expect(review.success).toBe(true);
      expect(review.output).toContain('"status": "executed_model_tool"');
      expect(review.output).toContain('"tool": "agent_model_compare"');
      expect(review.output).toContain('agent_model_compare executed');

      const sideBySide = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-review-compare',
        fields: {
          view: 'sideBySide',
          artifactId: 'artifact-2',
          relatedArtifactIds: 'artifact-doc',
          previewBytes: '600',
        },
      });
      expect(sideBySide.success).toBe(true);
      expect(sideBySide.output).toContain('"status": "executed_model_tool"');
      expect(sideBySide.output).toContain('"tool": "agent_model_compare"');
      expect(sideBySide.output).toContain('agent_model_compare executed');
      expect(modelCompareCalls.at(-1)).toMatchObject({
        mode: 'sideBySide',
        artifactId: 'artifact-2',
        relatedArtifactIds: ['artifact-doc'],
        previewBytes: 600,
      });

      const handoffDiff = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-review-compare',
        fields: {
          view: 'handoffDiff',
          leftArtifactId: 'artifact-7',
          rightArtifactId: 'artifact-10',
        },
      });
      expect(handoffDiff.success).toBe(true);
      expect(handoffDiff.output).toContain('"status": "executed_model_tool"');
      expect(handoffDiff.output).toContain('"tool": "agent_model_compare"');
      expect(handoffDiff.output).toContain('agent_model_compare executed');
      expect(modelCompareCalls.at(-1)).toMatchObject({
        mode: 'handoffDiff',
        leftArtifactId: 'artifact-7',
        rightArtifactId: 'artifact-10',
      });

      const explicitHandoffDiff = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-diff-handoffs',
        fields: {
          leftArtifactId: 'artifact-7',
          rightArtifactId: 'artifact-10',
          sectionId: 'related',
        },
      });
      expect(explicitHandoffDiff.success).toBe(true);
      expect(explicitHandoffDiff.output).toContain('"status": "executed_model_tool"');
      expect(explicitHandoffDiff.output).toContain('"tool": "agent_model_compare"');
      expect(explicitHandoffDiff.output).toContain('agent_model_compare executed');
      expect(modelCompareCalls.at(-1)).toMatchObject({
        mode: 'handoffDiff',
        leftArtifactId: 'artifact-7',
        rightArtifactId: 'artifact-10',
        sectionId: 'related',
      });

      const judgmentUnconfirmedCallsBefore = modelCompareCalls.length;
      const judgmentUnconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-judge-compare',
        fields: {
          artifactId: 'artifact-1',
          winnerBlindId: 'B',
          reasons: 'Candidate B was more concrete.',
          confirm: 'no',
        },
        confirm: true,
        explicitUserRequest: 'Save comparison judgment.',
      });
      expect(judgmentUnconfirmed.success).toBe(false);
      expect(judgmentUnconfirmed.error).toContain('current recorded effect admission');
      expect(modelCompareCalls).toHaveLength(judgmentUnconfirmedCallsBefore);
      expect(providerCalls).toBe(0);
      expect(artifacts.store.list()).toEqual([]);

      const judgment = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-judge-compare',
        fields: {
          artifactId: 'artifact-1',
          winnerBlindId: 'B',
          reasons: 'Candidate B was more concrete.',
          reveal: 'yes',
          confirm: 'yes',
        },
        confirm: true,
        explicitUserRequest: 'Save comparison judgment.',
      });
      expect(judgment.success).toBe(true);
      expect(judgment.output).toContain('"status": "executed_model_tool"');
      expect(judgment.output).toContain('"tool": "agent_model_compare"');
      expect(judgment.output).toContain('agent_model_compare executed');

      const analytics = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-compare-analytics',
        fields: {
          limit: '10',
          benchmarkKind: 'doc-draft',
          taskType: 'writing',
          documentId: 'doc_launch',
          includeReasons: 'yes',
        },
      });
      expect(analytics.success).toBe(true);
      expect(analytics.output).toContain('"status": "executed_model_tool"');
      expect(analytics.output).toContain('"tool": "agent_model_compare"');
      expect(analytics.output).toContain('agent_model_compare executed');
      expect(modelCompareCalls.at(-1)).toMatchObject({
        mode: 'analytics',
        limit: 10,
        benchmarkKind: 'doc-draft',
        taskType: 'writing',
        documentId: 'doc_launch',
        includeReasons: true,
      });

      const synthesis = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-compare-analytics',
        fields: {
          view: 'synthesis',
          limit: '5',
          benchmarkKind: 'doc-draft',
          taskType: 'writing',
          documentId: 'doc_launch',
          includeReasons: 'yes',
        },
      });
      expect(synthesis.success).toBe(true);
      expect(synthesis.output).toContain('"status": "executed_model_tool"');
      expect(synthesis.output).toContain('"tool": "agent_model_compare"');
      expect(synthesis.output).toContain('agent_model_compare executed');
      expect(modelCompareCalls.at(-1)).toMatchObject({
        mode: 'synthesis',
        limit: 5,
        benchmarkKind: 'doc-draft',
        taskType: 'writing',
        documentId: 'doc_launch',
        includeReasons: true,
      });

      const applyUnconfirmedCallsBefore = modelCompareCalls.length;
      const applyUnconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-apply-compare',
        fields: {
          artifactId: 'artifact-2',
          confirm: 'no',
        },
        confirm: true,
        explicitUserRequest: 'Apply comparison winner.',
      });
      expect(applyUnconfirmed.success).toBe(false);
      expect(applyUnconfirmed.error).toContain('current recorded effect admission');
      expect(modelCompareCalls).toHaveLength(applyUnconfirmedCallsBefore);
      expect(providerCalls).toBe(0);
      expect(artifacts.store.list()).toEqual([]);

      const apply = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-apply-compare',
        fields: {
          artifactId: 'artifact-2',
          confirm: 'yes',
        },
        confirm: true,
        explicitUserRequest: 'Apply comparison winner.',
      });
      expect(apply.success).toBe(true);
      expect(apply.output).toContain('"status": "executed_model_tool"');
      expect(apply.output).toContain('"tool": "agent_model_compare"');
      expect(apply.output).toContain('agent_model_compare executed');
      expect(modelCompareCalls.at(-1)).toMatchObject({
        mode: 'apply',
        artifactId: 'artifact-2',
      });
      expect(modelCompareCalls.at(-1)).not.toHaveProperty('confirm');

      const routeDecisionUnconfirmedCallsBefore = modelCompareCalls.length;
      const routeDecisionUnconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-record-route-decision',
        fields: {
          artifactId: 'artifact-2',
          decision: 'left-unchanged',
          confirm: 'no',
        },
        confirm: true,
        explicitUserRequest: 'Leave comparison route unchanged.',
      });
      expect(routeDecisionUnconfirmed.success).toBe(false);
      expect(routeDecisionUnconfirmed.error).toContain('current recorded effect admission');
      expect(modelCompareCalls).toHaveLength(routeDecisionUnconfirmedCallsBefore);
      expect(providerCalls).toBe(0);
      expect(artifacts.store.list()).toEqual([]);

      const routeDecision = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-record-route-decision',
        fields: {
          artifactId: 'artifact-2',
          decision: 'left-unchanged',
          confirm: 'yes',
        },
        confirm: true,
        explicitUserRequest: 'Leave comparison route unchanged.',
      });
      expect(routeDecision.success).toBe(true);
      expect(routeDecision.output).toContain('"status": "executed_model_tool"');
      expect(routeDecision.output).toContain('"tool": "agent_model_compare"');
      expect(routeDecision.output).toContain('agent_model_compare executed');
      expect(modelCompareCalls.at(-1)).toMatchObject({
        mode: 'routeDecision',
        artifactId: 'artifact-2',
        decision: 'left-unchanged',
      });
      expect(modelCompareCalls.at(-1)).not.toHaveProperty('confirm');

      const exportUnconfirmedCallsBefore = modelCompareCalls.length;
      const exportUnconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-export-compare',
        fields: {
          artifactId: 'artifact-1',
          confirm: 'no',
        },
        confirm: true,
        explicitUserRequest: 'Export comparison report.',
      });
      expect(exportUnconfirmed.success).toBe(false);
      expect(exportUnconfirmed.error).toContain('current recorded effect admission');
      expect(modelCompareCalls).toHaveLength(exportUnconfirmedCallsBefore);
      expect(providerCalls).toBe(0);
      expect(artifacts.store.list()).toEqual([]);

      const exportReport = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-export-compare',
        fields: {
          artifactId: 'artifact-1',
          reveal: 'yes',
          confirm: 'yes',
        },
        confirm: true,
        explicitUserRequest: 'Export comparison report.',
      });
      expect(exportReport.success).toBe(true);
      expect(exportReport.output).toContain('"status": "executed_model_tool"');
      expect(exportReport.output).toContain('"tool": "agent_model_compare"');
      expect(exportReport.output).toContain('agent_model_compare executed');

      const handoff = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-export-compare',
        fields: {
          reportKind: 'handoff',
          artifactId: 'artifact-2',
          relatedArtifactIds: 'artifact-doc, artifact-package',
          confirm: 'yes',
        },
        confirm: true,
        explicitUserRequest: 'Create a reviewer handoff for this comparison.',
      });
      expect(handoff.success).toBe(true);
      expect(handoff.output).toContain('"status": "executed_model_tool"');
      expect(handoff.output).toContain('"tool": "agent_model_compare"');
      expect(handoff.output).toContain('agent_model_compare executed');
      expect(modelCompareCalls.at(-1)).toMatchObject({
        mode: 'handoff',
        artifactId: 'artifact-2',
        relatedArtifactIds: ['artifact-doc', 'artifact-package'],
      });
      expect(modelCompareCalls.at(-1)).not.toHaveProperty('confirm');

      const archive = await fixture.admittedTool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-export-compare',
        fields: {
          reportKind: 'archive',
          artifactId: 'artifact-7',
          confirm: 'yes',
        },
        confirm: true,
        explicitUserRequest: 'Archive a reviewer handoff for this comparison.',
      });
      expect(archive.success).toBe(true);
      expect(archive.output).toContain('"status": "executed_model_tool"');
      expect(archive.output).toContain('"tool": "agent_model_compare"');
      expect(archive.output).toContain('agent_model_compare executed');
      expect(modelCompareCalls.at(-1)).toMatchObject({
        mode: 'handoffArchive',
        artifactId: 'artifact-7',
      });
      expect(modelCompareCalls.at(-1)).not.toHaveProperty('confirm');
      expect(providerCalls).toBe(0);
      expect(artifacts.store.list()).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });


  test('direct harness setting mutations never mint authority from confirmation metadata', async () => {
    const fixture = makeFixture();
    try {
      const previous = fixture.configManager.get('provider.model');
      fixture.configManager.flushConfigFileChanges();
      const paths = [fixture.configManager.getConfigPath(), fixture.configManager.getProjectConfigPath()]
        .filter((path): path is string => typeof path === 'string');
      const bytesBefore = paths.map(path => existsSync(path) ? readFileSync(path) : null);
      for (const confirm of [false, true]) {
        await expect(fixture.tool.execute({ mode: 'set_setting', key: 'provider.model', value: 'openai:gpt-4.1', confirm, explicitUserRequest: 'Use this model.' }))
          .rejects.toBeInstanceOf(ToolInputProjectionError);
        expect(fixture.configManager.get('provider.model')).toBe(previous);
        expect(paths.map(path => existsSync(path) ? readFileSync(path) : null)).toEqual(bytesBefore);
      }
    } finally { fixture.cleanup(); }
  });


  test('resolves settings by key, target, and query without guessing ambiguous matches', async () => {
    const fixture = makeFixture();
    try {
      const summary = await fixture.tool.execute({ mode: 'summary', includeParameters: true });
      expect(summary.success, summary.error).toBe(true);
      const summaryJson = JSON.parse(summary.output ?? '{}') as { readonly modelAccess?: { readonly settings?: string } };
      expect(summaryJson.modelAccess?.settings).toContain('category');
      expect(summaryJson.modelAccess?.settings).toContain('prefix');
      expect(summaryJson.modelAccess?.settings).toContain('includeHidden:true');

      const defaultSettings = await fixture.tool.execute({ mode: 'settings' });
      expect(defaultSettings.success).toBe(true);
      const defaultPayload = JSON.parse(defaultSettings.output!) as {
        readonly settings: readonly { readonly key: string }[];
        readonly returned: number;
        readonly total: number;
        readonly note?: string;
      };
      const visibleSettingKeys = CONFIG_SCHEMA
        .filter((setting) => !isAgentHiddenSettingKey(setting.key))
        .map((setting) => setting.key)
        .sort();
      expect(defaultPayload.returned).toBe(visibleSettingKeys.length);
      expect(defaultPayload.total).toBe(visibleSettingKeys.length);
      expect(defaultPayload.settings.map((setting) => setting.key).sort()).toEqual(visibleSettingKeys);
      // A complete listing must not describe itself as partial.
      expect(defaultPayload.note).toBeUndefined();

      // A page cut short by `limit` says so in words, not only in two numbers
      // the reader has to notice and compare.
      const cappedSettings = await fixture.tool.execute({ mode: 'settings', limit: 3 });
      expect(cappedSettings.success).toBe(true);
      const cappedPayload = JSON.parse(cappedSettings.output!) as {
        readonly settings: readonly { readonly key: string }[];
        readonly returned: number;
        readonly total: number;
        readonly note?: string;
      };
      expect(cappedPayload.returned).toBe(3);
      expect(cappedPayload.total).toBe(visibleSettingKeys.length);
      expect(cappedPayload.note).toContain(`Showing 3 of ${visibleSettingKeys.length} settings`);
      expect(cappedPayload.note).toContain('not the full catalog');

      const allSettings = await fixture.tool.execute({ mode: 'settings', includeHidden: true });
      expect(allSettings.success).toBe(true);
      const allPayload = JSON.parse(allSettings.output!) as {
        readonly settings: readonly { readonly key: string; readonly visibleInWorkspace: boolean }[];
        readonly returned: number;
        readonly total: number;
      };
      expect(allPayload.returned).toBe(CONFIG_SCHEMA.length);
      expect(allPayload.total).toBe(CONFIG_SCHEMA.length);
      expect(allPayload.settings.filter((setting) => !setting.visibleInWorkspace).map(setting => setting.key).sort())
        .toEqual(CONFIG_SCHEMA.filter(setting => isAgentHiddenSettingKey(setting.key)).map(setting => setting.key).sort());

      const filteredSettings = await fixture.tool.execute({
        mode: 'settings',
        category: 'provider',
        prefix: 'provider.',
        query: 'reasoning',
        limit: 5,
      });
      expect(filteredSettings.success).toBe(true);
      const filteredPayload = JSON.parse(filteredSettings.output!) as {
        readonly settings: readonly { readonly key: string; readonly modelRoute?: string; readonly writable?: boolean }[];
        readonly returned: number;
      };
      expectCompactSummaryFields(filteredPayload);
      expect(filteredPayload.returned).toBeGreaterThan(0);
      expect(filteredPayload.settings.map((setting) => setting.key)).toContain('provider.reasoningEffort');
      expect(filteredPayload.settings.filter((setting) => !setting.key.startsWith('provider.'))).toEqual([]);
      expect(filteredPayload.settings.filter((setting) => (
        setting.writable !== true
        || !String(setting.modelRoute).startsWith('settings set|reset key:')
      ))).toEqual([]);

      const byTarget = await fixture.tool.execute({
        mode: 'get_setting',
        target: 'PROVIDER.MODEL',
      });
      expect(byTarget.success).toBe(true);
      const targetSetting = JSON.parse(byTarget.output!);
      expect(targetSetting.key).toBe('provider.model');
      expect(targetSetting.modelRoute).toBe('settings set|reset key:provider.model');
      expect(targetSetting.lookup).toEqual({
        source: 'target',
        input: 'PROVIDER.MODEL',
        resolvedBy: 'case-insensitive-key',
      });

      const byQuery = await fixture.tool.execute({
        mode: 'get_setting',
        query: 'reasoning',
        prefix: 'provider.reasoningEffort',
      });
      expect(byQuery.success).toBe(true);
      const querySetting = JSON.parse(byQuery.output!);
      expect(querySetting.key).toBe('provider.reasoningEffort');
      expect(querySetting.modelRoute).toBe('settings set|reset key:provider.reasoningEffort');
      expect(querySetting.lookup).toEqual({
        source: 'query',
        input: 'reasoning',
        resolvedBy: 'search',
      });

      const before = fixture.configManager.get('provider.reasoningEffort');
      fixture.configManager.set('permissions.mode', 'plan');
      fixture.configManager.flushConfigFileChanges();
      const configPaths = [fixture.configManager.getConfigPath(), fixture.configManager.getProjectConfigPath()]
        .filter((path): path is string => typeof path === 'string');
      const configBefore = configPaths.map(path => existsSync(path) ? readFileSync(path) : null);
      await refusePreparedHarnessSetting(fixture, 'harness-reasoning-set-refusal', {
        mode: 'set_setting',
        query: 'reasoning',
        prefix: 'provider.reasoningEffort',
        value: 'high',
        confirm: true,
        explicitUserRequest: 'Use high reasoning effort.',
      }, { operation: 'set', key: 'provider.reasoningEffort', value: 'high', previous: 'medium', appliedBy: 'local',
        destinations: [{ path: fixture.paths.resolveUserPath('agent', 'settings.json'), tier: 'global', operation: 'set' }] });
      expect(fixture.configManager.get('provider.reasoningEffort')).toBe(before);
      expect(configPaths.map(path => existsSync(path) ? readFileSync(path) : null)).toEqual(configBefore);

      await refusePreparedHarnessSetting(fixture, 'harness-reasoning-reset-refusal', {
        mode: 'reset_setting',
        target: 'PROVIDER.REASONINGEFFORT',
        confirm: true,
        explicitUserRequest: 'Reset reasoning effort.',
      }, { operation: 'reset', key: 'provider.reasoningEffort', value: 'medium', previous: 'medium', appliedBy: 'local',
        destinations: [{ path: fixture.paths.resolveUserPath('agent', 'settings.json'), tier: 'global', operation: 'remove' }] });
      expect(fixture.configManager.get('provider.reasoningEffort')).toBe(before);
      expect(configPaths.map(path => existsSync(path) ? readFileSync(path) : null)).toEqual(configBefore);

      const ambiguous = await fixture.tool.execute({
        mode: 'get_setting',
        query: 'provider',
      });
      expect(ambiguous.success).toBe(false);
      expect(ambiguous.error).toContain('Ambiguous setting provider');
      expect(ambiguous.error).toContain('provider.model');
      expect(ambiguous.error).toContain('modelRoute');
    } finally {
      fixture.cleanup();
    }
  });


  test('direct harness secret mutation/reset require authentic prepared ownership', async () => {
    const fixture = makeFixture();
    try {
      const key = buildGoodVibesSecretKey('surfaces.slack.botToken');
      const ref = buildGoodVibesSecretRef(key);
      fixture.configManager.setDynamic('surfaces.slack.botToken', ref);
      fixture.configManager.set('permissions.mode', 'plan');
      fixture.configManager.flushConfigFileChanges();
      const configPaths = [fixture.configManager.getConfigPath(), fixture.configManager.getProjectConfigPath(),
        fixture.paths.resolveUserPath('daemon', 'settings.json'), fixture.paths.resolveUserPath('daemon', 'secrets.enc'),
        fixture.paths.resolveUserPath('daemon', 'secrets.json'), join(fixture.root, '.goodvibes', 'secrets.key')]
        .filter((path): path is string => typeof path === 'string');
      const configBefore = configPaths.map(path => existsSync(path) ? readFileSync(path) : null);
      if (!fixture.secretsManager) throw new Error('Native secret owner is absent.');
      const secretSet = spyOn(fixture.secretsManager, 'set');
      const secretDelete = spyOn(fixture.secretsManager, 'delete');
      try {
        let set: unknown;
        try { await fixture.admittedTool.execute({ mode: 'set_setting', key: 'surfaces.slack.botToken', value: 'xoxb-secret-value', confirm: true, explicitUserRequest: 'Set the token.' }); } catch (error) { set = error; }
        expect(set).toBeInstanceOf(ToolInputProjectionError);
        if (!(set instanceof ToolInputProjectionError)) throw new Error('Expected native secret projection refusals.');
        expect(set.problem).toBe('unavailable');
        expect(String(set)).not.toContain('xoxb-secret-value');
        await refusePreparedHarnessSetting(fixture, 'harness-secret-reset-refusal',
          { mode: 'reset_setting', key: 'surfaces.slack.botToken', confirm: true, explicitUserRequest: 'Reset the token.' },
          { operation: 'reset', key: 'surfaces.slack.botToken', value: '', previous: ref, appliedBy: 'local',
            destinations: [{ path: fixture.paths.resolveUserPath('agent', 'settings.json'), tier: 'global', operation: 'remove' },
              { path: fixture.paths.resolveUserPath('daemon', 'settings.json'), tier: 'daemon', operation: 'remove' }],
            credential: { operation: 'delete', key, scope: 'daemon', destinations: [] } });
        expect(secretSet).not.toHaveBeenCalled(); expect(secretDelete).not.toHaveBeenCalled();
        expect(configPaths.map(path => existsSync(path) ? readFileSync(path) : null)).toEqual(configBefore);
        expect(fixture.configManager.get('surfaces.slack.botToken')).toBe(ref);
      } finally { secretSet.mockRestore(); secretDelete.mockRestore(); }
    } finally { fixture.cleanup(); }
  });


  test('does not echo raw secret values when invoking settings through run_command', async () => {
    const fixture = makeFixture();
    try {
      registerOperatorRuntimeCommands(fixture.commandRegistry);
      registerAgentSettingsTool(fixture.toolRegistry, fixture.commandRegistry, fixture.context);
      fixture.configManager.flushConfigFileChanges();
      const before = JSON.stringify(fixture.configManager.getRaw());
      const paths = [fixture.configManager.getConfigPath(), fixture.configManager.getProjectConfigPath(),
        fixture.paths.resolveUserPath('daemon', 'settings.json'), fixture.paths.resolveUserPath('daemon', 'secrets.enc')]
        .filter((path): path is string => typeof path === 'string');
      const files = paths.map(path => existsSync(path) ? readFileSync(path) : null);
      const secretBefore = await fixture.secretsManager?.get(buildGoodVibesSecretKey('surfaces.slack.botToken'));
      const result = await fixture.admittedTool.execute({
        mode: 'run_command',
        command: '/settings set surfaces.slack.botToken xoxb-secret-value --yes',
        confirm: true,
        explicitUserRequest: 'Set the Slack bot token.',
      }).catch((error: unknown) => error);
      expect<unknown>(result).toBeInstanceOf(ToolInputProjectionError);
      expect(String(result)).not.toContain('xoxb-secret-value');
      expect(JSON.stringify(fixture.configManager.getRaw())).toBe(before);
      expect(paths.map(path => existsSync(path) ? readFileSync(path) : null)).toEqual(files);
      expect(await fixture.secretsManager?.get(buildGoodVibesSecretKey('surfaces.slack.botToken'))).toBe(secretBefore);
    } finally {
      fixture.cleanup();
    }
  });


  test('runs model settings commands through the recorded owning-store mutation', async () => {
    const fixture = makeFixture();
    try {
      registerOperatorRuntimeCommands(fixture.commandRegistry);
      registerAgentSettingsTool(fixture.toolRegistry, fixture.commandRegistry, fixture.context);
      const key = 'behavior.saveHistory';
      const setting = CONFIG_SCHEMA.find(setting => setting.key === key);
      if (!setting || typeof setting.default !== 'boolean') throw new Error('Native history setting is unavailable.');
      const defaultValue = setting.default;
      const original = fixture.configManager.get(key);
      const next = !Boolean(original);
      let cancel: AbortController | undefined;
      let admissions = 0;
      const admit = fixture.permissionManager.admitAutonomous.bind(fixture.permissionManager);
      const admissionSpy = spyOn(fixture.permissionManager, 'admitAutonomous').mockImplementation(async (...args) => {
        const result = await admit(...args);
        admissions++;
        cancel?.abort();
        return result;
      });
      try {
        fixture.configManager.flushConfigFileChanges();
        const configPath = fixture.configManager.getConfigPath();
        const before = existsSync(configPath) ? readFileSync(configPath) : undefined;
        cancel = new AbortController();
        const cancelled = await fixture.admittedTool.execute({ mode: 'run_command', command: `/settings set ${key} ${next}` },
          { signal: cancel.signal }).catch((error: unknown) => error);
        expect(cancel.signal.aborted).toBe(true);
        expect<unknown>(cancelled).toBeInstanceOf(Error);
        expect(fixture.configManager.get(key)).toBe(original);
        expect(existsSync(configPath) ? readFileSync(configPath) : undefined).toEqual(before);
        cancel = undefined;
        const set = await fixture.admittedTool.execute({ mode: 'run_command', command: `/settings set ${key} ${next}` });
        expect(set.success, set.error).toBe(true);
        expect(set.output).toContain('Command /settings completed.');
        expect(set.output).toContain('"status":"committed"');
        expect(set.output).toContain('"verifiedInOwningStore":true');
        expect(fixture.configManager.get(key)).toBe(next);
        const stored: unknown = JSON.parse(readFileSync(fixture.paths.resolveUserPath('agent', 'settings.json'), 'utf8'));
        expect<unknown>(stored).toMatchObject({ behavior: { saveHistory: next } });
        const reset = await fixture.admittedTool.execute({ mode: 'run_command', command: `/cfg-ui reset ${key}` });
        expect(reset.success, reset.error).toBe(true);
        expect(fixture.configManager.get(key)).toBe(defaultValue);
        expect(reset.output).toContain('"verifiedInOwningStore":true');
        expect(admissions).toBeGreaterThanOrEqual(3);
      } finally { admissionSpy.mockRestore(); }
    } finally { fixture.cleanup(); }
  });


  test('model_routing cookbook recipes include hardwareFit annotation for known stacks', async () => {
    const fixture = makeFixture();
    try {
      const routing = await executeHarnessJson<{
        readonly localCookbook: {
          readonly recipes: readonly {
            readonly id: string;
            readonly hardwareFit?: string;
          }[];
        };
      }>(fixture, { mode: 'model_routing', includeParameters: true });
      const recipes = routing.localCookbook.recipes;
      expect(recipes.length).toBeGreaterThan(0);
      // Every recipe with a known stack (ollama, llama-cpp, vllm) must carry a
      // hardwareFit string when the hardware verdict is deterministic. When the
      // machine returns 'unknown' (null totalRamBytes and no GPU), fitVerdictLabel
      // returns '' and hardwareFit is absent, that is tolerated here.
      const knownStackIds = new Set(['ollama', 'llama-cpp', 'vllm']);
      for (const recipe of recipes) {
        if (knownStackIds.has(recipe.id)) {
          // Either absent (unknown hardware verdict) or a non-empty string.
          if (recipe.hardwareFit !== undefined) {
            expect(typeof recipe.hardwareFit).toBe('string');
            expect((recipe.hardwareFit as string).length).toBeGreaterThan(0);
          }
        }
      }
      // The openai-compatible-local stack has no stable size estimate; hardwareFit is absent.
      const generic = recipes.find((r) => r.id === 'openai-compatible-local');
      expect(generic?.hardwareFit).toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });
});
