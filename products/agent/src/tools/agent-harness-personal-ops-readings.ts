import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult, sideEffect } from '@goodvibes-jev/engine/sdk/platform/gate';
import { personalOpsSampleField, personalOpsToolLane, personalOpsReceiptStatus, personalOpsResultField } from '@goodvibes-jev/engine/sdk/platform/routing';
import { booleanValue, ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { personalOpsEntry, personalOpsJson } from './agent-harness-personal-ops-source.ts';

export type DiscoveryLane = 'inbox' | 'calendar' | 'tasks' | 'reminders' | 'approvals' | 'automation' | 'schedules';

export async function personalOpsLaneMembers<T>(entries: readonly T[], lane: DiscoveryLane, describe: (entry: T) => {
  readonly id: string; readonly description: string; readonly evidence: unknown;
}, options: CatalogRankingOptions): Promise<readonly T[]> {
  if (!entries.length) return [];
  const result = await rankHarnessCatalog(entries, lane, describe, `agent.personal-ops.lane-member:${lane}`,
    { ...options, requirePreservedSource: true }, 'agent.personal-ops.lane-member');
  if (result.judgments.some(({ reading }) => reading.outcome !== 'act' || reading.verdict === 'uncertain'))
    throw new ToolInputProjectionError('held');
  return result.matches.filter(({ judgment }) => judgment.reading.outcome === 'act' && judgment.reading.verdict === 'yes').map(({ entry }) => entry);
}

export interface PersonalOpsToolContract {
  readonly server: string;
  readonly tool: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export async function readPersonalOpsTool(contract: PersonalOpsToolContract, options: CatalogRankingOptions): Promise<{
  readonly lane: 'inbox' | 'calendar'; readonly effect: 'read-only' | 'confirmed-effect';
} | null> {
  return withModelReadingSource(contract, options, async (captured, current) => {
    const site = 'agent.personal-ops.tool-lane';
    const authority = captureJudgmentPort(site, { signal: current.signal, assertCurrent: current.assertCurrent, prepareResultCapture: prepareJudgmentResult });
    try {
      const lane = await personalOpsToolLane.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
      authority.assertCurrent();
      lane.recordAction('read-only connector lane classification');
      const reading = lane.readings.lane;
      if (reading.outcome !== 'act' || reading.choice === 'neither') return null;
      const effects = await sideEffect.run(authority.port, personalOpsEntry({ ...captured, arguments: {} }), {
        site: 'agent.personal-ops.tool-effect', only: ['mutates', 'outward', 'secrets'], signal: authority.signal, beforeAttempt: authority.assertCurrent,
      });
      authority.assertCurrent(); effects.recordAction('read-only connector effect classification');
      const { mutates, outward, secrets } = effects.readings;
      if (!mutates || !outward || !secrets || mutates.outcome !== 'act' || outward.outcome !== 'act' || secrets.outcome !== 'act'
        || secrets.verdict !== 'no') return null;
      return { lane: reading.choice, effect: mutates.verdict === 'yes' || outward.verdict === 'yes' ? 'confirmed-effect' : 'read-only' };
    } finally {
      const restriction = authority.consumeObservation(); current.retainCurrent?.(restriction.assertCurrent, site);
      restriction.assertCurrent();
    }
  });
}

export async function readPersonalOpsSampleField(source: {
  readonly field: string; readonly lane: 'inbox' | 'calendar'; readonly effect: 'read-only' | 'confirmed-effect';
  readonly contract: PersonalOpsToolContract; readonly inputSchema: unknown;
}, options: CatalogRankingOptions): Promise<unknown> {
  return withModelReadingSource(source, options, async (captured, current) => {
    const site = 'agent.personal-ops.sample-field';
    const authority = captureJudgmentPort(site, { signal: current.signal, assertCurrent: current.assertCurrent, prepareResultCapture: prepareJudgmentResult });
    try {
      const run = await personalOpsSampleField.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
      authority.assertCurrent(); run.recordAction('read-only schema placeholder classification');
      const role = run.readings.role;
      if (role.outcome !== 'act') throw new ToolInputProjectionError('held');
      const calendar = captured.lane === 'calendar';
      switch (role.choice) {
        case 'count': return 10;
        case 'preview': return captured.effect === 'confirmed-effect';
        case 'include': return true;
        case 'start': return calendar ? '<start-iso>' : '<since>';
        case 'end': return calendar ? '<end-iso>' : '<until>';
        case 'record': return calendar ? '<event-id>' : '<message-or-thread-id>';
        case 'calendar': return '<calendar-or-event-id>';
        case 'query': return calendar ? 'today' : 'is:unread newer_than:7d';
        case 'mailbox': return calendar ? '<calendar-name>' : '<mailbox-or-label>';
        case 'account': return '<account-or-calendar>';
        case 'subject': return '<reviewed subject>';
        case 'body': return '<reviewed draft text>';
        case 'attendees': return ['<attendee@example.com>'];
        case 'other': return `<${captured.field}>`;
      }
    } finally {
      const restriction = authority.consumeObservation(); current.retainCurrent?.(restriction.assertCurrent, site);
      restriction.assertCurrent();
    }
  });
}

export async function readPersonalOpsBoolean(source: {
  readonly parameter: string; readonly value: unknown; readonly record: unknown;
}, options: CatalogRankingOptions): Promise<boolean | null> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  if (typeof source.value === 'boolean') return source.value;
  if (source.value === 'true' || source.value === 'false') return source.value === 'true';
  if (typeof source.value !== 'string') return null;
  return withModelReadingSource(source, options, async (captured, current) => {
    const site = 'agent.personal-ops.provider-boolean';
    const authority = captureJudgmentPort(site, { signal: current.signal, assertCurrent: current.assertCurrent, prepareResultCapture: prepareJudgmentResult });
    try {
      const run = await booleanValue.run(authority.port, personalOpsEntry({ ...captured, tool: 'provider published personal-ops record',
        description: 'The named boolean flag on the complete provider record; read its meaning in the record context.',
      }), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
      authority.assertCurrent(); run.recordAction('read-only provider boolean classification');
      const reading = run.readings.boolean_value;
      if (reading.outcome !== 'act' || reading.choice === 'neither') return null;
      return reading.choice === 'true';
    } finally {
      const restriction = authority.consumeObservation(); current.retainCurrent?.(restriction.assertCurrent, site); restriction.assertCurrent();
    }
  });
}

export async function readPersonalOpsReceiptStatus(source: unknown, options: CatalogRankingOptions): Promise<string> {
  return withModelReadingSource(source, options, async (captured, current) => {
    const site = 'agent.personal-ops.receipt-status';
    const authority = captureJudgmentPort(site, { signal: current.signal, assertCurrent: current.assertCurrent, prepareResultCapture: prepareJudgmentResult });
    try {
      const run = await personalOpsReceiptStatus.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
      authority.assertCurrent(); run.recordAction('read-only published effect receipt classification');
      if (run.readings.status.outcome !== 'act') throw new ToolInputProjectionError('held');
      return run.readings.status.choice;
    } finally {
      const restriction = authority.consumeObservation(); current.retainCurrent?.(restriction.assertCurrent, site); restriction.assertCurrent();
    }
  });
}

export async function readPersonalOpsResultField(source: Readonly<Record<string, unknown>>, purpose: string, options: CatalogRankingOptions): Promise<string | null> {
  return withModelReadingSource({ source, purpose }, options, async (captured, current) => {
    const keys = Object.keys(captured.source);
    if (!keys.length) return null;
    const site = 'agent.personal-ops.result-field';
    const authority = captureJudgmentPort(site, { signal: current.signal, assertCurrent: current.assertCurrent, prepareResultCapture: prepareJudgmentResult });
    try {
      const run = await personalOpsResultField.select(authority.port, personalOpsEntry(captured), keys.map((key, index) => ({
        id: String(index), content: personalOpsJson({ key, value: captured.source[key] }),
      })), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
      authority.assertCurrent(); run.recordAction('read-only provider result field selection');
      if (run.outcome !== 'act') throw new ToolInputProjectionError('held');
      if (run.chosen === undefined) return null;
      const key = keys[Number(run.chosen)];
      if (key === undefined || String(Number(run.chosen)) !== run.chosen) throw new ToolInputProjectionError('held');
      return key;
    } finally {
      const restriction = authority.consumeObservation(); current.retainCurrent?.(restriction.assertCurrent, site); restriction.assertCurrent();
    }
  });
}
