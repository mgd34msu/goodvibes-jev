import '../../../toolchain/src/test-runner/test-network-preload.js';
import { spyOn } from 'bun:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../../sdk/src/platform/config/index.js';
import { createClientRuntimeServices } from '../../../sdk/src/platform/runtime/bootstrap.js';
import { createRuntimeStore, RuntimeEventBus } from '../../../sdk/src/platform/runtime/state.js';
import { createLaunchTolerantProviderRegistry } from '../../../sdk/src/platform/providers/index.js';
import { installJudgmentPort } from '../../../errors/src/index.js';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

// Run by the parent test in a new process: no receipt, lease or captured-root
// registration is carried across this boundary.
const [root, view, alias] = process.argv.slice(2);
assert(root && view && alias);
const config = new ConfigManager({
  surfaceRoot: 'agent',
  configDir: join(root, '.goodvibes', 'restart-cfg'),
  workingDir: root,
  homeDir: root,
});
config.set('permissions.engine', 'policy-engine');
config.set('permissions.mode', 'prompt');
config.set('behavior.autoApprove', false);
const runtime = createClientRuntimeServices({
  surfaceRoot: 'agent',
  configManager: config,
  workingDir: root,
  homeDirectory: root,
  runtimeBus: new RuntimeEventBus(),
  runtimeStore: createRuntimeStore(),
  modelDiscovery: 'skip',
  providerRegistryFactory: createLaunchTolerantProviderRegistry,
  requestApproval: async () => ({ approved: true }),
});
const previous = installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);

await runtime.userPermissionRuleStore.add({
  rule: {
    id: 'deny-original-private',
    type: 'path-scope',
    origin: 'user',
    effect: 'deny',
    toolPattern: 'read',
    pathPatterns: [join(root, 'private.ts')],
  },
  createdAt: Date.now(),
  tier: 'path',
  tool: 'read',
});
const requests: string[] = [];
const opened: string[] = [];
const syncOpened: string[] = [];
const originalRead = fs.readFileSync;
const readTap = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
  opened.push(String(args[0]));
  syncOpened.push(String(args[0]));
  return originalRead(...args);
}) as typeof fs.readFileSync);
const originalFile = Bun.file;
Bun.file = ((...args: Parameters<typeof Bun.file>) => {
  opened.push(String(args[0]));
  return originalFile(...args);
}) as typeof Bun.file;
const steps = [
  {
    id: 'retained',
    name: 'read',
    arguments: { files: [{ path: join(view, 'private.ts') }] },
  },
  {
    id: 'alias',
    name: 'read',
    arguments: { files: [{ path: join(alias, 'private.ts') }] },
  },
  {
    id: 'allowed',
    name: 'read',
    arguments: { files: [{ path: 'allowed.ts' }] },
  },
];
let calls = 0;
runtime.providerRegistry.registerRuntimeProvider({
  provider: {
    name: 'retained-fixture',
    models: ['fixture'],
    isConfigured: () => true,
    async chat(...input: unknown[]) {
      requests.push(JSON.stringify(input));
      const step = steps[calls++];
      return {
        content: step ? '' : 'done',
        toolCalls: step ? [step] : [],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: step ? 'tool_call' : 'completed',
      };
    },
  },
  models: [
    {
      id: 'fixture',
      provider: 'retained-fixture',
      registryKey: 'retained-fixture:fixture',
      displayName: 'Fixture',
      description: 'Synthetic',
      capabilities: {
        toolCalling: true,
        codeEditing: false,
        reasoning: false,
        multimodal: false,
      },
      contextWindow: 4096,
      selectable: true,
      tier: 'standard',
    },
  ],
  replace: true,
});
await runtime.providerRegistry.ready();
let finish!: () => void;
const settled = new Promise<void>((resolve) => {
  finish = resolve;
});
let failure: unknown;
runtime.agentManager.setExecutor({
  async runAgent(record) {
    try {
      await runtime.agentOrchestrator.runAgent(record);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      finish();
    }
  },
});
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  runtime.agentManager.spawn({
    mode: 'spawn',
    outsideContract: true,
    template: 'planner',
    task: 'Read the synthetic fixture paths',
    tools: ['read'],
    restrictTools: true,
    workingDirectory: root,
    model: 'retained-fixture:fixture',
    provider: 'retained-fixture',
    executionIntent: {
      filesystemPolicy: 'read-only',
      networkPolicy: 'deny',
      riskClass: 'safe',
    },
  });
  await Promise.race([
    settled,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('reader did not settle')), 10_000);
    }),
  ]);
  assert.equal(failure, undefined);
  assert.equal(calls, 4);
  assert(!opened.includes(join(view, 'private.ts')));
  assert(!opened.includes(join(alias, 'private.ts')));
  assert(syncOpened.includes(join(root, 'allowed.ts')));
  assert.equal(syncOpened.filter((path) => path === join(view, 'private.ts')).length, 0);
  assert.equal(syncOpened.filter((path) => path === join(alias, 'private.ts')).length, 0);
  assert(!requests.some((request) => request.includes('SYNTHETIC_PRIVATE_MARKER')));
  assert(
    requests.some((request) => request.includes('SYNTHETIC_ALLOWED_MARKER')),
    JSON.stringify({ opened, last: requests.at(-1) }),
  );
  console.log('retained-reader: denied bytes unopened; ordinary allowed content delivered');
} finally {
  if (timer) clearTimeout(timer);
  Bun.file = originalFile;
  readTap.mockRestore();
  runtime.dispose();
  installJudgmentPort(previous);
}
