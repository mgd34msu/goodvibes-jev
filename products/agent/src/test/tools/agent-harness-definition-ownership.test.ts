import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { createShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { SandboxSessionRegistry } from '@goodvibes-jev/engine/sdk/platform/runtime/sandbox';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { createAgentHarnessTool, registerAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { AGENT_HARNESS_PARAMETER_PROPERTIES } from '../../tools/agent-harness-tool-schema.ts';
import { captureAgentToolDefinition, compactRegisteredToolDefinitions } from '../../tools/tool-definition-compaction.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { createTestProviderRegistry } from '../helpers/test-managers.ts';

function fixture() {
  const root = makeProjectTempDir('harness-definition-owner');
  const workingDirectory = join(root, 'workspace'), homeDirectory = join(root, 'home');
  mkdirSync(workingDirectory); mkdirSync(homeDirectory);
  const paths = createShellPathService({ workingDirectory, homeDirectory });
  const config = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT), workingDir: workingDirectory, homeDir: homeDirectory });
  const registry = new ToolRegistry();
  const context: CommandContext = {
    print: () => {}, renderRequest: () => {}, exit: () => {},
    workspace: { shellPaths: paths }, platform: { config: config.getAll(), configManager: config },
    session: { conversationManager: new ConversationManager(() => 80, config), runtime: {
      sessionId: 'harness-definition-native', model: 'fixture', provider: 'fixture', debugMode: false,
      systemPrompt: '', reasoningEffort: 'medium',
    } },
    provider: { providerRegistry: createTestProviderRegistry() }, ops: {}, clients: {},
    extensions: { toolRegistry: registry, mcpRegistry: new McpRegistry({
      hookDispatcher: { fire: async () => ({ ok: true }) }, sandboxSessions: new SandboxSessionRegistry(root),
    }) },
  };
  const deps = { commandRegistry: new CommandRegistry(), commandContext: context, toolRegistry: registry };
  const tool = createAgentHarnessTool(deps);
  registry.register(tool);
  return { deps, tool, registry };
}

function modeSchema(tool: Tool): object {
  const properties: unknown = tool.definition.parameters.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) throw new Error('Native harness properties missing.');
  const mode: unknown = Object.getOwnPropertyDescriptor(properties, 'mode')?.value;
  if (!mode || typeof mode !== 'object' || Array.isArray(mode)) throw new Error('Native harness mode schema missing.');
  return mode;
}

test('native harness definition preserves complete bytes and order while owning its data', () => {
  const f = fixture();
  const expected: Tool['definition'] = {
    name: 'agent_harness', description: 'Inspect or operate Agent harness surfaces; mode:"modes" lists all.',
    parameters: { type: 'object', properties: AGENT_HARNESS_PARAMETER_PROPERTIES, required: ['mode'], additionalProperties: false },
    sideEffects: ['state'], concurrency: 'serial',
  };
  const original = JSON.stringify(expected);
  expect(JSON.stringify(f.tool.definition)).toBe(original);
  expect(Object.keys(f.tool.definition)).toEqual(Object.keys(expected));
  expect(Object.keys(f.tool.definition.parameters)).toEqual(Object.keys(expected.parameters));
  expect(f.tool.definition.parameters.properties).not.toBe(AGENT_HARNESS_PARAMETER_PROPERTIES);
  expect(modeSchema(f.tool)).not.toBe(AGENT_HARNESS_PARAMETER_PROPERTIES.mode);
  expect(Reflect.set(modeSchema(f.tool), 'description', 'Changed captured mode')).toBe(false);
  expect(Reflect.set(f.tool.definition.parameters, 'additionalProperties', true)).toBe(false);
  expect(JSON.stringify(f.tool.definition)).toBe(original);
  expect(Object.isFrozen(f.tool)).toBe(false);
  expect(Object.isFrozen(f.tool.execute)).toBe(false);
});

test('shared schema changes leave an existing native definition intact and reach a fresh constructor', () => {
  const f = fixture(), shared = AGENT_HARNESS_PARAMETER_PROPERTIES.mode;
  const original = Object.getOwnPropertyDescriptor(shared, 'description');
  if (!original) throw new Error('Native shared mode description missing.');
  const bytes = JSON.stringify(f.tool.definition), changed = 'Native shared schema changed after acquisition.';
  try {
    Object.defineProperty(shared, 'description', { ...original, value: changed });
    expect(JSON.stringify(f.tool.definition)).toBe(bytes);
    const fresh = createAgentHarnessTool(f.deps);
    expect(Object.getOwnPropertyDescriptor(modeSchema(fresh), 'description')?.value).toBe(changed);
    expect(Object.getOwnPropertyDescriptor(modeSchema(f.tool), 'description')?.value).toBe(original.value);
    expect(Object.isFrozen(shared)).toBe(false);
  } finally { Object.defineProperty(shared, 'description', original); }
});

test('complete hidden native data is detached without freezing its shared owner', () => {
  const shared = AGENT_HARNESS_PARAMETER_PROPERTIES.mode, key = 'nativeOwnershipEvidence';
  const original = Object.getOwnPropertyDescriptor(shared, key), evidence = { value: 'Original native evidence' };
  try {
    Object.defineProperty(shared, key, { value: evidence, configurable: true, enumerable: false });
    const f = fixture();
    const captured: unknown = Object.getOwnPropertyDescriptor(modeSchema(f.tool), key)?.value;
    expect(captured).toEqual(evidence); expect(captured).not.toBe(evidence);
    expect(Object.getOwnPropertyDescriptor(modeSchema(f.tool), key)?.enumerable).toBe(false);
    evidence.value = 'Changed shared native evidence';
    expect(captured).toEqual({ value: 'Original native evidence' });
    const fresh = createAgentHarnessTool(f.deps);
    expect(Object.getOwnPropertyDescriptor(modeSchema(fresh), key)?.value).toEqual(evidence);
    expect(Object.isFrozen(evidence)).toBe(false);
  } finally {
    if (original) Object.defineProperty(shared, key, original); else Reflect.deleteProperty(shared, key);
  }
});

test('canonically equal definition replacements retain the original freshness baseline', async () => {
  const f = fixture(), original = f.tool.definition;
  const projected = await f.registry.projectCall('native-harness-definition', original.name, { mode: 'summary' });
  try {
    f.registry.assertProjectedSnapshot(projected);
    f.tool.definition = { ...original, parameters: { ...original.parameters } };
    f.registry.assertProjectedSnapshot(projected);
    f.registry.assertProjectedSnapshot(projected);
    f.tool.definition.description = 'Changed replacement native definition.';
    expect(() => f.registry.assertProjectedSnapshot(projected)).toThrow();
    f.tool.definition = original;
    f.registry.assertProjectedSnapshot(projected);
  } finally { f.tool.definition = original; await f.registry.releaseProjected(projected); }
});

test('replacement native schema accessors cannot execute through the original acquisition', async () => {
  const f = fixture(), original = f.tool.definition;
  const projected = await f.registry.projectCall('native-harness-accessor', original.name, { mode: 'summary' });
  let touched = 0;
  try {
    f.tool.definition = { ...original, parameters: { ...original.parameters } };
    Object.defineProperty(f.tool.definition.parameters, 'properties', { get() { touched++; return original.parameters.properties; } });
    expect(() => f.registry.assertProjectedSnapshot(projected)).toThrow();
    expect(touched).toBe(0);
  } finally { f.tool.definition = original; await f.registry.releaseProjected(projected); }
});

test('executor replacement still retires the actual native prepared tool', async () => {
  const f = fixture(), original = f.tool.execute;
  const projected = await f.registry.projectCall('native-harness-executor', f.tool.definition.name, { mode: 'summary' });
  const prepared = await f.registry.prepareCall('native-harness-executor', f.tool.definition.name, projected.args);
  let replacements = 0;
  try {
    f.registry.assertPrepared(prepared);
    f.tool.execute = async () => { replacements++; return { success: true }; };
    expect(() => f.registry.assertPrepared(prepared)).toThrow();
    expect(replacements).toBe(0);
    f.tool.execute = original;
    f.registry.assertPrepared(prepared);
  } finally { f.tool.execute = original; await f.registry.releaseProjected(projected); }
});

test('shared schema accessors are refused before native definition construction', () => {
  const f = fixture(), shared = AGENT_HARNESS_PARAMETER_PROPERTIES.mode;
  const original = Object.getOwnPropertyDescriptor(shared, 'description');
  if (!original) throw new Error('Native shared mode description missing.');
  const bytes = JSON.stringify(f.tool.definition); let touched = 0;
  try {
    Object.defineProperty(shared, 'description', { enumerable: original.enumerable, configurable: original.configurable,
      get() { touched++; return original.value; } });
    expect(() => createAgentHarnessTool(f.deps)).toThrow();
    expect(touched).toBe(0); expect(JSON.stringify(f.tool.definition)).toBe(bytes);
  } finally { Object.defineProperty(shared, 'description', original); }
});

test('native compaction preserves original compacted bytes and ordinary definition ownership', () => {
  const f = fixture(), original = f.tool.definition;
  const ordinary: Tool = { definition: { ...original, parameters: structuredClone(original.parameters) }, execute: f.tool.execute };
  const ordinaryRegistry = new ToolRegistry(); ordinaryRegistry.register(ordinary);
  const ordinaryRoot = ordinary.definition;
  const executor = f.tool.execute, members = f.registry.list();

  compactRegisteredToolDefinitions(ordinaryRegistry);
  compactRegisteredToolDefinitions(f.registry);

  expect(ordinary.definition).toBe(ordinaryRoot);
  expect(f.tool.definition).not.toBe(original);
  expect(JSON.stringify(f.tool.definition)).toBe(JSON.stringify(ordinary.definition));
  expect(Object.keys(f.tool.definition)).toEqual(Object.keys(ordinary.definition));
  expect(f.tool.definition.description).toBe('Harness catalog: modes, settings, commands, UI, tools.');
  expect(JSON.stringify(f.tool.definition.parameters)).not.toContain('"description"');
  expect(f.tool.definition.parameters.required).toEqual(['mode']);
  expect(f.tool.definition.parameters.additionalProperties).toBe(false);
  expect(Reflect.set(modeSchema(f.tool), 'type', 'number')).toBe(false);
  expect(f.tool.execute).toBe(executor);
  expect(f.registry.list()).toEqual(members);
  expect(f.registry.getToolDefinitions()[0]).toBe(f.tool.definition);
  expect(Object.getOwnPropertyDescriptor(modeSchema({ ...f.tool, definition: original }), 'description')?.value)
    .toBe(AGENT_HARNESS_PARAMETER_PROPERTIES.mode.description);
});

test('registered native compaction retires changed metadata and permits a second equivalent pass', async () => {
  const f = fixture();
  expect(f.registry.unregister('agent_harness', f.tool)).toBe(true);
  registerAgentHarnessTool(f.registry, f.deps.commandRegistry, f.deps.commandContext);
  const tool = f.registry.list().find(entry => entry.definition.name === 'agent_harness');
  if (!tool) throw new Error('Registered native harness missing.');
  const executor = tool.execute;
  const original = await f.registry.projectCall('native-before-compaction', 'agent_harness', { mode: 'summary' });
  try {
    const prepared = await f.registry.prepareCall('native-before-compaction', 'agent_harness', original.args);
    f.registry.assertPrepared(prepared);
    compactRegisteredToolDefinitions(f.registry);
    expect(() => f.registry.assertPrepared(prepared)).toThrow();
    expect(() => f.registry.assertProjectedSnapshot(original)).toThrow();
  } finally { await f.registry.releaseProjected(original); }

  const projected = await f.registry.projectCall('native-after-compaction', 'agent_harness', { mode: 'summary' });
  try {
    const prepared = await f.registry.prepareCall('native-after-compaction', 'agent_harness', projected.args);
    const first = tool.definition, bytes = JSON.stringify(first);
    compactRegisteredToolDefinitions(f.registry);
    expect(tool.definition).not.toBe(first);
    expect(JSON.stringify(tool.definition)).toBe(bytes);
    f.registry.assertProjectedSnapshot(projected);
    f.registry.assertPrepared(prepared);
    expect(tool.execute).toBe(executor);
    expect(Reflect.set(modeSchema(tool), 'type', 'number')).toBe(false);
  } finally { await f.registry.releaseProjected(projected); }
});

test('native compaction preserves complete root order and hidden metadata', () => {
  const f = fixture(), original = f.tool.definition;
  const native: Tool['definition'] = {
    parameters: original.parameters, name: original.name, description: original.description,
    supportsProgress: true, sideEffects: original.sideEffects, concurrency: original.concurrency,
  };
  Object.defineProperty(native, 'nativeOwnershipEvidence', { value: { detail: 'Complete hidden native metadata' }, enumerable: false });
  const owned = captureAgentToolDefinition(native); f.tool.definition = owned;
  const order = Object.getOwnPropertyNames(owned), evidence = Object.getOwnPropertyDescriptor(owned, 'nativeOwnershipEvidence');
  compactRegisteredToolDefinitions(f.registry);
  expect(Object.getOwnPropertyNames(f.tool.definition)).toEqual(order);
  expect(Object.getOwnPropertyDescriptor(f.tool.definition, 'nativeOwnershipEvidence')?.enumerable).toBe(false);
  expect(Object.getOwnPropertyDescriptor(f.tool.definition, 'nativeOwnershipEvidence')?.value).toEqual(evidence?.value);
  expect(Object.getOwnPropertyDescriptor(f.tool.definition, 'nativeOwnershipEvidence')?.value).not.toBe(evidence?.value);
  expect(f.tool.definition.supportsProgress).toBe(true);
  expect(f.tool.definition.sideEffects).toEqual(['state']);
  expect(Object.keys(f.tool.definition)[0]).toBe('parameters');
});

test('equal caller replacements do not inherit native compaction ownership', async () => {
  const f = fixture(), owned = f.tool.definition;
  const replacement: Tool['definition'] = { ...owned, parameters: { ...owned.parameters } };
  f.tool.definition = replacement;
  compactRegisteredToolDefinitions(f.registry);
  expect(f.tool.definition).toBe(replacement);
  expect(Object.isFrozen(replacement)).toBe(false);
  expect(Object.isFrozen(replacement.parameters)).toBe(false);
  const projected = await f.registry.projectCall('native-caller-replacement', 'agent_harness', { mode: 'summary' });
  try {
    f.registry.assertProjectedSnapshot(projected);
    replacement.description = 'Changed caller metadata after compaction.';
    expect(() => f.registry.assertProjectedSnapshot(projected)).toThrow();
  } finally { await f.registry.releaseProjected(projected); }
});
