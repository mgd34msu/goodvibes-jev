import { afterAll, afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createPermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import type { ArtifactRecord } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { createAgentSettingsTool } from '../../tools/agent-settings-tool.ts';
import { createPreferredSettingsProjector } from '../../tools/agent-settings-admission.ts';
import { createAgentModelCompareTool } from '../../tools/agent-model-compare-tool.ts';
import type { AgentModelCompareArtifactStore } from '../../tools/agent-model-compare-types.ts';
import { effectAdmissionFixture } from '../helpers/effect-admission.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(cleanupResearchScreeningFixtures);
function deferred() { let resolve: () => void = () => {}; const promise = new Promise<void>(finish => { resolve = finish; }); return { promise, resolve }; }
function fixture(beforeSettingsProjection?: () => Promise<void>) {
  const root = makeProjectTempDir('model-route-native-authority'); roots.push(root);
  const configOptions = { surfaceRoot: 'agent', homeDir: root, workingDir: root, configDir: join(root, 'config') };
  const config = new ConfigManager(configOptions);
  const owner = effectAdmissionFixture('prompt', createPermissionConfigReader(config));
  bindAgentResearchSourceOwner(owner.registry, ordinaryResearchOwner());
  const context = { platform: { configManager: config, secretsManager: null }, clients: {}, extensions: { toolRegistry: owner.registry },
    session: { runtime: { sessionId: 'synthetic-native-comparison' } } } as unknown as CommandContext;
  const commandRegistry = new CommandRegistry();
  const settings = createAgentSettingsTool({ commandContext: context, commandRegistry, toolRegistry: owner.registry });
  const projector = createPreferredSettingsProjector(context.platform, undefined, { registry: owner.registry, context });
  owner.registry.register(settings, { inputProjection: { async project(request) { await beforeSettingsProjection?.(); return projector.project(request); } } });
  const content = JSON.stringify({ schema: 'goodvibes.agent.model_compare_judgment.v1', judgmentId: 'judgment-native', comparisonId: 'comparison-native',
    winnerBlindId: 'B', reasons: 'Synthetic native route winner.', notes: '', revealIncludedInJudgment: true,
    winnerModel: { registryKey: 'synthetic:b', modelId: 'b', providerId: 'synthetic', displayName: 'Synthetic B' } });
  let record: ArtifactRecord = { id: 'judgment-native', kind: 'data', mimeType: 'application/json', sizeBytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'), createdAt: 1, acquisitionMode: 'inline-data', fetchMode: 'not-applicable',
    metadata: { purpose: 'agent-model-compare-judgment' }, contentPath: '/synthetic/judgment', metadataPath: '/synthetic/judgment-metadata' };
  let writes = 0, usage = 0;
  const store: AgentModelCompareArtifactStore = {
    get: id => id === record.id ? record : null, list: () => [record], async readContent() { return { record, buffer: Buffer.from(content) }; },
    async create(input, ownership) { ownership?.assertCurrent?.(); writes++; return { ...record, id: `receipt-${writes}`, metadata: input.metadata ?? {} }; },
  };
  const raw = createAgentModelCompareTool({ toolRegistry: owner.registry, artifactStore: store,
    modelCatalog: { listModels: () => [{ registryKey: 'synthetic:b', modelId: 'b', providerId: 'synthetic', selectable: true }], async recordModelUsage() { usage++; } },
    providerRegistry: { getForModel() { throw new Error('Route application must not invoke a provider.'); } },
    async applyModelRoute(registryKey, parentOptions, ownership) {
      const previousModel = config.get('provider.model');
      const applied = await owner.registry.executeNested('native-model-route', 'settings', { action: 'set', key: 'provider.model', value: registryKey }, parentOptions, ownership);
      if (!applied.success || JSON.parse(applied.output ?? '{}').verifiedInOwningStore !== true || config.get('provider.model') !== registryKey) {
        throw new Error('Model route transition did not verify in its owning store.');
      }
      return { previousModel, selectedModel: registryKey };
    },
  });
  return { owner, config, configOptions, tool: owner.tool(raw), replaceJudgment() { record = { ...record, metadata: { purpose: 'replaced-source' } }; },
    get writes() { return writes; }, get usage() { return usage; } };
}

test('native selected model child transition preserves exact parent authority for usage and receipt writes', async () => {
  const f = fixture(); const before = f.config.getConfigurationIncarnation();
  const result = await f.tool.execute({ mode: 'apply', artifactId: 'judgment-native' });
  expect(result.success, result.error).toBe(true);
  expect(f.config.get('provider.model')).toBe('synthetic:b');
  expect(new ConfigManager(f.configOptions).get('provider.model')).toBe('synthetic:b');
  expect(f.config.getConfigurationIncarnation()).toBeGreaterThan(before);
  expect(f.usage).toBe(1); expect(f.writes).toBe(1); expect(result.output).toContain('receipt-1');
});

test('a replaced selected judgment during actual child projection prevents native model routing', async () => {
  const entered = deferred(); const release = deferred();
  const f = fixture(async () => { entered.resolve(); await release.promise; });
  const before = f.config.get('provider.model');
  const pending = f.tool.execute({ mode: 'apply', artifactId: 'judgment-native' });
  await entered.promise; f.replaceJudgment(); release.resolve();
  expect(await pending).toMatchObject({ success: false });
  expect(f.config.get('provider.model')).toBe(before); expect(f.usage).toBe(0); expect(f.writes).toBe(0);
});
