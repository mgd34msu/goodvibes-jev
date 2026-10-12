import { captureAsyncHarnessInput } from './agent-harness-async-input.ts';
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { browserDeviceEvidence, gateJudgmentRegistry, prepareJudgmentResult } from '@goodvibes-jev/engine/sdk/platform/gate';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogMethods, captureCatalogSnapshot, rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { personalOpsEntry } from './agent-harness-personal-ops-source.ts';

export type BrowserDeviceEvidenceInput = {
  readonly kind: 'mobile-touch' | 'pwa-runtime';
  readonly record: unknown;
} | {
  readonly kind: 'device-capability';
  readonly record: unknown;
  readonly requestedCapability: string;
  readonly requestedTerms: readonly string[];
};

/** Read complete evidence only after the native protected owner admits it. */
export async function readBrowserDeviceEvidence(source: BrowserDeviceEvidenceInput,
  options: CatalogRankingOptions): Promise<boolean> {
  const caller = captureAsyncHarnessInput(source, options);
  caller.retainSourceCurrent();
  return withModelReadingSource(caller.args, caller.options, async (captured, current) => {
    const site = `agent.browser-device.evidence:${captured.kind}`;
    const definition = browserDeviceEvidence;
    const assertDefinition = captureCatalogMethods(definition, ['name', 'version', 'description', 'accuracyFloor', 'model', 'items', 'fixtures', 'run']);
    const policy = captureCatalogSnapshot({ name: definition.name, version: definition.version, description: definition.description, accuracyFloor: definition.accuracyFloor, model: definition.model, items: definition.items, fixtures: definition.fixtures });
    const run = definition.run;
    const assertRegistry = captureCatalogMethods(gateJudgmentRegistry, ['get']);
    const getDefinition = gateJudgmentRegistry.get;
    const assertRegistered = () => {
      assertRegistry(); assertDefinition();
      policy.assertCurrent({ name: definition.name, version: definition.version, description: definition.description, accuracyFloor: definition.accuracyFloor, model: definition.model, items: definition.items, fixtures: definition.fixtures });
      if (getDefinition.call(gateJudgmentRegistry, definition.name) !== definition) throw new ToolInputProjectionError('unavailable');
      assertRegistry(); assertDefinition();
    };
    assertRegistered();
    const authority = captureJudgmentPort(site, { signal: current.signal, assertCurrent: () => {
      current.assertCurrent?.(); assertRegistered();
    }, prepareResultCapture: prepareJudgmentResult });
    try {
      const reading = await run.call(definition, authority.port, personalOpsEntry(captured), {
        site, signal: authority.signal, beforeAttempt: authority.assertCurrent,
      });
      authority.assertCurrent(); assertRegistered();
      reading.recordAction('read-only published capability evidence interpretation');
      authority.assertCurrent(); assertRegistered();
      const answer = reading.readings.supported;
      if (answer.outcome !== 'act' || answer.verdict === 'uncertain') throw new ToolInputProjectionError('held');
      return answer.verdict === 'yes';
    } finally {
      const restriction = authority.consumeObservation();
      const retained = () => { assertRegistered(); restriction.assertCurrent(); };
      current.retainCurrent?.(retained, site);
      retained();
    }
  });
}

/** Every nonempty query reads every original candidate; unknown fits hold. */
export async function browserDeviceCatalogMatches<T>(entries: readonly T[], query: string,
  describe: (entry: T) => { readonly id: string; readonly description: string; readonly evidence: unknown },
  options: CatalogRankingOptions, site: string): Promise<readonly T[]> {
  const caller = captureAsyncHarnessInput({ entries, query }, options);
  caller.retainSourceCurrent();
  if (!caller.args.query) return withModelReadingSource(caller.args, caller.options, async (captured, current) => {
    current.assertCurrent?.(); return captured.entries;
  });
  const result = await rankHarnessCatalog(caller.args.entries, caller.args.query, describe, site, { ...caller.options, requirePreservedSource: true });
  caller.assertCurrent();
  if (result.judgments.some(({ reading }) => reading.outcome !== 'act' || reading.verdict === 'uncertain')) throw new ToolInputProjectionError('held');
  return result.matches.filter(({ judgment }) => judgment.reading.outcome === 'act' && judgment.reading.verdict === 'yes').map(({ entry }) => entry);
}
