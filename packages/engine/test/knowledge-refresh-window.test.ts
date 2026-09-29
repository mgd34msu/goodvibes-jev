/**
 * One refresh-window table decides when a knowledge source is due for a
 * recrawl (knowledge/shared.ts): by connector id when the table names it,
 * otherwise by the source's type. Lint, consolidation and ingest used to carry
 * their own copies keyed by connector id only, so a history source from the
 * browser-local connector was flagged against 14 days and reported as 30.
 */
import { describe, expect, test } from 'bun:test';
import { DAY_MS, getSourceRefreshWindowMs } from '../sdk/src/platform/knowledge/shared.ts';
import { lintKnowledgeStore, type KnowledgeLintContext } from '../sdk/src/platform/knowledge/lint.ts';
import type { KnowledgeSourceRecord } from '../sdk/src/platform/knowledge/types.ts';

const historySource = {
  id: 'src-1',
  connectorId: 'browser-local',
  sourceType: 'history',
  status: 'indexed',
  title: 'Visited page',
  summary: 'A page from browser history',
  canonicalUri: 'https://example.test/page',
  lastCrawledAt: Date.now() - 20 * DAY_MS,
} as unknown as KnowledgeSourceRecord;

describe('knowledge source refresh window', () => {
  test('a connector the table does not name falls through to the source type', () => {
    expect(getSourceRefreshWindowMs({ connectorId: 'browser-local', sourceType: 'history' })).toBe(14 * DAY_MS);
    expect(getSourceRefreshWindowMs({ connectorId: 'url-list', sourceType: 'url' })).toBe(7 * DAY_MS);
    expect(getSourceRefreshWindowMs({ connectorId: 'homeassistant', sourceType: 'other' })).toBe(30 * DAY_MS);
  });

  test('lint reports the same window it checked against', async () => {
    // Only the members lint reads are supplied.
    const context = {
      store: {
        init: async () => {},
        listSources: () => [historySource],
        listEdges: () => [],
        getExtractionBySourceId: () => ({ id: 'x', sections: ['a'], summary: 'b' }),
        listNodes: () => [],
        listIssues: () => [],
        upsertIssue: async () => {},
        replaceIssues: async (issues: unknown) => issues,
      },
      emitIfReady: () => {},
    } as unknown as KnowledgeLintContext;
    const issues = await lintKnowledgeStore(context);
    const stale = issues.find((issue) => issue.code === 'stale-source');
    expect(stale?.message).toContain('14-day refresh window');
  });
});
