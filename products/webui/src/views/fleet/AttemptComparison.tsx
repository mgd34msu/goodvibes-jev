/**
 * AttemptComparison, the best-of-N candidate comparison + pick surface (fleet.attempts.*).
 *
 * Opened from a ready attempt group in FleetView. Renders every candidate side by side:
 * its per-attempt diff (via the shared DiffMultibuffer from the review cockpit, read-only),
 * usage/cost, and outcome. The optional judge (fleet.attempts.judge) PROPOSES a winner with
 * reasons, shown CLEARLY LABELLED as model judgment, never an auto-pick. The operator
 * selects a held candidate and confirms; fleet.attempts.pick merges the winner and cleans
 * the losers. A not-ready/unknown group is an honest 409 CONFLICT (isConflictError), never
 * a partial merge, rendered as "no longer ready, refresh", and the fleet is revalidated.
 */
import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Trophy } from 'lucide-react';
import { sdk } from '../../lib/goodvibes';
import type { FleetAttemptGroup, FleetAttemptCandidate, FleetAttemptJudgment } from '../../lib/goodvibes';
import { formatError, isConflictError, isMethodNotInvokableError } from '../../lib/errors';
import { parseUnifiedDiff } from '../../lib/unified-diff';
import { DiffMultibuffer } from '../../components/diff/DiffMultibuffer';
import { DetailSection } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { Chip } from '../../components/ui/Chip';
import { Dialog } from '../../components/ui/Dialog';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Radio } from '../../components/ui/Radio';
import '../../styles/components/attempt-comparison.css';

interface AttemptComparisonProps {
  open: boolean;
  group: FleetAttemptGroup;
  onClose: () => void;
  /** Called after a successful pick so the caller can revalidate the fleet + attempts. */
  onPicked: () => void;
}

function candidateCost(candidate: FleetAttemptCandidate): string {
  const { costUsd, costState } = candidate.usage;
  if (costState === 'unpriced' || costUsd == null) return costState === 'estimated' ? 'estimating…' : 'unpriced';
  const amount = `$${costUsd.toFixed(costUsd < 1 ? 4 : 2)}`;
  return costState === 'estimated' ? `~${amount}` : amount;
}

export function AttemptComparison({ open, group, onClose, onPicked }: AttemptComparisonProps) {
  const heldCandidates = useMemo(
    () => group.candidates.filter((c) => c.state === 'held-merge'),
    [group.candidates],
  );
  const [judgment, setJudgment] = useState<FleetAttemptJudgment | null>(group.judgment ?? null);
  const [selectedId, setSelectedId] = useState<string>(
    () => group.judgment?.proposedWinnerItemId ?? heldCandidates[0]?.itemId ?? '',
  );
  const [confirmPick, setConfirmPick] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);

  const judge = useMutation({
    mutationFn: () => sdk.operator.fleet.attempts.judge(group.groupId),
    onSuccess: (result) => {
      setJudgment(result);
      if (result.proposedWinnerItemId) setSelectedId(result.proposedWinnerItemId);
    },
  });

  const pick = useMutation({
    // confirm defaults to true (the operator already confirmed via the ConfirmSheet
    // below), the daemon still reports applied/requiresConfirm honestly, and a
    // false applied (e.g. the group went stale between confirm and this call) is
    // NOT treated as a completed merge: onSuccess only closes the modal when the
    // daemon actually applied it.
    mutationFn: (winnerItemId: string) => sdk.operator.fleet.attempts.pick(group.groupId, winnerItemId),
    onSuccess: (result) => {
      if (!result.applied) {
        setConflict('The daemon did not apply this pick. The group may no longer be ready. Refresh the fleet and try again.');
        return;
      }
      onPicked();
      onClose();
    },
    onError: (error) => {
      if (isConflictError(error)) setConflict('This group is no longer ready to pick, refresh the fleet and try again.');
    },
  });

  const judgeUnavailable = judge.isError && isMethodNotInvokableError(judge.error);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Compare attempts: ${group.sourceTitle}`}
      size="wide"
      footer={
        <Button
          variant="primary"
          className="attempt-cmp__pick-btn"
          icon={<Trophy size={16} aria-hidden="true" />}
          disabled={!selectedId || pick.isPending || heldCandidates.length === 0}
          onClick={() => setConfirmPick(true)}
        >
          {pick.isPending ? 'Merging winner…' : 'Pick this winner'}
        </Button>
      }
    >
      <div className="attempt-cmp">
        <p className="attempt-cmp__intro">
          {heldCandidates.length} held candidate{heldCandidates.length === 1 ? '' : 's'} of {group.candidates.length}.
          Pick the winner to merge it and clean the losing worktrees.
        </p>

        {/* Judge proposal. CLEARLY labelled as model judgment, never an auto-pick. */}
        <DetailSection
          title="Model judgment"
          actions={
            <Button
              size="sm"
              className="attempt-cmp__judge-btn"
              disabled={judge.isPending}
              onClick={() => judge.mutate()}
            >
              {judge.isPending ? 'Asking the judge…' : judgment ? 'Re-run judge' : 'Ask the judge'}
            </Button>
          }
        >
          <p className="attempt-cmp__note">This is a proposal only; a human still confirms.</p>
          {judgeUnavailable && (
            <p className="attempt-cmp__note" role="note">No judge model is configured on this engine, pick manually.</p>
          )}
          {judge.isError && !judgeUnavailable && (
            <p className="attempt-cmp__error" role="alert">{formatError(judge.error)}</p>
          )}
          {judgment && (
            <div className="attempt-cmp__judgment">
              <p>
                Proposes{' '}
                <strong>
                  {group.candidates.find((c) => c.itemId === judgment.proposedWinnerItemId)?.title
                    ?? judgment.proposedWinnerItemId ?? 'no clear winner'}
                </strong>
                {judgment.model ? ` (scored by ${judgment.model})` : ''}.
              </p>
              {judgment.reasons.length > 0 && (
                <ul className="attempt-cmp__reasons">
                  {judgment.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              )}
            </div>
          )}
        </DetailSection>

        <div className="attempt-cmp__candidates">
          {group.candidates.map((candidate) => {
            const held = candidate.state === 'held-merge';
            const isProposed = judgment?.proposedWinnerItemId === candidate.itemId;
            const files = candidate.diff ? parseUnifiedDiff(candidate.diff.unifiedDiff) : [];
            return (
              <section
                key={candidate.itemId}
                className={`attempt-cmp__candidate${selectedId === candidate.itemId && held ? ' attempt-cmp__candidate--selected' : ''}`}
              >
                <div className="attempt-cmp__candidate-head">
                  <Radio
                    className="attempt-cmp__pick-radio"
                    name="attempt-winner"
                    value={candidate.itemId}
                    checked={selectedId === candidate.itemId}
                    disabled={!held}
                    onChange={() => setSelectedId(candidate.itemId)}
                  >
                    <span className="attempt-cmp__candidate-title">
                      #{candidate.attemptIndex + 1} {candidate.title}
                    </span>
                  </Radio>
                  <span className="attempt-cmp__chips">
                    <Chip size="sm" tone={held ? 'ok' : 'bad'}>{held ? 'Ready to merge' : candidate.state}</Chip>
                    {isProposed && <Chip size="sm" tone="info">Judge&apos;s pick</Chip>}
                    <Chip size="sm">{candidateCost(candidate)}</Chip>
                  </span>
                </div>
                <p className="attempt-cmp__candidate-meta">
                  {candidate.usage.inputTokens} in · {candidate.usage.outputTokens} out · {candidate.usage.toolCallCount} tool calls
                  {candidate.branch && <span className="attempt-cmp__branch"> · {candidate.branch}</span>}
                </p>
                {candidate.failureReason && (
                  <p className="attempt-cmp__failure" role="note">Failed: {candidate.failureReason}</p>
                )}
                {files.length > 0 ? (
                  <DiffMultibuffer files={files} idPrefix={`attempt-${candidate.itemId}`} maxHunkLines={20} />
                ) : (
                  !candidate.failureReason && <p className="attempt-cmp__note" role="note">No diff captured for this candidate.</p>
                )}
              </section>
            );
          })}
        </div>

        {conflict && <p className="attempt-cmp__error" role="alert">{conflict}</p>}
        {pick.isError && !isConflictError(pick.error) && (
          <p className="attempt-cmp__error" role="alert">{formatError(pick.error)}</p>
        )}
      </div>

      {confirmPick && (
        <ConfirmDialog
          open
          tone="danger"
          title="Pick this attempt as the winner?"
          target={group.candidates.find((c) => c.itemId === selectedId)?.title ?? selectedId}
          description="The winner is merged and every other attempt's worktree is removed for good."
          confirmLabel="Pick winner"
          onConfirm={() => { setConfirmPick(false); setConflict(null); pick.mutate(selectedId); }}
          onCancel={() => setConfirmPick(false)}
        />
      )}
    </Dialog>
  );
}
