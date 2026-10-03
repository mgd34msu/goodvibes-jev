import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { listHookPointContracts } from '@goodvibes-jev/engine/sdk/platform/hooks';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import {
  createRuntimeHookApi,
  createShellPathService,
  listInstalledEcosystemEntries,
  upsertEcosystemCatalogEntry,
  type EcosystemCatalogEntry,
  type EcosystemEntryKind,
} from '@/runtime/index.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerHooksRuntimeCommands } from '../../input/commands/hooks-runtime.ts';
import { registerMarketplaceRuntimeCommands } from '../../input/commands/marketplace-runtime.ts';
import { registerOperatorRuntimeCommands } from '../../input/commands/operator-runtime.ts';
import { registerPluginRuntimeCommands } from '../../input/commands/plugin-runtime.ts';
import { registerSkillsRuntimeCommands } from '../../input/commands/skills-runtime.ts';
import { requireEcosystemCatalogPaths } from '../../input/commands/runtime-services.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function delayedPort(answer: Parameters<typeof fakePort>[0] = () => noulAnswer(0.95)) {
  const started = deferred();
  const released = deferred();
  const synthetic = fakePort(answer);
  const port: JudgmentPort = {
    ...synthetic.port,
    async ask(request) {
      started.resolve();
      await released.promise;
      return synthetic.port.ask(request);
    },
  };
  installJudgmentPort(port);
  return { started: started.promise, release: released.resolve, reject: released.reject, requests: synthetic.requests };
}

let previousPort: ReturnType<typeof installJudgmentPort>;
let toolSequence = 0;
beforeEach(() => { previousPort = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previousPort); });

function harness() {
  const root = makeProjectTempDir('async-catalog-contract-commands');
  const output: string[] = [];
  let toolExecutions = 0;
  let managedReads = 0;
  let pluginReloads = 0;
  const tools = new ToolRegistry();
  tools.register({
    definition: {
      name: 'inspect',
      // A fresh description keeps the SDK's intentional description cache out
      // of the timing proof without reaching into its private implementation.
      description: `Inspect fixture ${++toolSequence} before editing it.`,
      parameters: { type: 'object', properties: {} },
    },
    execute: async () => { toolExecutions++; return { success: true }; },
  });
  const contracts = listHookPointContracts().slice(0, 2);
  // This fixture exercises only contract listing. Deliberately omit authoring
  // methods so an unexpected mutation fails instead of silently succeeding.
  const workbench = {
    getHooksFilePath: () => join(root, 'hooks.json'),
    listManagedHooks: () => { managedReads++; return []; },
    listManagedChains: () => { managedReads++; return []; },
  } as unknown as Parameters<typeof createRuntimeHookApi>[0]['workbench'];
  const hookApi = createRuntimeHookApi({
    dispatcher: { listHooks: () => [], listChains: () => [] },
    workbench,
    listContracts: () => contracts,
  });
  const ctx = {
    print: (text: string) => { output.push(text); },
    workspace: { shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }) },
    clients: { hookApi },
    extensions: {
      toolRegistry: tools,
      pluginManager: { reload: async () => { pluginReloads++; } },
    },
  } as unknown as CommandContext;
  const registry = new CommandRegistry();
  registerHooksRuntimeCommands(registry);
  registerMarketplaceRuntimeCommands(registry);
  registerOperatorRuntimeCommands(registry);
  registerPluginRuntimeCommands(registry);
  registerSkillsRuntimeCommands(registry);
  const paths = requireEcosystemCatalogPaths(ctx);
  function addEntry(kind: EcosystemEntryKind = 'plugin', extra: Partial<EcosystemCatalogEntry> = {}) {
    const source = join(root, `${kind}-source`);
    mkdirSync(source, { recursive: true });
    const entry: EcosystemCatalogEntry = {
      id: `${kind}-fixture`, kind, name: `${kind} fixture`, summary: `${kind} summary`,
      source, tags: ['fixture'], ...extra,
    };
    upsertEcosystemCatalogEntry(entry, paths);
    return entry;
  }
  return {
    output, tools, addEntry, paths, contracts,
    managedReads: () => managedReads,
    toolExecutions: () => toolExecutions,
    pluginReloads: () => pluginReloads,
    run: (name: string, args: string[]) => registry.execute(name, args, ctx),
  };
}

describe('async hook contract command', () => {
  test('waits for the SDK filter before printing and reading managed entries', async () => {
    const env = harness();
    const gate = delayedPort((_name, _question, state) => noulAnswer(
      (state as { candidate: { pattern: string } }).candidate.pattern === 'Pre:tool:*' ? 0.95 : 0.02,
    ));
    const pending = env.run('hooks', ['contracts', 'Intercept', 'TOOLS']);
    await gate.started;
    expect(env.output).toEqual([]);
    expect(env.managedReads()).toBe(0);
    gate.release();
    await pending;
    expect(env.output.join('\n')).toContain('Hook Contracts (1)');
    expect(env.output.join('\n')).toContain('Pre:tool:*');
    expect(env.output.join('\n')).not.toContain('Post:tool:*');
    expect(env.managedReads()).toBe(2);
    expect(gate.requests[0]!.state).toMatchObject({ query: 'intercept tools' });
  });

  test('preserves the empty filtered result and the unfiltered catalog', async () => {
    const env = harness();
    installJudgmentPort(fakePort(() => noulAnswer(0.02)).port);
    await env.run('hooks', ['contracts', 'missing']);
    expect(env.output).toEqual(['No hook contracts matched "missing".']);
    installJudgmentPort(undefined);
    env.output.length = 0;
    await env.run('hooks', ['contracts']);
    expect(env.output.join('\n')).toContain(`Hook Contracts (${env.contracts.length})`);
  });

  test('propagates a rejected filter without printing or reading managed entries', async () => {
    const env = harness();
    const gate = delayedPort();
    const pending = env.run('hooks', ['contracts', 'tools']);
    const outcome = pending.then(() => undefined, error => error);
    await gate.started;
    gate.reject(new Error('hook reader unavailable'));
    expect(await outcome).toMatchObject({ message: 'hook reader unavailable' });
    expect(env.output).toEqual([]);
    expect(env.managedReads()).toBe(0);
  });
});

describe('async catalog commands', () => {
  test('marketplace waits for all four catalog kinds before printing one complete result', async () => {
    const env = harness();
    const kinds = ['plugin', 'skill', 'hook-pack', 'policy-pack'] as const;
    const gates = Object.fromEntries(kinds.map(kind => [kind, { started: deferred(), released: deferred() }])) as Record<EcosystemEntryKind, { started: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> }>;
    for (const kind of kinds) env.addEntry(kind);
    const synthetic = fakePort(() => noulAnswer(0.95));
    installJudgmentPort({
      ...synthetic.port,
      async ask(request) {
        const kind = (request.state as { entry: { kind: EcosystemEntryKind } }).entry.kind;
        gates[kind].started.resolve();
        await gates[kind].released.promise;
        return synthetic.port.ask(request);
      },
    });
    const pending = env.run('marketplace', ['browse', 'useful', 'entries']);
    await Promise.all(kinds.map(kind => gates[kind].started.promise));
    expect(env.output).toEqual([]);
    for (const kind of kinds.slice(0, 3)) gates[kind].released.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(env.output).toEqual([]);
    gates['policy-pack'].released.resolve();
    await pending;
    expect(env.output).toHaveLength(1);
    for (const kind of kinds) expect(env.output[0]).toContain(`${kind}-fixture`);
    expect(synthetic.requests).toHaveLength(4);
  });

  for (const command of ['marketplace', 'plugin', 'skills']) {
    test(`${command} preserves delayed empty search results and unfiltered browsing`, async () => {
      const env = harness();
      const kind = command === 'skills' ? 'skill' : 'plugin';
      env.addEntry(kind);
      const gate = delayedPort(() => noulAnswer(0.02));
      const pending = env.run(command, ['browse', 'nothing']);
      await gate.started;
      expect(env.output).toEqual([]);
      gate.release();
      await pending;
      expect(env.output.join('\n')).toContain(command === 'marketplace' ? 'plugins: 0' : `No curated ${kind} catalog entries matched "nothing".`);
      expect(env.output.join('\n')).not.toContain(`${kind}-fixture`);
      installJudgmentPort(undefined);
      env.output.length = 0;
      await env.run(command, ['browse']);
      expect(env.output.join('\n')).toContain(`${kind}-fixture`);
    });
  }

  const reviewCommands = [
    ['marketplace', ['review', 'plugin', 'plugin-fixture']],
    ['marketplace', ['provenance', 'plugin', 'plugin-fixture']],
    ['plugin', ['catalog-review', 'plugin-fixture']],
    ['skills', ['catalog-review', 'skill-fixture']],
  ] as const;
  for (const [command, args] of reviewCommands) {
    test(`${command} ${args[0]} waits for the real SDK review`, async () => {
      const env = harness();
      const kind = command === 'skills' ? 'skill' : 'plugin';
      env.addEntry(kind, { trustNotes: 'Runs commands.', runtimeFit: { minAppVersion: '9999.0.0' } });
      const gate = delayedPort();
      const pending = env.run(command, [...args]);
      await gate.started;
      expect(env.output).toEqual([]);
      gate.release();
      await pending;
      const text = env.output.join('\n');
      if (args[0] === 'provenance') expect(text).toContain('requires GoodVibes >= 9999.0.0');
      else {
        expect(text).toContain('risk: medium');
        expect(text).toContain('sourceExists: yes');
        expect(text).toContain(`recommendedScope: ${kind === 'skill' ? 'user' : 'project'}`);
      }
      expect(text).not.toContain('undefined');
      expect(listInstalledEcosystemEntries(kind, env.paths)).toEqual([]);
      expect(env.pluginReloads()).toBe(0);
    });
  }

  const failingCommands = [
    ['marketplace', ['browse', 'fixture']],
    ['plugin', ['browse', 'fixture']],
    ['skills', ['browse', 'fixture']],
    ...reviewCommands,
  ] as const;
  for (const [command, args] of failingCommands) {
    test(`${command} ${args[0]} propagates delayed rejection without output or install`, async () => {
      const env = harness();
      const kind = command === 'skills' ? 'skill' : 'plugin';
      env.addEntry(kind, { trustNotes: 'Runs commands.' });
      const gate = delayedPort();
      const pending = env.run(command, [...args]);
      const outcome = pending.then(() => undefined, error => error);
      await gate.started;
      gate.reject(new Error('catalog reader unavailable'));
      expect(await outcome).toMatchObject({ message: 'catalog reader unavailable' });
      expect(env.output).toEqual([]);
      expect(listInstalledEcosystemEntries(kind, env.paths)).toEqual([]);
      expect(env.pluginReloads()).toBe(0);
    });
  }
});

describe('async tool verification command', () => {
  for (const args of [['verify', 'inspect'], ['verify-all'], ['contract', 'show', 'inspect']]) {
    test(`${args.join(' ')} waits for the SDK result without executing the tool`, async () => {
      const env = harness();
      const gate = delayedPort(() => noulAnswer(0.02));
      const pending = env.run('tool', args);
      await gate.started;
      expect(env.output).toEqual([]);
      expect(env.toolExecutions()).toBe(0);
      gate.release();
      await pending;
      const text = env.output.join('\n');
      expect(text).toContain('[PASS] inspect');
      expect(text).toContain('description does not clearly explain');
      if (args[0] === 'verify-all') expect(text).toContain('Summary:');
      if (args[0] === 'contract') expect(text).toContain('Tool Definition:');
      expect(env.toolExecutions()).toBe(0);
    });

    test(`${args.join(' ')} propagates a delayed failure without executing the tool`, async () => {
      const env = harness();
      const gate = delayedPort();
      const pending = env.run('tool', args);
      const outcome = pending.then(() => undefined, error => error);
      await gate.started;
      expect(env.output).toEqual([]);
      gate.reject(new Error('tool reader unavailable'));
      expect(await outcome).toMatchObject({ message: 'tool reader unavailable' });
      expect(env.output).toEqual([]);
      expect(env.toolExecutions()).toBe(0);
    });

    test(`${args.join(' ')} propagates missing-reader failures without a success message`, async () => {
      const env = harness();
      await expect(env.run('tool', args)).rejects.toBeInstanceOf(JudgmentPortMissingError);
      expect(env.output).toEqual([]);
      expect(env.toolExecutions()).toBe(0);
    });
  }

  test('missing tools and an empty registry render after their async reads settle', async () => {
    const env = harness();
    await env.run('tool', ['verify', 'absent']);
    await env.run('tool', ['contract', 'show', 'absent']);
    expect(env.output).toEqual([
      "[tool verify] Tool 'absent' is not registered.",
      "[tool contract show] Tool 'absent' is not registered.",
    ]);
    env.tools.unregister('inspect');
    env.output.length = 0;
    await env.run('tool', ['verify-all']);
    expect(env.output.join('\n')).toContain('Summary: 0 passed, 0 passed with warnings, 0 failed.');
  });
});
