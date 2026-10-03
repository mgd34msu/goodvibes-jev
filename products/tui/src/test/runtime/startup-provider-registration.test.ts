import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DiscoveredServer } from '@goodvibes-jev/engine/sdk/platform/discovery';
import type { BackgroundProviderDiscoveryOptions } from '@goodvibes-jev/engine/sdk/platform/runtime/bootstrap';
import { registerStartupProviders } from '../../runtime/startup-provider-registration.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function fixture(cache?: unknown) {
  const home = makeProjectTempDir('startup-provider-registration-');
  const dir = join(home, '.goodvibes', 'tui');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'discovered-providers.json');
  if (cache !== undefined) writeFileSync(path, JSON.stringify(cache));
  const registered: DiscoveredServer[][] = [];
  const restored: string[] = [];
  const messages: string[] = [];
  let renders = 0;
  const runtime = { model: 'saved:local-model', provider: 'saved' };
  const options = {
    configManager: {
      get: (key: string) => { expect(key).toBe('provider.model'); return runtime.model; },
    },
    providerRegistry: {
      has: () => true,
      register: () => { throw new Error('already registered'); },
      registerDiscoveredProviders: (servers: DiscoveredServer[]) => { registered.push(servers); },
    },
    runtime,
    requestRender: () => { renders++; },
    restoreRuntimeModel: (_registry: unknown, model: string) => { restored.push(model); },
    systemMessageRouter: {
      low: (message: string) => { messages.push(message); },
      high: () => { throw new Error('startup must not announce a scan or fallback'); },
    },
    shellPaths: { homeDirectory: home, workingDirectory: home },
    surfaceRoot: 'tui',
  } as unknown as BackgroundProviderDiscoveryOptions;
  return { options, path, registered, restored, messages, runtime, renders: () => renders };
}

const SERVER: DiscoveredServer = {
  name: 'Saved local model', host: '192.0.2.42', port: 11434,
  baseURL: 'http://192.0.2.42:11434/v1', models: ['local-model'], serverType: 'ollama',
};

describe('TUI startup provider registration', () => {
  test('a fresh home does not start discovery or schedule network work', async () => {
    const f = fixture();
    const original = globalThis.fetch;
    const requests: unknown[] = [];
    globalThis.fetch = Object.assign(async (input: unknown) => {
      requests.push(input);
      throw new Error('startup must not fetch');
    }, { preconnect: original.preconnect }) as typeof fetch;
    try {
      registerStartupProviders(f.options);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(requests).toEqual([]);
      expect(f.registered).toEqual([]);
      expect(f.restored).toEqual([]);
      expect(f.messages).toEqual([]);
      expect(f.renders()).toBe(0);
    } finally { globalThis.fetch = original; }
  });

  test('restores cached LAN providers without revalidation, pruning, or model fallback', () => {
    const f = fixture([SERVER]);
    const before = readFileSync(f.path, 'utf8');
    registerStartupProviders(f.options);
    expect(f.registered).toEqual([[SERVER]]);
    expect(f.restored).toEqual(['saved:local-model']);
    expect(f.runtime).toEqual({ model: 'saved:local-model', provider: 'saved' });
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(f.messages).toEqual(['[Local] Saved local model at 192.0.2.42:11434 (1 model), from last session']);
    expect(f.renders()).toBe(1);
  });

  test('still registers an explicitly configured provider without discovering hosts', () => {
    const f = fixture();
    const before = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = 'synthetic-startup-test-key';
    const names: string[] = [];
    f.options.providerRegistry.has = (name) => name !== 'groq';
    f.options.providerRegistry.register = (provider) => { names.push(provider.name); };
    try {
      registerStartupProviders(f.options);
      expect(names).toEqual(['groq']);
      expect(f.registered).toEqual([]);
      expect(f.runtime.model).toBe('saved:local-model');
    } finally {
      if (before === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = before;
    }
  });

  test('invalid cache and failed cached registration never trigger a fallback scan', () => {
    const malformed = fixture({ invalid: true });
    registerStartupProviders(malformed.options);
    expect(malformed.registered).toEqual([]);
    const failing = fixture([SERVER]);
    failing.options.providerRegistry.registerDiscoveredProviders = () => { throw new Error('invalid cached provider'); };
    expect(() => registerStartupProviders(failing.options)).not.toThrow();
    expect(failing.restored).toEqual([]);
    expect(failing.runtime.model).toBe('saved:local-model');
    expect(failing.renders()).toBe(0);
    expect(JSON.parse(readFileSync(failing.path, 'utf8'))).toEqual([SERVER]);
  });

});
