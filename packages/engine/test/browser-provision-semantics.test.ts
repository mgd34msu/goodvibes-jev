import { createBrowserProvisionIo } from '../sdk/src/platform/browser/browser-provision-io.js';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bindJudgmentPortAuthority, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createBrowserGatewayHandlers, type BrowserGatewayService } from '../sdk/src/platform/control-plane/routes/browser.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { BrowserProvisionReadingError, missingLibrary, networkBlocked, programNotInstalled } from '../sdk/src/platform/browser/browser-failure-reading.js';
import { ensureBrowserBinary } from '../sdk/src/platform/browser/browser-provisioning.js';
import { BrowserSessionManager } from '../sdk/src/platform/browser/browser-sessions.js';
import { BrowserEngine } from '../sdk/src/platform/browser/browser-engine.js';
import type { BrowserProvisionIo, CommandOutcome } from '../sdk/src/platform/browser/browser-types.js';
import { tmpdir } from 'node:os';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
function canonical<T extends { port: JudgmentPort }>(fixture: T): T { installJudgmentPort(fixture.port); return fixture; }

const failed = (stderr: string, extra: Partial<CommandOutcome> = {}): CommandOutcome => ({ code: 1, stdout: '', stderr, spawnError: null, timedOut: false, ...extra });
function reading(category: string, library?: string) {
  return canonical(fakePort((name, question, state) => name === 'category' ? choiceAnswer(question, category, 0.99)
    : noulAnswer((state as { candidate: string }).candidate === library ? 0.99 : 0.01)));
}
function fakeIo() {
  const commands: string[] = [];
  const removed: string[] = [];
  const io: BrowserProvisionIo = {
    resolveDriver: () => ({ available: true, packageDirectory: '/pkg', cliPath: '/pkg/cli.js', version: '1', error: null }),
    expectedExecutablePath: () => '/cache/chromium-1/chrome', browsersPath: () => '/cache',
    pathExists: () => true, isExecutableFile: () => true, directoryWritable: () => true,
    removePath: path => { removed.push(path); }, systemBrowserCandidates: () => [], now: () => 0,
    runCommand: async (command) => { commands.push(command); return failed('The binary image is corrupt.'); },
  };
  return { io, commands, removed };
}
function deferredPort(category: string) {
  const base = reading(category).port;
  let release!: () => void;
  let began!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  const port: JudgmentPort = { ...base, async ask(request) { began(); await gate; return base.ask(request); } };
  return canonical({ port, release, started });
}

describe('browser provisioning semantic decisions', () => {
  test('grounds the selected missing library after an incidental installed library', async () => {
    const { port, requests } = reading('missing-library', 'libnew.so.2');
    expect(await missingLibrary('chrome', failed('libold.so is present. Loader cannot locate libnew.so.2.'), { port })).toBe('libnew.so.2');
    expect(requests[0]?.state).toMatchObject({ stderr: 'libold.so is present. Loader cannot locate libnew.so.2.' });
  });
  test.each(['The network is fine; the archive is corrupt.', 'Example: "proxy certificate timed out". Actual cause: disk full.'])('negated and quoted network terms follow the reading: %s', async (text) => {
    expect(await networkBlocked('bun', failed(text), reading('other'))).toBe(false);
  });
  test('network paraphrase follows the canonical reading', async () => {
    expect(await networkBlocked('bun', failed('The intermediary refuses the download tunnel.'), reading('network-blocked'))).toBe(true);
  });
  test('missing program paraphrase and negation share driver/runtime reader', async () => {
    expect(await programNotInstalled('node', failed('', { spawnError: 'No interpreter named node can be located.' }), reading('program-not-installed'))).toBe(true);
    expect(await programNotInstalled('node', failed('', { spawnError: 'ENOENT is an example; node exists but access is denied.' }), reading('other'))).toBe(false);
  });
  test('structured missing-program errno requires no semantic service', async () => {
    const { port, requests } = reading('other');
    expect(await programNotInstalled('bun', failed('', { spawnError: 'spawn failed', spawnCode: 'ENOENT' }), { port })).toBe(true);
    expect(requests).toHaveLength(0);
  });
  test('missing-library decision cannot invent a name', async () => {
    await expect(missingLibrary('chrome', failed('A required dependency is absent.'), reading('missing-library', 'invented.so'))).rejects.toBeInstanceOf(BrowserProvisionReadingError);
  });
  test('malformed or weak results cannot launch an installer', async () => {
    for (const answer of [null, { type: 'choice', choice: 'other', confidence: 0.99, probabilities: { other: 1 } }]) {
      const { io, commands, removed } = fakeIo();
      const { port } = canonical(fakePort(() => answer));
      await expect(ensureBrowserBinary(io, { port })).rejects.toBeInstanceOf(BrowserProvisionReadingError);
      expect(commands).toHaveLength(1); expect(removed).toEqual([]);
    }
  });
  test('weak judgment is not other and cannot authorize self-healing', async () => {
    const { io, commands, removed } = fakeIo();
    const { port } = canonical(fakePort((_name, question) => choiceAnswer(question, 'other', 0.5)));
    await expect(ensureBrowserBinary(io, { port })).rejects.toBeInstanceOf(BrowserProvisionReadingError);
    expect(commands).toHaveLength(1); expect(removed).toEqual([]);
  });
  test('unavailable judgment preserves a recoverable failure without deletion', async () => {
    const { io, removed } = fakeIo();
    const port: JudgmentPort = { model: 'jev-1.13.0', ask: async () => { throw new Error('unavailable'); } };
    installJudgmentPort(port);
    await expect(ensureBrowserBinary(io, { port })).rejects.toMatchObject({ recoverable: true });
    expect(removed).toEqual([]);
  });
  test('complete raw failure privacy admission precedes port access', async () => {
    const { port, requests } = reading('network-blocked');
    await expect(networkBlocked('bun', failed('x'.repeat(10_000) + '\nAuthorization: Bearer secret-browser-test-token'), { port })).rejects.toBeInstanceOf(BrowserProvisionReadingError);
    expect(requests).toHaveLength(0);
  });
  test('readonly request cannot join a downloading request on the same cache', async () => {
    const { io } = fakeIo();
    let release!: () => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writable = { ...io, pathExists: () => false, runCommand: async () => { began(); await gate; return failed('disk full'); } };
    const downloading = ensureBrowserBinary(writable, reading('other'));
    await started;
    const readonly = await ensureBrowserBinary(writable, { allowDownload: false });
    expect(readonly.ok).toBe(false); expect(readonly.steps.some(step => step.step === 'install-browser')).toBe(false);
    release(); await downloading;
  });
  test.each(['manager', 'engine', 'launch', 'gateway', 'gateway-navigate', 'gateway-tab'] as const)('%s retains owner through delayed reading', async (entry) => {
    const { io, commands, removed } = fakeIo();
    const { port, started, release } = deferredPort('other');
    let current = true;
    const manager = new BrowserSessionManager({ io, profileRoot: tmpdir(), surfaceRoot: 'semantic-test', loadDriver: () => { throw new Error('must not load driver'); } });
    const lifetime = { port, assertCurrent: () => { if (!current) throw new Error('owner replaced'); } };
    const engine = new BrowserEngine(manager, { screenshotDirectory: tmpdir(), untrusted: { rule: 'test', originOf: () => 'test', label: () => { throw new Error('unused'); }, recordIngest: () => {}, evaluateOutwardEffect: async () => ({ allowed: false, reason: null, fix: null, untrustedOrigins: [] }) } });
    const service = {
      provision: async (options) => ({ provision: await engine.provision({ ...options, port }) }),
      navigate: (target, args) => engine.navigate(target, { ...args, launch: { ...args.launch, port } }),
      newTab: (target, args) => engine.newTab(target, { ...args, launch: { ...args.launch, port } }),
    } satisfies Pick<BrowserGatewayService, 'provision' | 'navigate' | 'newTab'>;
    const handler = createBrowserGatewayHandlers(service as unknown as BrowserGatewayService).get(entry === 'gateway-navigate' ? 'browser.navigate' : entry === 'gateway-tab' ? 'browser.tabs.create' : 'browser.provision')!;
    const pending = entry === 'manager' ? manager.provision(lifetime) : entry === 'engine' ? engine.provision(lifetime) : entry === 'launch' ? manager.launch(lifetime)
      : handler({ context: { principalId: 'original-owner' }, body: { url: 'https://example.com' }, isAuthorized: () => current });
    await started; current = false; release();
    await expect(Promise.resolve(pending)).rejects.toThrow(entry.startsWith('gateway') ? 'authorization' : 'owner replaced');
    expect(commands).toHaveLength(1); expect(removed).toEqual([]); expect(manager.provisionReport()).toBeNull();
  });
  test.each(['replace', 'aba', 'same-port-source'] as const)('post-settlement %s retirement fences the actual install', async (mode) => {
    const { io, commands, removed } = fakeIo();
    const base = reading('other').port;
    let port!: JudgmentPort;
    let retired = false;
    port = { ...base, recorder: {
      recordReadings() {},
      recordAction() { queueMicrotask(() => {
        retired = true;
        if (mode === 'same-port-source') bindJudgmentPortAuthority(port, () => ({ identity: {}, assertCurrent() {} }));
        else { installJudgmentPort(reading('other').port); if (mode === 'aba') installJudgmentPort(port); }
      }); },
    }, async ask(request) { return { ...await base.ask(request), decisionId: 'browser-reading' }; } };
    installJudgmentPort(port);
    await expect(ensureBrowserBinary(io)).rejects.toThrow();
    expect(retired).toBe(true); expect(commands).toHaveLength(1); expect(removed).toEqual([]);
  });
  test('accessor-bearing raw outcomes are refused without executing getters', async () => {
    let accesses = 0;
    const outcome = { ...failed(''), get stderr() { accesses++; return 'private value'; } };
    const { port, requests } = reading('other');
    await expect(networkBlocked('bun', outcome, { port })).rejects.toThrow();
    expect(accesses).toBe(0); expect(requests).toHaveLength(0);
  });
  test('actual driver downloader cancellation cannot clean a successor staging tree or start a package manager', async () => {
    const root = mkdtempSync(join(tmpdir(), 'browser-driver-cancel-'));
    const staging = join(root, '.playwright-core-incoming');
    mkdirSync(staging); const marker = join(staging, 'successor-owned'); writeFileSync(marker, 'keep');
    const originalFetch = globalThis.fetch;
    const priorPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const controller = new AbortController();
    let release!: () => void; let began!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { began = resolve; });
    globalThis.fetch = (async () => { began(); await gate; throw new Error('download rejected'); }) as unknown as typeof fetch;
    try {
      const io = createBrowserProvisionIo({ homeDirectory: root, surfaceRoot: 'test' });
      const pending = io.installDriver!(root, { signal: controller.signal });
      await started; controller.abort(); release();
      await expect(pending).rejects.toThrow();
      expect(existsSync(marker)).toBe(true);
      expect(existsSync(join(root, 'node_modules'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      if (priorPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH; else process.env.PLAYWRIGHT_BROWSERS_PATH = priorPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('cancellation drains late reading and never starts the installer', async () => {
    const { io, commands } = fakeIo();
    const { port, started, release } = deferredPort('other');
    const controller = new AbortController();
    const pending = ensureBrowserBinary(io, { port, signal: controller.signal });
    await started; controller.abort();
    await expect(pending).rejects.toThrow();
    release(); await Promise.resolve(); expect(commands).toHaveLength(1);
  });
});
