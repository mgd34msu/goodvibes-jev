import { bestId, bestStatus, bestTitle } from '../lib/object';
import { StatusBadge } from './StatusBadge';
import { Row, RowList } from './ui/Row';
import '../styles/components/feedback.css';

interface RecordListProps {
  items: unknown[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  empty?: string;
}

/** A divided list of records: title, id as meta, status word right-aligned. */
export function RecordList({ items, selectedId, onSelect, empty = 'No records' }: RecordListProps) {
  if (!items.length) return <p className="record-list__empty">{empty}</p>;

  return (
    <RowList>
      {items.map((item, index) => {
        const id = bestId(item) || String(index);
        return (
          <Row
            key={`${id}-${index}`}
            title={bestTitle(item, id)}
            meta={id}
            selected={selectedId === id}
            {...(onSelect ? { onSelect: () => onSelect(id) } : {})}
            trailing={<StatusBadge value={bestStatus(item)} />}
          />
        );
      })}
    </RowList>
  );
}
