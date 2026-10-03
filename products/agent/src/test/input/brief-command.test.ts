import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { MemoryApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { MemoryRecord } from '@goodvibes-jev/engine/sdk/platform/state';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { formatAgentOperatorBriefing } from '../../input/commands/brief-runtime.ts';
import type { WorkPlanItem, WorkPlanStore } from '@goodvibes-jev/engine/sdk/platform/workflow';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function memoryRecord(): MemoryRecord {
  const now = Date.now();
  return {
    id: 'mem-briefing',
    scope: 'project',
    cls: 'fact',
    summary: 'Use concise operator briefings',
    detail: 'Briefings should show next actions before raw data.',
    tags: ['operator'],
    provenance: [],
    reviewState: 'fresh',
    confidence: 88,
    createdAt: now,
    updatedAt: now,
  };
}

function fakeMemory(records: readonly MemoryRecord[]): MemoryApi {
  return {
    getAll: () => records,
    reviewQueue: () => records.filter((record) => record.reviewState !== 'reviewed'),
  } as unknown as MemoryApi;
}

function workPlanStore(items: readonly WorkPlanItem[]): WorkPlanStore {
  return {
    listItems: () => items,
  } as unknown as WorkPlanStore;
}

function makeContext(printed: string[] = []): CommandContext {
  const root = makeProjectTempDir('goodvibes-agent-brief');
  const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const configValues = new Map<string, unknown>([
    ['controlPlane.host', '127.0.0.1'],
    ['controlPlane.port', 3421],
    ['surfaces.telegram.enabled', true],
    ['ui.voiceEnabled', true],
    ['tts.provider', 'missing-goodvibes-agent-tts-provider'],
  ]);
  const personaRegistry = AgentPersonaRegistry.fromShellPaths(shellPaths);
  const persona = personaRegistry.create({
    name: 'Research Operator',
    description: 'Keeps answers concise and source-backed.',
    body: 'Inspect current state, then act.',
  });
  personaRegistry.setActive(persona.id);
  const skillRegistry = AgentSkillRegistry.fromShellPaths(shellPaths);
  const skill = skillRegistry.create({
    name: 'Inbox Triage',
    description: 'Summarize inbound messages.',
    procedure: 'Group unread items, identify blockers, ask before replies.',
    enabled: true,
    requirements: [{ kind: 'env', name: 'GOODVIBES_AGENT_BRIEF_TEST_REQUIRED_ENV_DO_NOT_SET' }],
  });
  skillRegistry.createBundle({
    name: 'Daily Operator Bundle',
    description: 'Operator skills for recurring briefing work.',
    skillIds: [skill.id],
    enabled: true,
  });
  AgentRoutineRegistry.fromShellPaths(shellPaths).create({
    name: 'Morning Review',
    description: 'Review tasks and reminders.',
    steps: 'Check work plan, approvals, and Agent Knowledge first.',
    enabled: true,
    requirements: [{ kind: 'env', name: 'GOODVIBES_AGENT_ROUTINE_TEST_REQUIRED_ENV_DO_NOT_SET' }],
  });

  const item: WorkPlanItem = {
    id: 'wpi-brief',
    title: 'Review operator launch',
    status: 'in_progress',
    owner: 'agent',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  return {
    print: (text: string) => printed.push(text),
    renderRequest: () => undefined,
    exit: () => undefined,
    session: {
      runtime: {
        provider: 'openai-subscriber',
        model: 'gpt-5.5',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: 'medium',
        sessionId: 'session-brief',
      },
    },
    provider: {
      providerRegistry: {
        getCurrentModel: () => ({ displayName: 'GPT 5.5' }),
      },
    },
    workspace: {
      shellPaths,
      workPlanStore: workPlanStore([item]),
    },
    platform: {
      configManager: {
        get: (key: string) => configValues.get(key),
      },
      voiceProviderRegistry: {
        list: () => [],
      },
      mediaProviderRegistry: {
        list: () => [
          { id: 'custom-media-review', label: 'Custom Media Review', capabilities: ['generate'] },
        ],
      },
    },
    ops: {},
    extensions: {},
    clients: {
      agentKnowledgeApi: {
        memory: fakeMemory([memoryRecord()]),
      },
    },
  } as unknown as CommandContext;
}

describe('/brief command', () => {
  test('prints an Agent-only operator briefing with next actions', async () => {
    const printed: string[] = [];
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    await registry.execute('brief', [], makeContext(printed));

    const output = printed.join('\n');
    expect(output).toContain('Agent Briefing');
    expect(output).toContain('chat route: openai-subscriber / GPT 5.5');
    expect(output).toContain('/api/goodvibes-agent/knowledge');
    expect(output).toContain('agent-only; no fallback');
    expect(output).toContain('local memory: 1 record; prompt-active 1; review queue 1');
    expect(output).toContain('personas: 1 persona; active Research Operator');
    expect(output).toContain('skills: 1/1 enabled; bundles 1/1; active 1; setup gaps 1 skill, 1 bundle');
    expect(output).toContain('routines: 1/1 enabled; setup gaps 1');
    expect(output).toContain('Resolve 1 skill with setup gaps from Agent Workspace -> Skills.');
    expect(output).toContain('Resolve 1 skill bundle with setup gaps from Agent Workspace -> Skills.');
    expect(output).toContain('Resolve 1 routine with setup gaps from Agent Workspace -> Routines.');
    expect(output).toContain('channels: 0/14 ready; 1 enabled; setup gaps 1');
    expect(output).toContain('Review 1 enabled channel needing setup from Agent Workspace -> Messaging.');
    expect(output).toContain('Review voice setup from Agent Workspace -> Voice & Media before relying on spoken replies.');
    expect(output).toContain('Review media provider setup from Agent Workspace -> Voice & Media before relying on image or media workflows.');
    expect(output).toContain('work plan: 1 item; active 1');
    expect(output).toContain('Use Agent Workspace -> Work & Approvals -> Delegate a build task only for explicit build');
    expect(output).not.toContain('default knowledge');
    expect(output).not.toContain('daemon');
  });

  test('formats briefing directly for workspace and smoke callers', () => {
    const output = formatAgentOperatorBriefing(makeContext());

    expect(output).toContain('Next Actions');
    expect(output).toContain('Use Agent Workspace -> Knowledge for Agent Knowledge status');
  });
});
