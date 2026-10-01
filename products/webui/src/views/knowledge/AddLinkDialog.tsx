import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type SyntheticEvent } from 'react';
import { invokeMethod } from '../../lib/goodvibes';
import type { OperatorMethodInput } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { firstString, readPath } from '../../lib/object';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { Dialog } from '../../components/ui/Dialog';
import { Field, Input } from '../../components/ui/Field';
import { Select } from '../../components/ui/Select';

export type UrlSourceType = NonNullable<OperatorMethodInput<'knowledge.ingest.url'>['sourceType']>;

const SOURCE_TYPES: readonly { value: UrlSourceType; label: string }[] = [
  { value: 'url', label: 'URL' },
  { value: 'bookmark', label: 'Bookmark' },
  { value: 'manual', label: 'Manual' },
  { value: 'document', label: 'Document' },
  { value: 'repo', label: 'Repo' },
  { value: 'dataset', label: 'Dataset' },
  { value: 'image', label: 'Image' },
  { value: 'other', label: 'Other' },
];

function splitTags(value: string): string[] {
  return value.split(',').map((tag) => tag.trim()).filter(Boolean);
}

interface AddLinkDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the new source's id (when the daemon returns one) after a successful ingest. */
  onIngested: (sourceId: string) => void;
}

/** Ingest a URL as a knowledge source (knowledge.ingest.url). */
export function AddLinkDialog({ open, onClose, onIngested }: AddLinkDialogProps) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [sourceType, setSourceType] = useState<UrlSourceType>('url');
  const [allowPrivateHosts, setAllowPrivateHosts] = useState(false);

  const ingest = useMutation({
    mutationFn: () => {
      const tagList = splitTags(tags);
      const payload: OperatorMethodInput<'knowledge.ingest.url'> = {
        url: url.trim(),
        sourceType,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(folderPath.trim() ? { folderPath: folderPath.trim() } : {}),
        ...(tagList.length ? { tags: tagList } : {}),
        ...(allowPrivateHosts ? { allowPrivateHosts: true } : {}),
      };
      return invokeMethod('knowledge.ingest.url', payload);
    },
    onSuccess: async (result) => {
      setUrl('');
      setTitle('');
      const sourceId = firstString(readPath(result, ['source']), ['id']);
      await queryClient.invalidateQueries({ queryKey: ['knowledge'] });
      onClose();
      if (sourceId) onIngested(sourceId);
    },
  });

  useEffect(() => {
    if (!open) ingest.reset();
    // reset() is stable per mutation; only the open flag should retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (url.trim()) ingest.mutate();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add link"
      description="GoodVibes reads the page and adds it to its knowledge."
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="library-add-link" variant="primary" disabled={ingest.isPending || !url.trim()} aria-busy={ingest.isPending}>
            {ingest.isPending ? 'Ingesting…' : 'Ingest URL'}
          </Button>
        </>
      )}
    >
      <form id="library-add-link" className="lib-form" onSubmit={submit}>
        <Field label="URL">
          <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" aria-label="URL to ingest" />
        </Field>
        <Field label="Title">
          <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Optional display title" aria-label="Optional display title" />
        </Field>
        <div className="lib-form__split">
          <Field label="Source type">
            <Select<UrlSourceType> value={sourceType} onChange={setSourceType} options={SOURCE_TYPES} aria-label="Source type" />
          </Field>
          <Field label="Folder">
            <Input value={folderPath} onChange={(event) => setFolderPath(event.target.value)} placeholder="Optional folder path" aria-label="Optional folder path" />
          </Field>
        </div>
        <Field label="Tags">
          <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="Comma separated" aria-label="Tags, comma separated" />
        </Field>
        <Checkbox checked={allowPrivateHosts} onChange={setAllowPrivateHosts}>Allow private hosts</Checkbox>
        {ingest.error && <div className="dv-notice dv-notice--bad" role="alert"><span>Ingest failed: {formatError(ingest.error)}</span></div>}
      </form>
    </Dialog>
  );
}
