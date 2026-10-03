import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import type { BackgroundProviderDiscoveryOptions, BackgroundRuntimeTaskHandle, HostSystemMessageSink } from '@/runtime/index.ts';
import {
  discoveredProvidersFilePath,
  loadLanScanConsent,
  runGatedLanScan,
  saveLanScanConsent,
  NETWORK_SCAN_ENABLE_COMMAND,
  type LanScanGateOptions,
} from '../../runtime/lan-scan-consent.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const SURFACE_ROOT = 'agent';

/**
 * A recording fake for the {low, high} system-message sink. Never a real
 * router, just captures what was sent so tests can assert on exact wording
 * and on the absence of raw host:port text.
 */
function makeRouterSpy() {
  const low: string[] = [];
  const high: string[] = [];
  const router: HostSystemMessageSink = {
    low: (m: string) => low.push(m),
    high: (m: string) => high.push(m),
  };
  return { router, low, high };
}

function makeGateOptions(root: string, overrides: Partial<LanScanGateOptions> = {}): LanScanGateOptions {
  const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const { router } = makeRouterSpy();
  return {
    configManager: {} as unknown as BackgroundProviderDiscoveryOptions['configManager'],
    providerRegistry: {} as unknown as BackgroundProviderDiscoveryOptions['providerRegistry'],
    runtime: { model: 'openrouter:openrouter/free', provider: 'openrouter' },
    requestRender: () => {},
    restoreRuntimeModel: () => {},
    systemMessageRouter: router,
    shellPaths,
    surfaceRoot: SURFACE_ROOT,
    ...overrides,
  };
}

/** A fake discovery pass, this is the ONLY thing allowed to stand in for the
 * SDK's real subnet scan in tests. It never touches the network. */
function fakeDiscovery(
  emit: (opts: BackgroundProviderDiscoveryOptions) => void,
): { readonly fn: (opts: BackgroundProviderDiscoveryOptions) => BackgroundRuntimeTaskHandle; calls: number } {
  let calls = 0;
  const fn = (opts: BackgroundProviderDiscoveryOptions): BackgroundRuntimeTaskHandle => {
    calls += 1;
    emit(opts);
    return { stopped: false, stop() {} };
  };
  return { fn, get calls() { return calls; } };
}

describe('lan-scan-consent: persistence', () => {
  test('loadLanScanConsent returns undefined when nothing has ever been decided', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    expect(loadLanScanConsent(shellPaths, SURFACE_ROOT)).toBeUndefined();
  });

  test('saveLanScanConsent + loadLanScanConsent round-trips granted and declined', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });

    saveLanScanConsent(shellPaths, SURFACE_ROOT, 'granted');
    expect(loadLanScanConsent(shellPaths, SURFACE_ROOT)?.decision).toBe('granted');

    saveLanScanConsent(shellPaths, SURFACE_ROOT, 'declined');
    expect(loadLanScanConsent(shellPaths, SURFACE_ROOT)?.decision).toBe('declined');
  });

  test('an invalid/corrupt consent file is treated as undecided, not a crash', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const path = shellPaths.resolveUserPath(SURFACE_ROOT, 'network-discovery-consent.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not json', 'utf-8');
    expect(loadLanScanConsent(shellPaths, SURFACE_ROOT)).toBeUndefined();
  });

  test('discoveredProvidersFilePath points at the same location the SDK persists scan results to', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    expect(discoveredProvidersFilePath(shellPaths, SURFACE_ROOT)).toBe(
      join(root, '.goodvibes', SURFACE_ROOT, 'discovered-providers.json'),
    );
  });
});

describe('runGatedLanScan: consent gate (test doubles only: never a real network probe)', () => {
  test('first run never scans silently: no decision on disk -> discovery is not invoked', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    const discovery = fakeDiscovery(() => {
      throw new Error('must never be called before consent is granted');
    });
    const { router, low } = makeRouterSpy();

    const handle = runGatedLanScan(makeGateOptions(root, { systemMessageRouter: router, startDiscovery: discovery.fn }));

    expect(discovery.calls).toBe(0);
    expect(handle.stopped).toBe(false);
    expect(low).toHaveLength(1);
    expect(low[0]).toContain('local network');
    expect(low[0]).toContain('subnet only');
    expect(low[0]).toContain(NETWORK_SCAN_ENABLE_COMMAND);
    expect(low[0]).toContain(discoveredProvidersFilePath(createShellPathService({ workingDirectory: root, homeDirectory: root }), SURFACE_ROOT));
  });

  test('first run persists the off-until-consented default so it is not silently re-asked forever', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    const discovery = fakeDiscovery(() => {});
    runGatedLanScan(makeGateOptions(root, { startDiscovery: discovery.fn }));

    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    expect(loadLanScanConsent(shellPaths, SURFACE_ROOT)?.decision).toBe('declined');
  });

  test('declining (already decided, i.e. a relaunch) -> no scan, and no repeated reminder (F3): silent, discoverable via /network-scan status', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    saveLanScanConsent(shellPaths, SURFACE_ROOT, 'declined');

    const discovery = fakeDiscovery(() => {
      throw new Error('must never be called while declined');
    });
    const { router, low } = makeRouterSpy();

    const handle = runGatedLanScan(makeGateOptions(root, { systemMessageRouter: router, startDiscovery: discovery.fn }));

    expect(discovery.calls).toBe(0);
    expect(handle.stopped).toBe(false);
    expect(low).toEqual([]);
  });

  test('declining stays silent across many relaunches in a row (never nags forever)', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    saveLanScanConsent(shellPaths, SURFACE_ROOT, 'declined');

    const discovery = fakeDiscovery(() => {
      throw new Error('must never be called while declined');
    });
    const { router, low } = makeRouterSpy();

    for (let i = 0; i < 5; i += 1) {
      runGatedLanScan(makeGateOptions(root, { systemMessageRouter: router, startDiscovery: discovery.fn }));
    }

    expect(discovery.calls).toBe(0);
    expect(low).toEqual([]);
  });

  test('the decision persists across relaunches: a granted decision keeps scanning without re-asking', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    saveLanScanConsent(shellPaths, SURFACE_ROOT, 'granted');

    const discovery = fakeDiscovery((opts) => {
      opts.systemMessageRouter.low('[Scan] Found ollama at 192.168.1.42:11434 (1 model)');
      opts.requestRender();
    });
    const { router, low } = makeRouterSpy();

    // Two "relaunches" in a row, both should scan (via the fake), neither shows a consent prompt.
    runGatedLanScan(makeGateOptions(root, { systemMessageRouter: router, startDiscovery: discovery.fn }));
    runGatedLanScan(makeGateOptions(root, { systemMessageRouter: router, startDiscovery: discovery.fn }));

    expect(discovery.calls).toBe(2);
    expect(low.filter((m) => m.includes('off by default'))).toHaveLength(0);
    expect(low.filter((m) => m.includes('Discovered'))).toHaveLength(2);
  });

  test('consenting -> framed summary output only, no raw host:port spew, detail deferred to /provider', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    saveLanScanConsent(shellPaths, SURFACE_ROOT, 'granted');

    const discovery = fakeDiscovery((opts) => {
      // Mimics the SDK's real per-server raw emit shape verbatim (bootstrap-background.js).
      opts.systemMessageRouter.low('[Local] Ollama at 192.168.1.7:11434 (2 models) — from last session');
      opts.systemMessageRouter.low('[Scan] Found LM Studio at 10.0.0.5:1234 (3 models)');
      opts.requestRender();
    });
    const { router, low } = makeRouterSpy();

    runGatedLanScan(makeGateOptions(root, { systemMessageRouter: router, startDiscovery: discovery.fn }));

    expect(low).toHaveLength(1);
    expect(low[0]).toContain('Discovered 2 local model servers');
    expect(low[0]).toContain('/provider');
    for (const message of low) {
      expect(message).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+/);
    }
  });

  test('framing aggregates a removed-server batch into one honest line, separately from a found batch', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    saveLanScanConsent(shellPaths, SURFACE_ROOT, 'granted');

    const discovery = fakeDiscovery((opts) => {
      opts.systemMessageRouter.low('[Scan] Ollama at 192.168.1.7:11434 is no longer reachable — removed');
      opts.systemMessageRouter.high('[Scan] Active model was on Ollama (192.168.1.7) — switched to openrouter:openrouter/free');
      opts.requestRender();
    });
    const { router, low, high } = makeRouterSpy();

    runGatedLanScan(makeGateOptions(root, { systemMessageRouter: router, startDiscovery: discovery.fn }));

    expect(low).toEqual(['[Scan] 1 previously found server no longer reachable, removed.']);
    expect(high).toHaveLength(1);
    expect(high[0]).toBe('[Scan] Active model was on Ollama — switched to openrouter:openrouter/free');
    expect(high[0]).not.toContain('192.168.1.7');
  });

  test('when discovery reports nothing new or removed, no summary line is emitted (matches original silent-when-empty behavior)', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    saveLanScanConsent(shellPaths, SURFACE_ROOT, 'granted');

    let renderCalls = 0;
    const discovery = fakeDiscovery((opts) => {
      opts.requestRender();
      renderCalls += 1;
    });
    const { router, low } = makeRouterSpy();

    runGatedLanScan(makeGateOptions(root, { systemMessageRouter: router, startDiscovery: discovery.fn }));

    expect(low).toEqual([]);
    expect(renderCalls).toBe(1);
  });

  test('passes runtime/configManager/providerRegistry/restoreRuntimeModel through to the discovery pass untouched', () => {
    const root = makeProjectTempDir('gv-lan-consent');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    saveLanScanConsent(shellPaths, SURFACE_ROOT, 'granted');

    const runtime = { model: 'x:y', provider: 'x' };
    const configManager = { marker: 'config' } as unknown as BackgroundProviderDiscoveryOptions['configManager'];
    const providerRegistry = { marker: 'providers' } as unknown as BackgroundProviderDiscoveryOptions['providerRegistry'];
    const restoreRuntimeModel = () => {};

    let seen: BackgroundProviderDiscoveryOptions | undefined;
    const discovery = fakeDiscovery((opts) => {
      seen = opts;
    });

    runGatedLanScan(makeGateOptions(root, {
      runtime,
      configManager,
      providerRegistry,
      restoreRuntimeModel,
      startDiscovery: discovery.fn,
    }));

    expect(seen?.runtime).toBe(runtime);
    expect(seen?.configManager).toBe(configManager);
    expect(seen?.providerRegistry).toBe(providerRegistry);
    expect(seen?.restoreRuntimeModel).toBe(restoreRuntimeModel);
  });
});
