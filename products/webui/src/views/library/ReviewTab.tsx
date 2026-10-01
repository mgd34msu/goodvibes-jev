/**
 * The Review tab of the Library: everything that waits for a human call, in one list.
 * Consolidation proposals (contradictions, cross-scope duplicates, stale deletes) come
 * first, then the memory review queue, then knowledge candidates. Selecting a row opens
 * it in the detail pane; selecting a proposal also highlights the queue rows it points at
 * (a jump lands on the rows, it never filters the rest of the queue away).
 */
import { ClipboardList } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MemoryConsolidationProposal, MemoryRecord } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { DetailPane, DetailSection, EmptyState, ListDetail, RowGroup, SkeletonRows } from '../../components/data-view/DataView';
import { Row, RowList } from '../../components/ui/Row';
import ErrorBoundary from '../../components/feedback/ErrorBoundary';
import { ErrorState } from '../../components/feedback/ErrorState';
import { ConsolidationProposals, ConsolidationRuns, PROPOSAL_KIND_LABEL } from '../memory/ConsolidationReceipts';
import { MemoryRecordPane } from '../memory/MemoryRecordPane';
import { MemoryRecordRow } from '../memory/MemoryRecordRow';
import { KnowledgeCandidatePane, KnowledgeCandidateRows, parseCandidate } from '../knowledge/KnowledgeCandidates';
import {
  candidateItems,
  includesText,
  sentence,
  useConsolidationReceipts,
  useKnowledgeCandidates,
  useMemoryRecordMutations,
  useReviewCount,
  useReviewQueue,
} from './library-data';

type Selection =
  | { kind: 'record'; id: string }
  | { kind: 'proposal'; key: string; proposal: MemoryConsolidationProposal }
  | { kind: 'candidate'; id: string };

export interface ReviewTabProps {
  query?: string;
}

export function ReviewTab({ query = '' }: ReviewTabProps) {
  const queue = useReviewQueue();
  const candidates = useKnowledgeCandidates();
  const receipts = useConsolidationReceipts();
  const total = useReviewCount();
  const { remove, saveReview } = useMemoryRecordMutations();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);

  const records = useMemo(
    () => (queue.data?.records ?? []).filter((r) => includesText([r.summary, r.detail, r.cls, r.scope, ...r.tags], query)),
    [queue.data, query],
  );
  const queueById = useMemo(() => new Map((queue.data?.records ?? []).map((r) => [r.id, r])), [queue.data]);

  useEffect(() => {
    if (highlight.size === 0) return;
    listRef.current?.querySelector('.lib-row--highlight')?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  }, [highlight]);

  const selectedRecord: MemoryRecord | undefined = selection?.kind === 'record' ? queueById.get(selection.id) : undefined;
  const selectedCandidate = useMemo(() => {
    if (selection?.kind !== 'candidate') return undefined;
    return candidateItems(candidates.data).map(parseCandidate).find((c) => c.id === selection.id);
  }, [selection, candidates.data]);

  const loaded = !queue.isPending && !candidates.isPending && !receipts.isPending;

  const list = (
    <div ref={listRef}>
      <ConsolidationProposals
        query={query}
        selectedKey={selection?.kind === 'proposal' ? selection.key : null}
        onSelect={(key, proposal) => {
          setSelection({ kind: 'proposal', key, proposal });
          setHighlight(new Set(proposal.ids));
        }}
      />

      {queue.isPending && <SkeletonRows count={3} label="Loading the review queue" />}
      {queue.error && <ErrorState error={queue.error} onRetry={() => void queue.refetch()} title="Review queue unavailable" />}
      {records.length > 0 && (
        <RowGroup label="Review queue" count={records.length}>
          {records.map((record) => (
            <MemoryRecordRow
              key={record.id}
              record={record}
              highlighted={highlight.has(record.id)}
              selected={selection?.kind === 'record' && selection.id === record.id}
              onOpen={(r) => setSelection({ kind: 'record', id: r.id })}
            />
          ))}
        </RowGroup>
      )}

      <KnowledgeCandidateRows
        query={query}
        selectedId={selection?.kind === 'candidate' ? selection.id : null}
        onSelect={(id) => setSelection({ kind: 'candidate', id })}
      />

      {loaded && total === 0 && !query.trim() && (
        <EmptyState icon={<ClipboardList />} title="Nothing is waiting for review">
          Records the store prioritizes for review, consolidation proposals and knowledge candidates appear here.
        </EmptyState>
      )}
      {loaded && total > 0 && records.length === 0 && query.trim() && (
        <p className="lib-quiet">Nothing in the review queue matches this search.</p>
      )}

      <ConsolidationRuns />
    </div>
  );

  let detail: ReactNode = null;
  if (selection?.kind === 'record' && selectedRecord) {
    detail = (
      <MemoryRecordPane
        key={selectedRecord.id}
        record={selectedRecord}
        onClose={() => setSelection(null)}
        onDelete={(record) => remove.mutate(record)}
        deleting={remove.isPending && remove.variables.id === selectedRecord.id}
        onSaveReview={(id, input) => saveReview.mutate({ id, input })}
        saving={saveReview.isPending && saveReview.variables.id === selectedRecord.id}
        error={saveReview.error ? formatError(saveReview.error) : remove.error ? formatError(remove.error) : null}
      />
    );
  } else if (selection?.kind === 'proposal') {
    const { proposal } = selection;
    detail = (
      <DetailPane
        title={PROPOSAL_KIND_LABEL[proposal.kind]}
        meta={`${proposal.ids.length} record${proposal.ids.length === 1 ? '' : 's'}`}
        onClose={() => setSelection(null)}
      >
        <DetailSection title="What was found">
          <p className="lib-prose">{proposal.reason}</p>
        </DetailSection>
        <DetailSection title="Records to look at">
          <RowList aria-label="Records this proposal points at">
            {proposal.ids.map((id) => {
              const record = queueById.get(id);
              return record ? (
                <Row
                  key={id}
                  title={record.summary}
                  meta={`${sentence(record.cls)} · ${record.scope} · ${id}`}
                  onSelect={() => setSelection({ kind: 'record', id })}
                />
              ) : (
                <Row key={id} title={id} meta="Not in the review queue" />
              );
            })}
          </RowList>
        </DetailSection>
      </DetailPane>
    );
  } else if (selection?.kind === 'candidate' && selectedCandidate) {
    detail = <KnowledgeCandidatePane key={selectedCandidate.id} candidate={selectedCandidate} onClose={() => setSelection(null)} />;
  }

  return (
    <ErrorBoundary fallback={(err, reset) => <ErrorState error={err} onRetry={reset} title="Review failed" />}>
      <div className="lib-tab">
        <ListDetail
          mode="peek"
          list={list}
          detail={detail}
          detailOpen={detail !== null}
          onCloseDetail={() => setSelection(null)}
          listLabel="Review"
          detailLabel="Review item"
          backLabel="All review"
        />
      </div>
    </ErrorBoundary>
  );
}
