/**
 * Knowledge consolidation candidates (knowledge.candidates.list / .candidate.decide).
 * A candidate is a scored suggestion to promote something into durable memory, review
 * it, or refresh its source. Accept, reject or supersede is an explicit, per-candidate
 * decision, never auto-applied. Undecided candidates are rows on the Library's Review
 * tab; a selected one opens in the detail pane with its three decisions.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle } from 'lucide-react';
import { invokeMethod } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { firstString, countFrom } from '../../lib/object';
import { formatError } from '../../lib/errors';
import { DetailPane, DetailSection, Disclosure, Facts, RowGroup, SkeletonRows } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { Row } from '../../components/ui/Row';
import { ErrorState } from '../../components/feedback/ErrorState';
import {
  candidateItems,
  includesText,
  isUndecidedCandidate,
  sentence,
  useKnowledgeCandidates,
} from '../library/library-data';

type Decision = 'accept' | 'reject' | 'supersede';

export interface CandidateView {
  id: string;
  title: string;
  status: string;
  type: string;
  score: number;
  summary: string;
}

export function parseCandidate(candidate: unknown, index: number): CandidateView {
  const summary = firstString(candidate, ['summary']);
  return {
    id: firstString(candidate, ['id']) || String(index),
    title: firstString(candidate, ['title']) || summary || 'Untitled candidate',
    status: firstString(candidate, ['status']) || 'unknown',
    type: firstString(candidate, ['candidateType']) || 'candidate',
    score: countFrom(candidate, ['score']),
    summary,
  };
}

function CandidateRow({ candidate, selected, onSelect }: { candidate: CandidateView; selected: boolean; onSelect: (id: string) => void }) {
  const decided = !isUndecidedCandidate(candidate.status);
  return (
    <Row
      className="knowledge-candidate-row"
      title={candidate.title}
      meta={`${sentence(candidate.type)} · ${decided ? sentence(candidate.status) : 'waiting for a decision'}`}
      trailing={<span className="dv-value">{candidate.score.toFixed(2)}</span>}
      selected={selected}
      onSelect={() => onSelect(candidate.id)}
    />
  );
}

interface KnowledgeCandidateRowsProps {
  query?: string;
  selectedId?: string | null;
  onSelect: (id: string) => void;
}

/** Undecided candidates as a row group, decided ones behind a quiet disclosure. */
export function KnowledgeCandidateRows({ query = '', selectedId = null, onSelect }: KnowledgeCandidateRowsProps) {
  const candidates = useKnowledgeCandidates();

  if (candidates.isPending) return <SkeletonRows count={2} label="Loading candidates" />;
  if (candidates.error) {
    return <ErrorState error={candidates.error} onRetry={() => void candidates.refetch()} title="Candidates failed to load" />;
  }

  const all = candidateItems(candidates.data)
    .map(parseCandidate)
    .filter((c) => includesText([c.title, c.summary, c.type], query));
  const undecided = all.filter((c) => isUndecidedCandidate(c.status));
  const decided = all.filter((c) => !isUndecidedCandidate(c.status));

  return (
    <>
      {undecided.length > 0 && (
        <RowGroup label="Knowledge candidates" count={undecided.length}>
          {undecided.map((c) => <CandidateRow key={c.id} candidate={c} selected={c.id === selectedId} onSelect={onSelect} />)}
        </RowGroup>
      )}
      {decided.length > 0 && (
        <Disclosure summary={`${decided.length} decided`}>
          <RowGroup label="Decided candidates">
            {decided.map((c) => <CandidateRow key={c.id} candidate={c} selected={c.id === selectedId} onSelect={onSelect} />)}
          </RowGroup>
        </Disclosure>
      )}
    </>
  );
}

interface KnowledgeCandidatePaneProps {
  candidate: CandidateView;
  onClose: () => void;
}

export function KnowledgeCandidatePane({ candidate, onClose }: KnowledgeCandidatePaneProps) {
  const queryClient = useQueryClient();
  const decide = useMutation({
    mutationFn: (decision: Decision) => invokeMethod('knowledge.candidate.decide', { id: candidate.id, decision }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.knowledgeCandidates });
    },
  });
  const decided = !isUndecidedCandidate(candidate.status);
  const busy = decide.isPending;

  return (
    <DetailPane
      title={candidate.title}
      meta={sentence(candidate.type)}
      onClose={onClose}
      footer={decided ? undefined : (
        <>
          <Button variant="secondary" icon={<CheckCircle2 aria-hidden="true" />} disabled={busy} aria-busy={busy} onClick={() => decide.mutate('accept')}>Accept</Button>
          <Button variant="secondary" icon={<XCircle aria-hidden="true" />} disabled={busy} aria-busy={busy} onClick={() => decide.mutate('reject')}>Reject</Button>
          <Button variant="ghost" disabled={busy} aria-busy={busy} onClick={() => decide.mutate('supersede')}>Supersede</Button>
        </>
      )}
    >
      {decide.error && <div className="dv-notice dv-notice--bad" role="alert"><span>Decision failed: {formatError(decide.error)}</span></div>}
      {candidate.summary && (
        <DetailSection title="Why it was suggested">
          <p className="lib-prose">{candidate.summary}</p>
        </DetailSection>
      )}
      <Facts
        items={[
          { label: 'Kind', value: sentence(candidate.type) },
          { label: 'Score', value: candidate.score.toFixed(2) },
          { label: 'Status', value: sentence(candidate.status) },
        ]}
      />
    </DetailPane>
  );
}
