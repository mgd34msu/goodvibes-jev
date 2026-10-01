/**
 * A best-of-N attempt group in the Work view's detail pane: the candidates as
 * rows (state, files changed, cost when priced) and, once the group is ready,
 * "Compare and pick" as the one primary action. The comparison itself (diffs
 * side by side, the model judge as a proposal only, the confirmed pick) is the
 * existing AttemptComparison dialog.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { FleetAttemptGroup } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { DetailPane, DetailSection, Facts } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { Row, RowList } from '../../components/ui/Row';
import { StatusDot } from '../../components/ui/StatusDot';
import { AttemptComparison } from '../fleet/AttemptComparison';

function candidateState(state: string): { word: string; tone: 'ok' | 'warn' | 'bad' | 'live' | 'idle' } {
  if (state === 'held-merge') return { word: 'Ready to merge', tone: 'ok' };
  if (state === 'failed') return { word: 'Failed', tone: 'bad' };
  if (state === 'running' || state === 'in-progress') return { word: 'Running', tone: 'live' };
  return { word: state || 'Unknown', tone: 'idle' };
}

export function AttemptGroupDetail({ group, onClose }: { group: FleetAttemptGroup; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [comparing, setComparing] = useState(false);
  const held = group.candidates.filter((c) => c.state === 'held-merge').length;

  return (
    <DetailPane
      title={group.ready ? `Pick a winner: ${group.sourceTitle || group.groupId}` : `Best of ${group.candidates.length}: ${group.sourceTitle || group.groupId}`}
      status={(
        <span className="work-status">
          <StatusDot tone={group.ready ? 'warn' : 'live'} />
          {group.ready ? 'Ready: compare and pick' : 'Waiting for attempts'}
        </span>
      )}
      meta={`${held} of ${group.candidates.length} held${group.judgment ? ' · judge ready' : ''}`}
      onClose={onClose}
      closeLabel="Close attempts"
      footer={group.ready ? (
        <Button variant="primary" onClick={() => setComparing(true)}>Compare and pick</Button>
      ) : undefined}
    >
      <p className="work-prose">
        Each attempt ran in its own worktree. Picking a winner merges it and cleans up the other worktrees.
      </p>
      <DetailSection title="Attempts">
        <RowList aria-label="Attempts">
          {group.candidates.map((candidate) => {
            const state = candidateState(candidate.state);
            const cost = candidate.usage.costState !== 'unpriced' && candidate.usage.costUsd != null
              ? `${candidate.usage.costState === 'estimated' ? '~' : ''}$${candidate.usage.costUsd.toFixed(2)}`
              : undefined;
            return (
              <Row
                key={candidate.itemId}
                leading={<StatusDot tone={state.tone} />}
                title={candidate.title || `Attempt ${candidate.attemptIndex + 1}`}
                meta={[state.word, candidate.branch, candidate.diff ? `${candidate.diff.files.length} file${candidate.diff.files.length === 1 ? '' : 's'}` : '', candidate.failureReason ?? '']
                  .filter(Boolean).join(' · ')}
                trailing={cost ? <span className="dv-value">{cost}</span> : undefined}
              />
            );
          })}
        </RowList>
      </DetailSection>
      {group.judgment && (
        <Facts items={[{ label: 'Judge proposes', value: group.candidates.find((c) => c.itemId === group.judgment?.proposedWinnerItemId)?.title ?? group.judgment.proposedWinnerItemId ?? '' }]} />
      )}
      {comparing && (
        <AttemptComparison
          open
          group={group}
          onClose={() => setComparing(false)}
          onPicked={() => { void queryClient.invalidateQueries({ queryKey: queryKeys.fleet }); }}
        />
      )}
    </DetailPane>
  );
}
