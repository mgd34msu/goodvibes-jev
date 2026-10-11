import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FleetAttemptGroup } from '../../lib/goodvibes';
import { AttemptGroupDetail } from './AttemptGroupDetail';

for (const selectable of [0, 1]) {
  test(`detail shows actual two-attempt size and ${selectable} selectable candidates while bookkeeping is held`, () => {
    const group = {
      groupId: 'group', sourceTitle: 'Repository work', ready: false, judgment: null, attemptCount: 2,
      selectableCandidateCount: selectable,
      candidates: selectable ? [{ itemId: 'ready', attemptIndex: 0, title: 'Ready attempt', state: 'held-merge', usage: { costState: 'unpriced', costUsd: null }, diff: null, failureReason: null }] : [],
      unresolved: Array.from({ length: 2 - selectable }, (_, index) => ({
        itemId: `held-${index}`, attemptIndex: index + selectable, title: `Held attempt ${index + 1}`,
        state: 'blocked-bookkeeping', reason: 'Original commit failed; repository condition could not be read.',
      })),
    } as unknown as FleetAttemptGroup;
    const client = new QueryClient();
    try {
      const html = renderToStaticMarkup(<QueryClientProvider client={client}><AttemptGroupDetail group={group} onClose={() => {}} /></QueryClientProvider>);
      expect(html).toContain('Best of 2: Repository work');
      expect(html).toContain(`${selectable} of 2 selectable`);
      expect(html).toContain('Held: repository condition unresolved');
      expect(html).toContain('Original commit failed; repository condition could not be read.');
      expect(html).toContain('Held attempt 1');
      expect(html).not.toContain('Best of 0');
      expect(html).not.toContain('Waiting for attempts');
      expect(html).not.toContain('Compare and pick');
    } finally { client.clear(); }
  });
}
