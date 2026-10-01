import { useEffect, useState, type SyntheticEvent } from 'react';
import type { MemoryAddInput, MemoryClass, MemoryScope } from '../../lib/goodvibes';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { Select } from '../../components/ui/Select';
import { sentence } from '../library/library-data';
import { MEMORY_CLASSES, MEMORY_SCOPES, splitTags } from './memory-helpers';

interface AddMemoryDialogProps {
  open: boolean;
  onClose: () => void;
  isPending: boolean;
  /** Message from the last failed save, shown inside the dialog. */
  error?: string | null;
  onSubmit: (input: MemoryAddInput) => void;
}

/** The add-a-memory dialog. New records default to confidence 60 (the recall floor)
 * and reviewState 'fresh' on the daemon side; this form does not offer to override
 * either, keeping "add" honest about what a freshly-stored fact starts as. */
export function AddMemoryDialog({ open, onClose, isPending, error, onSubmit }: AddMemoryDialogProps) {
  const [cls, setCls] = useState<MemoryClass>('fact');
  const [scope, setScope] = useState<MemoryScope>('project');
  const [summary, setSummary] = useState('');
  const [detail, setDetail] = useState('');
  const [tags, setTags] = useState('');

  useEffect(() => {
    if (!open) {
      setSummary('');
      setDetail('');
      setTags('');
    }
  }, [open]);

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!summary.trim()) return;
    const tagList = splitTags(tags);
    onSubmit({
      cls,
      summary: summary.trim(),
      scope,
      ...(detail.trim() ? { detail: detail.trim() } : {}),
      ...(tagList.length ? { tags: tagList } : {}),
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add memory"
      description="A fact, decision or constraint GoodVibes should remember."
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="library-add-memory" variant="primary" disabled={isPending || !summary.trim()} aria-busy={isPending}>
            {isPending ? 'Saving…' : 'Add memory'}
          </Button>
        </>
      )}
    >
      <form id="library-add-memory" className="lib-form" onSubmit={submit}>
        <div className="lib-form__split">
          <Field label="Type">
            <Select<MemoryClass>
              value={cls}
              aria-label="Memory type"
              onChange={setCls}
              options={MEMORY_CLASSES.map((option) => ({ value: option, label: sentence(option) }))}
            />
          </Field>
          <Field label="Scope">
            <Select<MemoryScope>
              value={scope}
              aria-label="Memory scope"
              onChange={setScope}
              options={MEMORY_SCOPES.map((option) => ({ value: option, label: sentence(option) }))}
            />
          </Field>
        </div>
        <Field label="Summary">
          <Input
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            placeholder="A one-line fact, decision or constraint"
            aria-label="Memory summary"
            required
          />
        </Field>
        <Field label="Detail">
          <Textarea
            value={detail}
            onChange={(event) => setDetail(event.target.value)}
            placeholder="Optional longer explanation"
            aria-label="Memory detail"
            rows={3}
          />
        </Field>
        <Field label="Tags">
          <Input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="Comma separated"
            aria-label="Tags, comma separated"
          />
        </Field>
        {error && <div className="dv-notice dv-notice--bad" role="alert"><span>{error}</span></div>}
      </form>
    </Dialog>
  );
}
