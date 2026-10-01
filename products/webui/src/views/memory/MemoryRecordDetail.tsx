import type { MemoryRecord } from '../../lib/goodvibes';
import { DetailSection, Facts } from '../../components/data-view/DataView';
import { Chip } from '../../components/ui/Chip';
import { formatConfidence, formatProvenanceLink, formatTimestamp, isFlaggedReviewState } from './memory-helpers';

/**
 * Record detail: type (cls), scope, review state, confidence, timestamps, tags and
 * provenance. Renders every field verbatim (no re-interpretation, no secret-shaped
 * special-casing): a provenance `ref` that happens to look like a file path is shown as
 * plain text exactly like any other ref, never turned into a link or fetched, this view
 * has no read-file capability and never invents one.
 */
export function MemoryRecordDetail({ record }: { record: MemoryRecord }) {
  const flagged = isFlaggedReviewState(record.reviewState);

  return (
    <>
      {flagged && record.staleReason && (
        <DetailSection title="Why this is flagged">
          <p className="lib-prose" role="note">{record.staleReason}</p>
        </DetailSection>
      )}

      {record.detail && (
        <DetailSection title="Detail">
          <p className="lib-prose">{record.detail}</p>
        </DetailSection>
      )}

      <Facts
        items={[
          { label: 'Type', value: record.cls },
          { label: 'Scope', value: record.scope },
          { label: 'Review state', value: record.reviewState },
          { label: 'Confidence', value: formatConfidence(record.confidence) },
          { label: 'Created', value: formatTimestamp(record.createdAt) },
          { label: 'Updated', value: formatTimestamp(record.updatedAt) },
          {
            label: 'Reviewed',
            value: record.reviewedAt !== undefined
              ? `${formatTimestamp(record.reviewedAt)}${record.reviewedBy ? ` by ${record.reviewedBy}` : ''}`
              : undefined,
          },
        ]}
      />

      <DetailSection title="Tags">
        {record.tags.length
          ? <div className="lib-chips">{record.tags.map((tag) => <Chip key={tag} size="sm">{tag}</Chip>)}</div>
          : <p className="lib-quiet">No tags</p>}
      </DetailSection>

      <DetailSection title="Provenance">
        {record.provenance.length
          ? (
            <ul className="lib-plain-list">
              {record.provenance.map((link, index) => (
                <li key={`${link.kind}-${link.ref}-${index}`}>{formatProvenanceLink(link)}</li>
              ))}
            </ul>
          )
          : <p className="lib-quiet">No provenance recorded</p>}
      </DetailSection>
    </>
  );
}
