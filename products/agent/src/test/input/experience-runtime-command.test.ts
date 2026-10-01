import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerExperienceRuntimeCommands } from '../../input/commands/experience-runtime.ts';
import { registerHealthRuntimeCommands } from '../../input/commands/health-runtime.ts';
import { registerLocalRuntimeCommands } from '../../input/commands/local-runtime.ts';
import { registerProviderAccountsRuntimeCommands } from '../../input/commands/provider-accounts-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeContext(out: string[], opened: string[]): CommandContext {
  return {
    print: (text: string) => { out.push(text); },
    showPanel: (panelId: string) => { opened.push(panelId); },
  } as unknown as CommandContext;
}

describe('experience runtime commands', () => {
  test('approval open is guidance-only in Agent and does not open copied panels', async () => {
    const registry = new CommandRegistry();
    registerExperienceRuntimeCommands(registry);
    const command = registry.get('approval');
    expect(command).toEqual(expect.objectContaining({
      name: 'approval',
      handler: expect.any(Function),
    }));
    const out: string[] = [];
    const opened: string[] = [];

    await command!.handler(['open'], makeContext(out, opened));

    expect(opened).toEqual([]);
    expect(out.join('\n')).toContain('Open Agent Workspace -> Work & Approvals -> Review approval class');
    expect(out.join('\n')).toContain('or run /approval matrix');
  });

  test('approval matrix remains a read-only transcript summary', async () => {
    const registry = new CommandRegistry();
    registerExperienceRuntimeCommands(registry);
    const command = registry.get('approval');
    expect(command).toEqual(expect.objectContaining({
      name: 'approval',
      handler: expect.any(Function),
    }));
    const out: string[] = [];

    await command!.handler(['matrix'], makeContext(out, []));

    expect(out.join('\n')).toContain('Approval Matrix');
    expect(out.join('\n')).toContain('delegate');
  });

  test('accounts open is guidance-only in Agent and does not open copied panels', async () => {
    const registry = new CommandRegistry();
    registerProviderAccountsRuntimeCommands(registry);
    const command = registry.get('accounts');
    expect(command).toEqual(expect.objectContaining({
      name: 'accounts',
      handler: expect.any(Function),
    }));
    const out: string[] = [];
    const opened: string[] = [];

    await command!.handler(['open'], makeContext(out, opened));

    expect(opened).toEqual([]);
    expect(out.join('\n')).toContain('Open Agent Workspace -> Start -> Sign in to a provider');
    expect(out.join('\n')).toContain('or run /accounts review');
  });

  test('health open is guidance-only in Agent before read-model requirements', async () => {
    const registry = new CommandRegistry();
    registerHealthRuntimeCommands(registry);
    const command = registry.get('health');
    expect(command).toEqual(expect.objectContaining({
      name: 'health',
      handler: expect.any(Function),
    }));
    const out: string[] = [];

    await command!.handler(['open'], makeContext(out, []));

    expect(out.join('\n')).toContain('Open Agent Workspace -> Home');
    expect(out.join('\n')).toContain('or run /health review');
  });

  test('health command with unavailable service stub prints plain-language error', async () => {
    const registry = new CommandRegistry();
    registerHealthRuntimeCommands(registry);
    const command = registry.get('health');
    const out: string[] = [];
    const context = {
      print: (text: string) => { out.push(text); },
      platform: {
        configManager: {
          get: () => null,
        },
        readModels: {
          session: {
            getSnapshot: () => { throw new Error('session service unavailable'); },
          },
          remote: {
            getSnapshot: () => ({
              supervisor: { sessions: [], activeConnections: 0, degradedConnections: 0 },
            }),
          },
        },
      },
    } as unknown as CommandContext;

    // The review subcommand calls requireReadModels which will reach session.getSnapshot
    // via requireProviderApi, simulate a require* helper that throws
    const contextThrows = {
      print: (text: string) => { out.push(text); },
      platform: {},
    } as unknown as CommandContext;

    await command!.handler(['review'], contextThrows);

    const output = out.join('\n');
    // Should have caught the error and printed a plain-language message, not thrown
    expect(output).toContain('Health command failed');
  });

  test('voice bundle inspect with missing file prints File not found', async () => {
    const registry = new CommandRegistry();
    registerExperienceRuntimeCommands(registry);
    const command = registry.get('voice');
    const out: string[] = [];
    const context = {
      print: (text: string) => { out.push(text); },
      platform: {
        configManager: {
          get: () => null,
        },
      },
      session: { runtime: { sessionId: 'test' } },
      extensions: {},
      clients: {},
    } as unknown as CommandContext;

    const contextWithShell = {
      ...context,
      workspace: {
        shellPaths: {
          resolveWorkspacePath: (p: string) => p,
        },
      },
    } as unknown as CommandContext;

    // Use a path that definitely does not exist
    const missingBundlePath = join(makeProjectTempDir('gv-bundle-inspect'), 'gv-nonexistent-bundle-xyz.json');
    await command!.handler(['bundle', 'inspect', missingBundlePath], contextWithShell);

    expect(out.join('\n')).toContain('File not found');
  });

  test('voice bundle inspect with malformed JSON prints could not read voice bundle', async () => {
    const registry = new CommandRegistry();
    registerExperienceRuntimeCommands(registry);
    const command = registry.get('voice');
    const out: string[] = [];
    const tmpDir = makeProjectTempDir('gv-voice-test');
    const bundlePath = join(tmpDir, 'bad-bundle.json');
    writeFileSync(bundlePath, 'not valid json {{{');

    const context = {
      print: (text: string) => { out.push(text); },
      platform: {
        configManager: { get: () => null },
      },
      session: { runtime: { sessionId: 'test' } },
      workspace: { shellPaths: { resolveWorkspacePath: (p: string) => p } },
      clients: {},
    } as unknown as CommandContext;

    await command!.handler(['bundle', 'inspect', bundlePath], context);

    expect(out.join('\n')).toContain('could not read voice bundle');
  });

  test('unpin works with modelId when model was pinned by registryKey', async () => {
    const registry = new CommandRegistry();
    registerLocalRuntimeCommands(registry);
    const command = registry.get('unpin');
    const out: string[] = [];
    const unpinnedKeys: string[] = [];
    const context = {
      print: (text: string) => { out.push(text); },
      session: { runtime: { sessionId: 'test' } },
      platform: { configManager: { get: () => null } },
      extensions: {},
      clients: {},
      provider: {
        providerRegistry: {
          listProviders: () => [],
        },
      },
      ops: {},
    } as unknown as CommandContext;

    const contextWithApi = {
      ...context,
      clients: {
        providerApi: {
          getFavorites: async () => ({
            pinned: [
              { registryKey: 'anthropic:claude-sonnet-4-5', modelId: 'claude-sonnet-4-5' },
            ],
          }),
          unpinModel: async (key: string) => { unpinnedKeys.push(key); },
        },
      },
    } as unknown as CommandContext;

    // Unpin by short modelId (not registryKey)
    await command!.handler(['claude-sonnet-4-5'], contextWithApi);

    expect(unpinnedKeys).toEqual(['anthropic:claude-sonnet-4-5']);
    expect(out.join('\n')).toContain('Unpinned');
  });

  test('health remote repair guidance uses remote build-host wording', async () => {
    const registry = new CommandRegistry();
    registerHealthRuntimeCommands(registry);
    const command = registry.get('health');
    expect(command).toEqual(expect.objectContaining({
      name: 'health',
      handler: expect.any(Function),
    }));
    const out: string[] = [];
    const context = {
      print: (text: string) => { out.push(text); },
      platform: {
        readModels: {
          remote: {
            getSnapshot: () => ({
              supervisor: {
                sessions: [],
                activeConnections: 0,
                degradedConnections: 0,
              },
            }),
          },
        },
      },
    } as unknown as CommandContext;

    await command!.handler(['remote'], context);

    const text = out.join('\n');
    expect(text).toContain('repair remote build-host state outside Agent');
    expect(text).not.toContain('repair remote runner state');
    expect(text).not.toContain('repair remote worker state');
  });

  test('health memory renders the live governor snapshot: tier, budget vs rss, caches, paused jobs, tripwire', async () => {
    const registry = new CommandRegistry();
    registerHealthRuntimeCommands(registry);
    const command = registry.get('health');
    const out: string[] = [];
    const context = {
      print: (text: string) => { out.push(text); },
      platform: {
        readModels: {},
        memoryGovernor: {
          snapshot: () => ({
            tier: 'elevated',
            budgetMb: 2048,
            rssMb: 1433.6,
            heapUsedMb: 512.3,
            heapTotalMb: 768.1,
            usedPct: 70,
            refusingExpensiveWork: false,
            caches: [
              { id: 'knowledge-store', name: 'knowledge stores (agent + home-graph)', entries: 42, estimatedBytes: 204_800 },
              { id: 'session-union', name: 'shared session broker (sessions + message/input buckets)', entries: 7 },
            ],
            pausedJobs: ['knowledge-self-improvement'],
            tripwire: { armed: true, sustainedSec: 12, rateMbPerSec: 55 },
            thresholds: { elevatedPct: 60, highPct: 75, criticalPct: 90 },
          }),
        },
      },
    } as unknown as CommandContext;

    await command!.handler(['memory'], context);

    const text = out.join('\n');
    expect(text).toContain('Health Review Memory');
    expect(text).toContain('tier elevated');
    expect(text).toContain('rss 1433.6 MB of 2048 MB budget (70%)');
    expect(text).toContain('heap used 512.3 MB of 768.1 MB');
    expect(text).toContain('expensive work admitted');
    expect(text).toContain('tier thresholds 60% elevated, 75% high, 90% critical');
    expect(text).toContain('leak tripwire ARMED (55 MB/s sustained 12s)');
    expect(text).toContain('caches 2');
    expect(text).toContain('knowledge-store 42 entries (~200 KiB)');
    expect(text).toContain('session-union 7 entries');
    expect(text).toContain('paused background jobs knowledge-self-improvement');
    expect(text).not.toContain('available: no');
  });

  test('health memory degrades honestly against an old-daemon context with no governor (never a fabricated snapshot)', async () => {
    const registry = new CommandRegistry();
    registerHealthRuntimeCommands(registry);
    const command = registry.get('health');
    const out: string[] = [];
    // Old-daemon mock: a platform section from a host runtime predating
    // memory governance, no memoryGovernor field at all.
    const context = {
      print: (text: string) => { out.push(text); },
      platform: { readModels: {} },
    } as unknown as CommandContext;

    await command!.handler(['memory'], context);

    const text = out.join('\n');
    expect(text).toContain('Health Review Memory');
    expect(text).toContain('available: no');
    expect(text).toContain('no memory governor is running in this build');
    expect(text).not.toMatch(/tier |rss .*budget/);
  });

  test('health repair memory routes to the live diagnostics and the real memory settings', async () => {
    const registry = new CommandRegistry();
    registerHealthRuntimeCommands(registry);
    const command = registry.get('health');
    const out: string[] = [];
    const context = {
      print: (text: string) => { out.push(text); },
      platform: { readModels: {} },
    } as unknown as CommandContext;

    await command!.handler(['repair', 'memory'], context);

    const text = out.join('\n');
    expect(text).toContain('domain memory');
    expect(text).toContain('/health memory');
    expect(text).toContain('/config memory.budgetMb');
    expect(text).not.toContain('no local repair action exists');
  });

  test('voice status reports the real managed local-voice runtime state', async () => {
    const registry = new CommandRegistry();
    registerExperienceRuntimeCommands(registry);
    const command = registry.get('voice');
    const out: string[] = [];
    const context = {
      print: (text: string) => { out.push(text); },
      platform: {
        configManager: { get: () => null },
        voiceSetup: {
          status: () => ({
            platform: 'linux',
            state: 'not-provisioned',
            tts: { engine: 'piper', binaryPresent: false, voicePresent: false, binaryPath: '', modelPath: '' },
            stt: { engine: 'whisper.cpp', supported: true, state: 'not-provisioned', binaryPresent: false, modelPresent: false, binaryPath: '', modelPath: '', reason: '' },
            offerBytes: 62_000_000,
          }),
        },
      },
      workspace: { shellPaths: { resolveWorkspacePath: (p: string) => p } },
      session: { runtime: { sessionId: 'test' } },
      clients: {},
    } as unknown as CommandContext;

    await command!.handler(['status'], context);

    const text = out.join('\n');
    expect(text).toContain('Managed Local-Voice Status');
    expect(text).toContain('platform: linux');
    expect(text).toContain('state: not provisioned');
    expect(text).toContain('install size ~59 MB');
    // No install running: the status carries no installInProgress section,
    // so the view shows the setup hint and never a fabricated progress block.
    expect(text).toContain('next /voice setup --yes');
    expect(text).not.toContain('install in progress');
  });

  test('voice status renders the live installInProgress section while an install runs', async () => {
    const registry = new CommandRegistry();
    registerExperienceRuntimeCommands(registry);
    const command = registry.get('voice');
    const out: string[] = [];
    const startedAt = Date.UTC(2026, 6, 16, 7, 0, 0);
    const context = {
      print: (text: string) => { out.push(text); },
      platform: {
        configManager: { get: () => null },
        voiceSetup: {
          status: () => ({
            platform: 'linux',
            state: 'not-provisioned',
            tts: { engine: 'piper', binaryPresent: false, voicePresent: false, binaryPath: '', modelPath: '' },
            stt: { engine: 'whisper.cpp', supported: true, state: 'not-provisioned', binaryPresent: false, modelPresent: false, binaryPath: '', modelPath: '', reason: '' },
            offerBytes: 219_000_000,
            installInProgress: {
              startedAt,
              components: [
                { component: 'piper-engine', phase: 'download', bytesTotal: 12_582_912 },
                { component: 'piper-voice', phase: 'verify', bytesTotal: 62_914_560, bytesDone: 62_914_560 },
                { component: 'whisper-engine', phase: 'skip', message: 'no pinned bundle for this platform' },
              ],
            },
          }),
        },
      },
      workspace: { shellPaths: { resolveWorkspacePath: (p: string) => p } },
      session: { runtime: { sessionId: 'test' } },
      clients: {},
    } as unknown as CommandContext;

    await command!.handler(['status'], context);

    const text = out.join('\n');
    expect(text).toContain(`install in progress (started ${new Date(startedAt).toISOString()})`);
    expect(text).toContain('piper-engine: download (12.0 MB)');
    expect(text).toContain('piper-voice: verify (60.0 of 60.0 MB)');
    expect(text).toContain('whisper-engine: skip, no pinned bundle for this platform');
    // An active install replaces the setup hint (running it again would just
    // join the same single-flight run).
    expect(text).not.toContain('next /voice setup --yes');
  });

  test('voice setup without --yes refuses and names the confirmation usage', async () => {
    const registry = new CommandRegistry();
    registerExperienceRuntimeCommands(registry);
    const command = registry.get('voice');
    const out: string[] = [];
    let installCalled = false;
    const context = {
      print: (text: string) => { out.push(text); },
      platform: {
        configManager: { get: () => null },
        voiceSetup: { install: async () => { installCalled = true; throw new Error('must not be called'); } },
      },
      workspace: { shellPaths: { resolveWorkspacePath: (p: string) => p } },
      session: { runtime: { sessionId: 'test' } },
      clients: {},
    } as unknown as CommandContext;

    await command!.handler(['setup'], context);

    expect(installCalled).toBe(false);
    expect(out.join('\n')).toContain('Refusing to install the managed local-voice runtime');
    expect(out.join('\n')).toContain('/voice setup --yes');
  });

  test('voice setup --yes runs the one-act install and prints per-component progress plus the final receipt', async () => {
    const registry = new CommandRegistry();
    registerExperienceRuntimeCommands(registry);
    const command = registry.get('voice');
    const out: string[] = [];
    const context = {
      print: (text: string) => { out.push(text); },
      platform: {
        configManager: { get: () => null },
        voiceSetup: {
          install: async () => ({
            provisioned: true,
            platform: 'linux',
            tts: { engine: 'piper', state: 'provisioned', binaryPath: '/managed/piper', modelPath: '/managed/voice.onnx' },
            // Honest terminal state for STT where goodvibes has not yet published a pinned
            // bundle for this platform, not a fabricated success.
            stt: { engine: 'whisper.cpp', state: 'unsupported-platform', reason: 'no pinned whisper.cpp bundle published for this platform yet' },
            components: [
              { id: 'piper-engine', state: 'installed', bytes: 12_000_000 },
              { id: 'piper-voice', state: 'installed', bytes: 47_000_000 },
              { id: 'whisper-engine', state: 'skipped', error: 'no pinned bundle for this platform' },
            ],
            configured: {
              set: [{ key: 'voice.local.tts.binary', value: '/managed/piper' }],
              skipped: [{ key: 'voice.local.tts.binary', reason: 'already set by the user' }],
            },
          }),
        },
      },
      workspace: { shellPaths: { resolveWorkspacePath: (p: string) => p } },
      session: { runtime: { sessionId: 'test' } },
      clients: {},
    } as unknown as CommandContext;

    await command!.handler(['setup', '--yes'], context);
    // The install runs fire-and-forget so the prompt is never blocked on a
    // multi-hundred-MB download; let its .then() callback flush before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const text = out.join('\n');
    expect(text).toContain('Installing managed local-voice runtime');
    expect(text).toContain('Managed Local-Voice Setup');
    expect(text).toContain('piper-engine: installed');
    expect(text).toContain('piper-voice: installed');
    expect(text).toContain('whisper-engine: skipped (no pinned bundle for this platform)');
    expect(text).toContain('stt (whisper.cpp): unsupported platform (no pinned whisper.cpp bundle published for this platform yet)');
    expect(text).toContain('result: voice.local.* configured');
    expect(text).toContain('set voice.local.tts.binary = /managed/piper');
    expect(text).toContain('skipped voice.local.tts.binary (already set by the user)');
  });

  test('voice setup --yes polls status while the install is in flight and renders live per-component progress lines', async () => {
    const registry = new CommandRegistry();
    registerExperienceRuntimeCommands(registry);
    const command = registry.get('voice');
    const out: string[] = [];
    // A slow install (resolves after ~700ms) whose status() serves an
    // evolving installInProgress section while it runs, the same contract a
    // live daemon composition provides (sdk 5357f09e).
    let installRunning = false;
    let statusReads = 0;
    const context = {
      print: (text: string) => { out.push(text); },
      platform: {
        configManager: { get: () => null },
        voiceSetup: {
          status: () => {
            statusReads += 1;
            return {
              platform: 'linux',
              state: 'not-provisioned',
              tts: { engine: 'piper', binaryPresent: false, voicePresent: false, binaryPath: '', modelPath: '' },
              stt: { engine: 'whisper.cpp', supported: true, state: 'not-provisioned', binaryPresent: false, modelPresent: false, binaryPath: '', modelPath: '', reason: '' },
              offerBytes: 219_000_000,
              ...(installRunning
                ? {
                  installInProgress: {
                    startedAt: Date.now(),
                    components: statusReads < 2
                      ? [{ component: 'piper-engine', phase: 'download', bytesTotal: 12_582_912 }]
                      : [
                        { component: 'piper-engine', phase: 'done', bytesTotal: 12_582_912, bytesDone: 12_582_912 },
                        { component: 'piper-voice', phase: 'download', bytesTotal: 62_914_560 },
                      ],
                  },
                }
                : {}),
            };
          },
          install: async () => {
            installRunning = true;
            await new Promise((resolve) => setTimeout(resolve, 700));
            installRunning = false;
            return {
              provisioned: true,
              platform: 'linux',
              tts: { engine: 'piper', state: 'provisioned', binaryPath: '/managed/piper', modelPath: '/managed/voice.onnx' },
              stt: { engine: 'whisper.cpp', state: 'provisioned', binaryPath: '/managed/whisper', modelPath: '/managed/model.bin' },
              components: [
                { id: 'piper-engine', state: 'installed', bytes: 12_582_912 },
                { id: 'piper-voice', state: 'installed', bytes: 62_914_560 },
              ],
              configured: { set: [], skipped: [] },
            };
          },
        },
      },
      workspace: { shellPaths: { resolveWorkspacePath: (p: string) => p } },
      session: { runtime: { sessionId: 'test' } },
      clients: {},
    } as unknown as CommandContext;

    await command!.handler(['setup', '--yes'], context);
    // Let the install and its polling loop run to completion.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const text = out.join('\n');
    // Live progress rendered WHILE the install ran, then the final receipt.
    expect(text).toContain('piper-engine: download (12.0 MB)');
    expect(text).toContain('piper-engine: done (12.0 of 12.0 MB)');
    expect(text).toContain('piper-voice: download (60.0 MB)');
    expect(text).toContain('Managed Local-Voice Setup');
    expect(text).toContain('result: voice.local.* configured');
    // The receipt comes after the progress lines.
    expect(text.indexOf('piper-engine: download')).toBeLessThan(text.indexOf('Managed Local-Voice Setup'));
    // A changed component line prints once per change, not once per poll.
    const downloadLineCount = out.filter((line) => line === '  piper-engine: download (12.0 MB)').length;
    expect(downloadLineCount).toBe(1);
  });

  test('voice setup --yes against a host whose status has no installInProgress keeps the honest busy line (no fabricated progress)', async () => {
    const registry = new CommandRegistry();
    registerExperienceRuntimeCommands(registry);
    const command = registry.get('voice');
    const out: string[] = [];
    // Old-daemon shape: status never carries installInProgress.
    const context = {
      print: (text: string) => { out.push(text); },
      platform: {
        configManager: { get: () => null },
        voiceSetup: {
          status: () => ({
            platform: 'linux',
            state: 'not-provisioned',
            tts: { engine: 'piper', binaryPresent: false, voicePresent: false, binaryPath: '', modelPath: '' },
            stt: { engine: 'whisper.cpp', supported: false, state: 'unsupported-platform', binaryPresent: false, modelPresent: false, binaryPath: '', modelPath: '' },
            offerBytes: 219_000_000,
          }),
          install: async () => {
            await new Promise((resolve) => setTimeout(resolve, 600));
            return {
              provisioned: false,
              platform: 'linux',
              tts: { engine: 'piper', state: 'download-failed', reason: 'network unreachable' },
              stt: { engine: 'whisper.cpp', state: 'unsupported-platform' },
              components: [{ id: 'piper-engine', state: 'failed', error: 'network unreachable' }],
              configured: { set: [], skipped: [] },
            };
          },
        },
      },
      workspace: { shellPaths: { resolveWorkspacePath: (p: string) => p } },
      session: { runtime: { sessionId: 'test' } },
      clients: {},
    } as unknown as CommandContext;

    await command!.handler(['setup', '--yes'], context);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const text = out.join('\n');
    expect(text).toContain('Installing managed local-voice runtime');
    // No progress lines were fabricated from an absent section (live progress
    // lines are the only ones that carry byte sizes in MB)...
    expect(text).not.toContain('MB)');
    expect(text).not.toContain(' of ');
    // ...and the honest failure receipt still lands.
    expect(text).toContain('piper-engine: failed (network unreachable)');
    expect(text).toContain('result: not provisioned');
  });
});
