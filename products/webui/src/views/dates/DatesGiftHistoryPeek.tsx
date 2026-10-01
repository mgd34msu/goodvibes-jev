/**
 * The gift history shown in an occasion's detail pane. Reads `occasions.gifts`,
 * which carries what the occasion row cannot: what you landed on in previous
 * years, one record per occurrence.
 *
 * Gift history is machine-owned state (docs/occasions.md §3), not something this
 * view can edit directly, a record is only ever written by closing an interview
 * (`occasions.interview.record`, wired in the gift interview detail). This list
 * is read-only by construction: it has no mutation of its own.
 */
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Gift } from 'lucide-react';
import { sdk } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { formatError } from '../../lib/errors';
import { formatRelative } from '../../lib/object';
import { Button } from '../../components/ui';
import { EmptyState, SkeletonRows } from '../../components/data-view/DataView';

export interface DatesGiftHistoryProps {
  occasionId: string;
}

export function DatesGiftHistoryBody({ occasionId }: DatesGiftHistoryProps) {
  const gifts = useQuery({
    queryKey: queryKeys.occasionsGifts(occasionId),
    queryFn: () => sdk.operator.occasions.gifts(occasionId),
  });

  if (gifts.isPending) return <SkeletonRows count={2} label="Loading gift history" />;

  if (gifts.error) {
    return (
      <EmptyState
        icon={<AlertCircle />}
        title="Gift history failed to load"
        role="status"
        action={<Button variant="outline" size="sm" onClick={() => void gifts.refetch()}>Try again</Button>}
      >
        {formatError(gifts.error)}
      </EmptyState>
    );
  }

  const records = gifts.data?.gifts ?? [];

  if (records.length === 0) {
    return (
      <p className="dates-gifts__empty">
        <Gift aria-hidden="true" />
        Nothing recorded for this occasion. A record is written when a “yes” interview is closed with what you landed on.
      </p>
    );
  }

  return (
    <ul className="dates-gifts" data-testid="dates-gift-peek-list">
      {records.map((record) => (
        <li key={`${record.occasionId}-${record.occurrence}`} className="dates-gifts__item">
          <p className="dates-gifts__landed">{record.landedOn}</p>
          <p className="dates-gifts__meta">{record.occurrence} · Recorded {formatRelative(record.recordedAt)}</p>
          {record.notes ? <p className="dates-gifts__notes">{record.notes}</p> : null}
        </li>
      ))}
    </ul>
  );
}
