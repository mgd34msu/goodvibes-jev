import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { gateJudgmentRegistry, prepareJudgmentResult } from '@goodvibes-jev/engine/sdk/platform/gate';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { JudgmentPort, NamedDecision } from '@goodvibes-jev/judgment/decisions';
import { captureCatalogData, captureCatalogMethods, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';

interface CanonicalDefinition extends NamedDecision {
  readonly items: unknown;
}

/** The input is already protected by the caller's withModelReadingSource scope. */
export async function withCanonicalReading<T>(site: string, definitions: readonly CanonicalDefinition[], options: CatalogRankingOptions,
  read: (port: JudgmentPort, assertCurrent: () => void, signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
  const registrySlots = captureCatalogMethods(gateJudgmentRegistry, ['get']);
  const guards = definitions.map(definition => {
    const slots = captureCatalogMethods(definition, ['name', 'version', 'description', 'accuracyFloor', 'model', 'items', 'fixtureCount', 'run', 'checkFixtures']);
    const metadata = () => captureCatalogData({ name: definition.name, version: definition.version, description: definition.description,
      accuracyFloor: definition.accuracyFloor, model: definition.model, items: definition.items, fixtureCount: definition.fixtureCount });
    const revision = JSON.stringify(metadata());
    return () => {
      slots();
      if (gateJudgmentRegistry.get(definition.name) !== definition || JSON.stringify(metadata()) !== revision)
        throw new ToolInputProjectionError('held');
    };
  });
  const assertDefinitionCurrent = () => { registrySlots(); for (const guard of guards) guard(); };
  options.retainCurrent?.(assertDefinitionCurrent, `${site}.definition`);
  const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); assertDefinitionCurrent(); };
  assertCurrent();
  const authority = captureJudgmentPort(site, { signal: options.signal, assertCurrent, prepareResultCapture: prepareJudgmentResult });
  try {
    const result = await read(authority.port, authority.assertCurrent, authority.signal);
    authority.assertCurrent();
    return result;
  } finally {
    const restriction = authority.consumeObservation();
    options.retainCurrent?.(restriction.assertCurrent, site);
    restriction.assertCurrent();
  }
}
