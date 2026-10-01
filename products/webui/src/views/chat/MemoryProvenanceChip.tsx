/**
 * MemoryProvenanceChip, owner-ruled, default-OFF drill-in for a chat turn
 * that used memories (see lib/memory-provenance.ts for the reading contract
 * and lib/ui-preferences.ts's memoryProvenanceChipEnabled for the setting).
 *
 * Renders NOTHING when the preference is off, or when this turn carries no
 * memory-provenance ids, the honest-absence idiom this codebase uses
 * everywhere else (never a dead chip, never a fabricated "0 used" state).
 *
 * The drill-in fetches each record's real detail (sdk.operator.memory.get)
 * lazily, only once expanded, the chip itself never blocks on a fetch.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Database } from 'lucide-react';
import { sdk } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { Chip } from '../../components/ui/Chip';
import '../../styles/components/memory-provenance.css';

export interface MemoryProvenanceChipProps {
  recordIds: readonly string[];
}

export function MemoryProvenanceChip({ recordIds }: MemoryProvenanceChipProps) {
  const [expanded, setExpanded] = useState(false);

  const details = useQuery({
    queryKey: ['memory', 'provenance', ...recordIds],
    queryFn: async () => {
      const results = await Promise.allSettled(recordIds.map((id) => sdk.operator.memory.get(id)));
      return results.map((result, index) => ({
        id: recordIds[index],
        ok: result.status === 'fulfilled',
        record: result.status === 'fulfilled' ? result.value.record : null,
        error: result.status === 'rejected' ? (result.reason as unknown) : null,
      }));
    },
    enabled: expanded && recordIds.length > 0,
  });

  if (recordIds.length === 0) return null;

  return (
    <div className="memory-provenance-chip">
      <button
        type="button"
        className="memory-provenance-chip__toggle"
        aria-expanded={expanded}
        aria-label={`Memory used: ${recordIds.length} record${recordIds.length === 1 ? '' : 's'}, show details`}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <Database size={14} aria-hidden="true" />
        <span>Memory: {recordIds.length}</span>
        {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
      </button>

      {expanded && (
        <div className="memory-provenance-chip__details">
          {details.isPending && <p className="form-note">Loading injection records…</p>}
          {details.isError && (
            <p className="banner warning" role="alert">{formatError(details.error)}</p>
          )}
          {details.data && (
            <ul className="memory-provenance-chip__list">
              {details.data.map((entry) => (
                <li key={entry.id}>
                  {entry.ok && entry.record ? (
                    <>
                      <strong>{entry.record.summary}</strong>
                      <span className="memory-provenance-chip__meta">
                        <Chip size="sm">{entry.record.cls}</Chip>
                        <Chip size="sm">{entry.record.scope}</Chip>
                      </span>
                    </>
                  ) : (
                    <span className="memory-provenance-chip__missing">
                      {entry.id}: no longer available ({formatError(entry.error)})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
