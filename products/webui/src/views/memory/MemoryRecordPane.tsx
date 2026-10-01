import { Trash2 } from 'lucide-react';
import { useId, useState, type SyntheticEvent } from 'react';
import type { MemoryRecord, MemoryUpdateReviewInput } from '../../lib/goodvibes';
import { DetailPane, DetailSection } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { Field, Input } from '../../components/ui/Field';
import { Select } from '../../components/ui/Select';
import { sentence } from '../library/library-data';
import { MemoryRecordDetail } from './MemoryRecordDetail';
import { MEMORY_REVIEW_STATES, isFlaggedReviewState } from './memory-helpers';

interface MemoryRecordPaneProps {
  record: MemoryRecord;
  onClose: () => void;
  onDelete: (record: MemoryRecord) => void;
  deleting: boolean;
  onSaveReview: (id: string, input: MemoryUpdateReviewInput) => void;
  saving: boolean;
  /** An error from the last review save or delete, shown in the pane. */
  error?: string | null;
}

/** The right-hand pane for one memory record: detail, the review form (state,
 * confidence, reason; committed to the daemon only on Save, memory.records.update-review)
 * and a confirmed delete. Keyed by record id by the caller so drafts reset per record. */
export function MemoryRecordPane({ record, onClose, onDelete, deleting, onSaveReview, saving, error }: MemoryRecordPaneProps) {
  const formId = useId();
  const [state, setState] = useState(record.reviewState);
  const [confidence, setConfidence] = useState(String(Math.round(record.confidence)));
  const [staleReason, setStaleReason] = useState(record.staleReason ?? '');
  const confirm = useConfirm();
  const flagged = isFlaggedReviewState(state);
  const parsed = Number(confidence);
  const confidenceValid = confidence.trim() !== '' && Number.isFinite(parsed) && parsed >= 0 && parsed <= 100;

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confidenceValid) return;
    onSaveReview(record.id, {
      state,
      confidence: parsed,
      ...(flagged && staleReason.trim() ? { staleReason: staleReason.trim() } : {}),
    });
  }

  async function handleDelete(): Promise<void> {
    const ok = await confirm.ask({
      title: 'Delete this memory?',
      target: record.summary,
      description: 'It is removed for good and cannot be brought back.',
      confirmLabel: 'Delete memory',
      tone: 'danger',
    });
    if (ok) onDelete(record);
  }

  return (
    <>
      <DetailPane
        title={record.summary}
        meta={`${sentence(record.cls)} · ${record.scope}`}
        onClose={onClose}
        actions={(
          <Button variant="ghost" size="sm" icon={<Trash2 aria-hidden="true" />} disabled={deleting} onClick={() => void handleDelete()}>
            Delete
          </Button>
        )}
        footer={(
          <Button type="submit" form={formId} variant="secondary" disabled={saving || !confidenceValid} aria-busy={saving}>
            {saving ? 'Saving…' : 'Save review'}
          </Button>
        )}
      >
        {error && <div className="dv-notice dv-notice--bad" role="alert"><span>{error}</span></div>}
        <MemoryRecordDetail record={record} />
        <DetailSection title="Review">
          <form id={formId} className="lib-form" onSubmit={submit}>
            <Field label="Review state">
              <Select
                value={state}
                aria-label={`Review state for ${record.summary}`}
                onChange={setState}
                options={MEMORY_REVIEW_STATES.map((option) => ({ value: option, label: sentence(option) }))}
              />
            </Field>
            <Field label="Confidence (0 to 100)" error={confidence.trim() !== '' && !confidenceValid ? 'Enter a number from 0 to 100.' : undefined}>
              <Input
                inputMode="numeric"
                pattern="[0-9]*"
                value={confidence}
                aria-label={`Confidence for ${record.summary}`}
                onChange={(event) => setConfidence(event.target.value)}
              />
            </Field>
            {flagged && (
              <Field label="Reason">
                <Input
                  value={staleReason}
                  placeholder="Why is this flagged?"
                  aria-label={`Stale/contradicted reason for ${record.summary}`}
                  onChange={(event) => setStaleReason(event.target.value)}
                />
              </Field>
            )}
          </form>
        </DetailSection>
      </DetailPane>

      {confirm.element}
    </>
  );
}
