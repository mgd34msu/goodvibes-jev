import { describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import {
  DRIVER_VERSION,
  driverSearchDirectories,
  managedDriverRoot,
} from '../sdk/src/platform/browser/browser-provision-io.js';
import { browserHostScriptPath } from '../sdk/src/platform/browser/browser-host-client.js';
import {
  browserProfileRoot,
  browserScreenshotRoot,
} from '../sdk/src/platform/browser/browser-sessions.js';
import { withTestTimeout } from './_helpers/test-timeout.js';

// The old sdk package's manifest is the engine manifest, packages/engine/package.json.
const sdkPackageDir = join(import.meta.dir, '..');

describe('driver resolution for a compiled binary', () => {
  /**
   * A compiled binary has no node_modules and no package.json, so it cannot
   * look up which driver it needs. The version is a constant in the source, and
   * this keeps it honest against the dependency the package actually declares.
   *
   * The agent asserted this against its own package.json. The SDK is where the
   * dependency now lives, so the SDK's manifest is what it must agree with,
   * and it is declared optional, alongside every other heavy runtime the SDK
   * loads only when a capability is used.
   */
  test('the pinned driver version matches the declared dependency', () => {
    const manifest = JSON.parse(readFileSync(join(sdkPackageDir, 'package.json'), 'utf8')) as {
      readonly optionalDependencies?: Record<string, string>;
    };
    expect(manifest.optionalDependencies?.['playwright-core']).toBe(DRIVER_VERSION);
  });

  test('the search looks beside the executable before anywhere else', () => {
    const directories = driverSearchDirectories({ surfaceRoot: 'test-surface', homeDirectory: '/home/someone' });
    const executableDirectory = dirname(process.execPath);
    expect(directories[0]).toBe(join(executableDirectory, 'playwright-core'));
    expect(directories).toContain(join(executableDirectory, 'vendor', 'playwright-core'));
  });

  test('the search includes the surface-owned driver directory', () => {
    const directories = driverSearchDirectories({ surfaceRoot: 'test-surface', homeDirectory: '/home/someone' });
    expect(directories).toContain(join(managedDriverRoot('/home/someone', 'test-surface'), 'node_modules', 'playwright-core'));
  });

  test('an explicit override is searched first', () => {
    const previous = process.env.GOODVIBES_PLAYWRIGHT_CORE;
    process.env.GOODVIBES_PLAYWRIGHT_CORE = '/opt/driver';
    try {
      expect(driverSearchDirectories({ surfaceRoot: 'test-surface', homeDirectory: '/home/someone' })[0]).toBe('/opt/driver');
    } finally {
      if (previous === undefined) delete process.env.GOODVIBES_PLAYWRIGHT_CORE;
      else process.env.GOODVIBES_PLAYWRIGHT_CORE = previous;
    }
  });

  test('the managed driver directory sits under the surface storage root', () => {
    expect(managedDriverRoot('/home/someone', 'agent')).toBe('/home/someone/.goodvibes/agent/browser/driver');
    // And a different surface on the same machine gets its own, rather than
    // reaching into another product's storage.
    expect(managedDriverRoot('/home/someone', 'daemon')).toBe('/home/someone/.goodvibes/daemon/browser/driver');
  });
});

describe('surface-owned browser storage', () => {
  test('profiles and screenshots live under the surface-scoped storage root', () => {
    expect(browserProfileRoot('/home/someone', 'agent')).toBe('/home/someone/.goodvibes/agent/browser/profiles');
    expect(browserScreenshotRoot('/home/someone', 'agent')).toBe('/home/someone/.goodvibes/agent/browser/screenshots');
  });

  test('neither writes into the user\'s project directory', () => {
    for (const path of [browserProfileRoot('/home/someone', 'agent'), browserScreenshotRoot('/home/someone', 'agent')]) {
      expect(path.startsWith('/home/someone/.goodvibes/')).toBe(true);
    }
  });

  test('two surfaces never share a browser profile directory', () => {
    expect(browserProfileRoot('/home/someone', 'agent')).not.toBe(browserProfileRoot('/home/someone', 'daemon'));
  });
});

describe('the node-hosted browser host', () => {
  test('its script ships with the source and is found on disk', () => {
    const path = browserHostScriptPath();
    expect(readFileSync(path).byteLength).toBeGreaterThan(0);
  });

  test('releasing an attached browser drops host state without closing the browser, context, or pages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'browser-host-ownership-'));
    const scriptPath = join(root, 'browser-host.mjs');
    const callsPath = join(root, 'calls.jsonl');
    let child: ChildProcessWithoutNullStreams | undefined;
    let exited: Promise<unknown> = Promise.resolve();
    let stderr = '';
    try {
      copyFileSync(browserHostScriptPath(), scriptPath);
      const driver = join(root, 'node_modules/playwright-core');
      mkdirSync(driver, { recursive: true });
      writeFileSync(callsPath, '');
      writeFileSync(join(driver, 'index.js'), `
        const { appendFileSync } = require('node:fs');
        const record = (call) => appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(call) + '\\n');
        const page = { on() {}, url: () => 'https://fixture.invalid/', title: async () => 'Existing page', close: async () => record('page.close') };
        const context = { pages: () => [page], on() {}, close: async () => record('context.close') };
        const browser = { contexts: () => [context], close: async () => record('browser.close') };
        exports.chromium = { connectOverCDP: async (endpoint) => { record({ attach: endpoint }); return browser; } };
      `);
      child = spawn('node', [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8_192); });
      exited = once(child, 'exit').catch((error) => { stderr += String(error); });
      const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      const readReply = async () => {
        try {
          const line = await withTestTimeout(lines.next(), 5_000, 'Browser host did not reply');
          expect(line.done, stderr).not.toBe(true);
          return JSON.parse(line.value!) as { id: number; ok: boolean; result?: unknown; error?: string };
        } catch (error) {
          throw new Error(`${String(error)}; browser host stderr: ${stderr}`);
        }
      };
      expect(await readReply()).toMatchObject({ id: 0, ok: true, result: { ready: true } });
      let nextId = 1;
      const call = async (command: string, params = {}) => {
        const id = nextId++;
        child!.stdin.write(`${JSON.stringify({ id, command, params })}\n`);
        const reply = await readReply();
        expect(reply.id).toBe(id);
        return reply;
      };
      expect(await call('attach', { endpoint: 'http://127.0.0.1:9222' })).toMatchObject({ ok: true });
      expect((await call('pages')).result).toEqual({
        pages: [{ pageId: 'hp1', url: 'https://fixture.invalid/', title: 'Existing page' }],
      });
      expect(await call('release')).toMatchObject({ ok: true, result: { released: true } });
      expect((await call('pages')).result).toEqual({ pages: [] });
      expect(await call('newPage')).toMatchObject({ ok: false, error: 'not attached' });
      expect(readFileSync(callsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([
        { attach: 'http://127.0.0.1:9222' },
      ]);
    } finally {
      try {
        child?.stdin.end();
        child?.kill('SIGTERM');
        try {
          await withTestTimeout(exited, 5_000, 'Browser host did not exit after SIGTERM');
        } catch {
          child?.kill('SIGKILL');
          await withTestTimeout(exited, 5_000, 'Browser host did not exit after SIGKILL');
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 60_000);

  /**
   * The agent asserted the script sat beside `dist/goodvibes-agent`. The SDK
   * equivalent was that the published package carried it. The engine is not
   * published: it runs from source, and tsc emits only what it compiles, so
   * the hand-written .mjs never reaches dist. What must hold is that the
   * compiled client still finds the script, or every attach from compiled
   * output would fail.
   */
  test('the compiled client finds the host script', async () => {
    const compiled = await import('../sdk/dist/platform/browser/browser-host-client.js') as {
      readonly browserHostScriptPath: () => string;
    };
    const path = compiled.browserHostScriptPath();
    expect(readFileSync(path)).toEqual(readFileSync(browserHostScriptPath()));
  });
});
