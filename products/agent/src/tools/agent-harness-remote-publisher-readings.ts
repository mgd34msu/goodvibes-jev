import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult } from '@goodvibes-jev/engine/sdk/platform/gate';
import { remotePublisherOutcomeKind, remotePublisherSchemaStatus } from '@goodvibes-jev/engine/sdk/platform/routing';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { personalOpsEntry } from './agent-harness-personal-ops-source.ts';

export async function readRemotePublisherSchemaStatus(source: unknown, options: CatalogRankingOptions): Promise<'certified' | 'legacy'> {
  return withModelReadingSource(source, options, async (captured, current) => {
    const site = 'agent.remote-publisher.schema-status';
    const authority = captureJudgmentPort(site, {
      signal: current.signal, assertCurrent: current.assertCurrent, prepareResultCapture: prepareJudgmentResult,
    });
    try {
      const run = await remotePublisherSchemaStatus.run(authority.port, personalOpsEntry(captured), {
        site, signal: authority.signal, beforeAttempt: authority.assertCurrent,
      });
      authority.assertCurrent();
      run.recordAction('read-only remote publisher schema-status interpretation');
      const reading = run.readings.certified_schema;
      if (reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new ToolInputProjectionError('held');
      return reading.verdict === 'yes' ? 'certified' : 'legacy';
    } finally {
      const restriction = authority.consumeObservation();
      current.retainCurrent?.(restriction.assertCurrent, site);
      restriction.assertCurrent();
    }
  });
}

export async function readRemotePublisherOutcomeKind(source: unknown, options: CatalogRankingOptions): Promise<'capture' | 'export' | 'closeout' | 'artifact' | 'other'> {
  return withModelReadingSource(source, options, async (captured, current) => {
    const site = 'agent.remote-publisher.outcome-kind';
    const authority = captureJudgmentPort(site, {
      signal: current.signal, assertCurrent: current.assertCurrent, prepareResultCapture: prepareJudgmentResult,
    });
    try {
      const run = await remotePublisherOutcomeKind.run(authority.port, personalOpsEntry(captured), {
        site, signal: authority.signal, beforeAttempt: authority.assertCurrent,
      });
      authority.assertCurrent();
      run.recordAction('read-only remote publisher outcome operation interpretation');
      if (run.readings.outcome_kind.outcome !== 'act') throw new ToolInputProjectionError('held');
      return run.readings.outcome_kind.choice;
    } finally {
      const restriction = authority.consumeObservation();
      current.retainCurrent?.(restriction.assertCurrent, site);
      restriction.assertCurrent();
    }
  });
}
