/**
 * Regression tests for /eval command argument parsing.
 *
 * Guards against finding [5]: `--save-baseline` poisoning baselineFile when
 * passed in the second positional slot of `/eval gate <suite> --save-baseline`.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EvalRegistry } from '@goodvibes-jev/engine/sdk/platform/observe';
import { EvalRegistry as ViewEvalRegistry } from '../../views/eval-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { evalCommand } from '../../input/commands/eval.ts';
import { createBootstrapCommandExtensionsSection } from '../../runtime/bootstrap-command-parts.ts';
import type { BootstrapCommandShellServices } from '@/runtime/index.ts';
import { createShellPathService } from '@/runtime/index.ts';

function makeGateContext(printed: string[], evalRegistry?: EvalRegistry): CommandContext {
  // process.cwd() as workingDirectory so the SDK resolveBaselinePath check
  // (which resolves relative to CWD, not projectRoot) passes for relative paths.
  const shellPaths = createShellPathService({
    workingDirectory: process.cwd(),
    homeDirectory: process.cwd(),
  });
  return {
    session: {
      conversationManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'session-eval-test',
      },
    },
    provider: { providerRegistry: {} as never },
    workspace: { shellPaths },
    platform: { config: {} as never, configManager: {} as never },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      memoryRegistry: {} as never,
      forensicsRegistry: {} as never,
      evalRegistry,
    },
    clients: {} as never,
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  } as unknown as CommandContext;
}

describe('evalCommand gate -- flag-safe positional parsing', () => {
  // -- Integration tests (unknown suite -> early exit, no file I/O) ------------

  test('gate with flag in 2nd slot: error names the actual suite, not the flag', async () => {
    // /eval gate BOGUSSUITE --save-baseline
    // Before fix: args[1]='--save-baseline' -> baselineFile='--save-baseline' (path bug)
    // Both old and new exit early on unknown suite; the error message must
    // mention the real suite name 'BOGUSSUITE', never '--save-baseline'.
    const printed: string[] = [];
    const ctx = makeGateContext(printed);
    await evalCommand.handler(['gate', 'BOGUSSUITE', '--save-baseline'], ctx);
    expect(printed.some(l => l.includes('Unknown suite: "BOGUSSUITE"'))).toBe(true);
    expect(printed.some(l => l.includes('"--save-baseline"'))).toBe(false);
  });

  test('gate with flag-first ordering: suite name resolved from positionals', async () => {
    // /eval gate --save-baseline BOGUSSUITE
    // Before fix: args[0]='--save-baseline' -> suiteName='--save-baseline' -> error names the flag!
    // After fix:  positionals[0]='BOGUSSUITE' -> suiteName='BOGUSSUITE' -> error names BOGUSSUITE
    const printed: string[] = [];
    const ctx = makeGateContext(printed);
    await evalCommand.handler(['gate', '--save-baseline', 'BOGUSSUITE'], ctx);
    expect(printed.some(l => l.includes('Unknown suite: "BOGUSSUITE"'))).toBe(true);
    expect(printed.some(l => l.includes('Unknown suite: "--save-baseline"'))).toBe(false);
  });
});


function makeComposedExtensions(): CommandContext['extensions'] {
  return createBootstrapCommandExtensionsSection({
    toolRegistry: {} as never,
    mcpRegistry: {} as never,
  }, { extensions: {} } as BootstrapCommandShellServices);
}

describe('evalCommand canonical observe registry adoption', () => {
  test('production composition owns a registry shared across commands and isolated per context', async () => {
    const extensions = makeComposedExtensions();
    const other = makeComposedExtensions();
    const registry = extensions.evalRegistry;
    expect(registry).toBeInstanceOf(EvalRegistry);
    expect(other.evalRegistry).not.toBe(registry);
    const printed: string[] = [];
    const context = { ...makeGateContext(printed), extensions };
    await evalCommand.handler(['run', 'cost-tokens'], context);
    expect(registry?.getSuiteResults().map(result => result.suite)).toEqual(['cost-tokens']);
    expect(other.evalRegistry?.getSuiteResults()).toEqual([]);
    expect(registry?.getLastRunAt()).toBeGreaterThan(0);
    // The next command sees the run, rather than the empty-registry early return.
    const missing = join(process.cwd(), `.eval-missing-${crypto.randomUUID()}.json`);
    await evalCommand.handler(['compare', missing], context);
    expect(printed.at(-2)).toBe(`[eval] Baseline file not found: ${missing}`);
  });

  test('the compatibility view exports the public engine constructor', () => {
    expect(ViewEvalRegistry).toBe(EvalRegistry);
  });

  test('run updates the canonical read model, replaces suites, and respects unsubscribe', async () => {
    let now = 100;
    const registry = new EvalRegistry(() => now);
    const printed: string[] = [];
    const context = makeGateContext(printed, registry);
    const states: boolean[] = [];
    const unsubscribe = registry.subscribe(() => states.push(registry.isRunning()));
    expect(registry.getLastRunAt()).toBeNull();

    await evalCommand.handler(['run', 'core-performance'], context);
    const first = registry.getSuiteResults()[0];
    expect(first?.suite).toBe('core-performance');
    expect(first?.results.length).toBeGreaterThan(0);
    expect(registry.getLastRunAt()).toBe(100);
    expect(states).toEqual([true, true, false]);
    expect(printed.some(line => line.includes('Running suite: core-performance'))).toBe(true);

    now = 200;
    await evalCommand.handler(['run', 'safety-baseline'], context);
    await evalCommand.handler(['run', 'core-performance'], context);
    expect(registry.getSuiteResults().map(result => result.suite)).toEqual([
      'core-performance', 'safety-baseline',
    ]);
    expect(registry.getSuiteResults()[0]).not.toBe(first);
    expect(registry.getLastRunAt()).toBe(200);
    expect(registry.isRunning()).toBe(false);
    expect(states).toHaveLength(9);

    unsubscribe();
    await evalCommand.handler(['run', 'core-performance'], context);
    expect(states).toHaveLength(9);
    expect(registry.isRunning()).toBe(false);
  });

  test('gate replaces results per suite and compare reads the same canonical registry', async () => {
    const directory = mkdtempSync(join(process.cwd(), '.eval-registry-test-'));
    const baseline = join(directory, 'baseline.json');
    const registry = new EvalRegistry(() => 300);
    const printed: string[] = [];
    const context = makeGateContext(printed, registry);
    const states: boolean[] = [];
    const unsubscribe = registry.subscribe(() => states.push(registry.isRunning()));
    try {
      await evalCommand.handler(['gate', 'cost-tokens', baseline, '--save-baseline'], context);
      const firstSuite = registry.getSuiteResults()[0];
      const firstGate = registry.getGateResults()[0];
      expect(firstGate?.suite).toBe('cost-tokens');
      expect(states).toEqual([true, true, false, false]);
      expect(await Bun.file(baseline).exists()).toBe(true);

      await evalCommand.handler(['gate', 'safety-baseline', baseline], context);
      await evalCommand.handler(['gate', 'cost-tokens', baseline], context);
      expect(registry.getSuiteResults().map(result => result.suite)).toEqual([
        'cost-tokens', 'safety-baseline',
      ]);
      expect(registry.getGateResults().map(result => result.suite)).toEqual([
        'cost-tokens', 'safety-baseline',
      ]);
      expect(registry.getSuiteResults()[0]).not.toBe(firstSuite);
      expect(registry.getGateResults()[0]).not.toBe(firstGate);
      expect(registry.getLastRunAt()).toBe(300);
      expect(registry.isRunning()).toBe(false);
      expect(states).toHaveLength(12);

      printed.length = 0;
      await evalCommand.handler(['compare', baseline], context);
      expect(printed).toHaveLength(2);
      expect(printed[0]).toContain('cost-tokens');
      expect(printed[1]).toContain('safety-baseline');
      expect(states).toHaveLength(12);
      unsubscribe();
      await evalCommand.handler(['gate', 'cost-tokens', baseline], context);
      expect(states).toHaveLength(12);
    } finally {
      unsubscribe();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
