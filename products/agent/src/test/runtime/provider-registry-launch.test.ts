import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { createRuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];
const launchToleranceEnvVars = [
  'OPENAI_API_KEY',
  'OPENAI_KEY',
  ['CLOUD', 'FLARE_AI_GATEWAY_API_KEY'].join(''),
] as const;
const originalEnvValues = new Map<string, string | undefined>(
  launchToleranceEnvVars.map((envVar) => [envVar, process.env[envVar]]),
);

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  for (const envVar of launchToleranceEnvVars) {
    const originalValue = originalEnvValues.get(envVar);
    if (originalValue === undefined) {
      delete process.env[envVar];
    } else {
      process.env[envVar] = originalValue;
    }
  }
});

function makeRoot(): string {
  const root = makeProjectTempDir('gv-agent-provider-launch');
  roots.push(root);
  return root;
}

describe('provider registry launch tolerance', () => {
  test('runtime services launch without local OpenAI credentials', () => {
    for (const envVar of launchToleranceEnvVars) {
      delete process.env[envVar];
    }

    const root = makeRoot();
    const configManager = new ConfigManager({
      surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
      workingDir: root,
      homeDir: root,
      configDir: join(root, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT),
    });
    const services = createRuntimeServices({
      // Opt out: this process does not outlive the unawaited sweep.
      modelDiscovery: 'skip',
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      configManager,
      workingDir: root,
      homeDirectory: root,
    });
    const provider = services.providerRegistry.get('openai');

    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env[['CLOUD', 'FLARE_AI_GATEWAY_API_KEY'].join('')]).toBeUndefined();
    expect(provider?.isConfigured?.()).toBe(false);
  });
});
