/**
 * The Memory tab of the Library, the web UI's consumer of the canonical, cross-surface
 * memory store (memory.records.* SDK 1.1.0): search and browse, record detail with its
 * review form and confirmed delete, and a read-only personas group (VIBE.md constraint
 * records). Adding a record is the page's primary action (AddMemoryDialog, in LibraryView).
 *
 * HONESTY. The recall-honesty contract (memory-recall-contract.ts) is applied
 * server-side and surfaced here verbatim via MemorySearchHonestyNote: which search
 * mode actually ran (literal vs semantic), the stated reason when the semantic index
 * could not be consulted (never a silent empty result), the soft hashed-provider
 * caveat, and the recall-filter exclusion counts. A daemon that does not serve memory
 * at all (METHOD_NOT_FOUND on the list query) gets an honest "this daemon does not
 * serve memory" state, never a blank list that reads as "nothing is stored".
 */
import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Database, Plus } from 'lucide-react';
import {
  sdk,
  VIBE_PERSONA_TAG,
  type MemoryClass,
  type MemoryRecord,
  type MemoryScope,
  type MemorySearchInput,
} from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { formatError, isMethodUnavailableError } from '../../lib/errors';
import { EmptyState, ListDetail, RowGroup, SkeletonRows } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { Input } from '../../components/ui/Field';
import { Select } from '../../components/ui/Select';
import ErrorBoundary from '../../components/feedback/ErrorBoundary';
import { ErrorState } from '../../components/feedback/ErrorState';
import { sentence, useDebouncedValue, useMemoryRecordMutations } from '../library/library-data';
import { MemoryRecordRow } from './MemoryRecordRow';
import { MemoryRecordPane } from './MemoryRecordPane';
import { MemorySearchHonestyNote } from './MemorySearchHonestyNote';
import { MEMORY_CLASSES, MEMORY_SCOPES, isPersonaRecord, splitTags } from './memory-helpers';
import '../../styles/components/memory.css';

const LIMIT = 100;
const PERSONA_FILTER: MemorySearchInput = { cls: 'constraint', tags: [VIBE_PERSONA_TAG], limit: LIMIT };

export interface MemoryViewProps {
  /** The Library's shared search text (already settled). */
  query?: string;
  /** Opens the Add memory dialog (the empty state's action). */
  onAddMemory?: () => void;
  /** Told whether the daemon serves memory at all, so the page can drop actions that would only fail. */
  onServedChange?: (served: boolean) => void;
}

export function MemoryView({ query = '', onAddMemory, onServedChange }: MemoryViewProps) {
  const [semantic, setSemantic] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<MemoryScope | ''>('');
  const [clsFilter, setClsFilter] = useState<MemoryClass | ''>('');
  const [tagsInput, setTagsInput] = useState('');
  const [recall, setRecall] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const tagsSettled = useDebouncedValue(tagsInput);

  const { remove, saveReview } = useMemoryRecordMutations();

  const appliedFilters = useMemo<MemorySearchInput>(() => {
    const tags = splitTags(tagsSettled);
    return {
      limit: LIMIT,
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(semantic ? { semantic: true } : {}),
      ...(scopeFilter ? { scope: scopeFilter } : {}),
      ...(clsFilter ? { cls: clsFilter } : {}),
      ...(tags.length ? { tags } : {}),
      ...(recall ? { recall: true } : {}),
    };
  }, [query, semantic, scopeFilter, clsFilter, tagsSettled, recall]);
  const browsing = Object.keys(appliedFilters).length === 1;

  const list = useQuery({
    queryKey: [...queryKeys.memoryList, appliedFilters],
    queryFn: () => sdk.operator.memory.search(appliedFilters),
    placeholderData: keepPreviousData,
  });
  const personas = useQuery({
    queryKey: queryKeys.memoryPersonas,
    queryFn: () => sdk.operator.memory.search(PERSONA_FILTER),
  });

  const personaRecords = useMemo(
    () => (personas.data?.records ?? []).filter(isPersonaRecord),
    [personas.data],
  );
  // Browsing shows personas in their own group (and not twice); with any search or
  // filter the main list already carries the matching persona records.
  const showPersonaGroup = browsing && personaRecords.length > 0;
  const personaIds = useMemo(() => new Set(personaRecords.map((r) => r.id)), [personaRecords]);
  const records = useMemo(() => {
    const all = list.data?.records ?? [];
    return showPersonaGroup ? all.filter((r) => !personaIds.has(r.id)) : all;
  }, [list.data, showPersonaGroup, personaIds]);

  const selected: MemoryRecord | undefined = useMemo(
    () => (selectedId === null
      ? undefined
      : [...(list.data?.records ?? []), ...personaRecords].find((r) => r.id === selectedId)),
    [selectedId, list.data, personaRecords],
  );

  const filtersActive = semantic || recall || scopeFilter !== '' || clsFilter !== '' || tagsInput.trim() !== '';
  function resetFilters() {
    setSemantic(false);
    setRecall(false);
    setScopeFilter('');
    setClsFilter('');
    setTagsInput('');
  }

  // Honest degrade: this daemon build genuinely does not serve the memory verbs at all
  // (a real 404 METHOD_NOT_FOUND on the capability, not a transient failure).
  const notServed = list.isError && isMethodUnavailableError(list.error);
  useEffect(() => { onServedChange?.(!notServed); }, [notServed, onServedChange]);
  if (notServed) {
    return (
      <div className="lib-tab">
        <EmptyState icon={<Database />} title="This daemon does not serve memory">
          The connected daemon build has no memory.records.* service. Upgrade it to browse, add, review, or delete memory records here.
        </EmptyState>
      </div>
    );
  }

  const mutationError = remove.error ?? saveReview.error;

  const listPane = (
    <>
      <div aria-live="polite" aria-atomic="false">
        {list.error && (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} title="Search failed" />
        )}
        {list.data && <MemorySearchHonestyNote result={list.data} limit={LIMIT} />}
      </div>
      {list.isPending && <SkeletonRows count={6} label="Loading memory" />}
      {list.data?.records.length === 0 && !showPersonaGroup && (
        <EmptyState
          icon={<Database />}
          title="No memory recorded yet"
          action={onAddMemory && <Button variant="secondary" icon={<Plus aria-hidden="true" />} onClick={onAddMemory}>Add memory</Button>}
        >
          {browsing ? 'Add a memory to start building what GoodVibes remembers.' : 'Nothing matches this search. Try fewer filters.'}
        </EmptyState>
      )}
      {list.data && records.length > 0 && (
        <RowGroup label="Records" count={records.length}>
          {records.map((record) => (
            <MemoryRecordRow
              key={record.id}
              record={record}
              recallFloor={list.data.recallFloor}
              selected={record.id === selected?.id}
              onOpen={(r) => setSelectedId(r.id)}
            />
          ))}
        </RowGroup>
      )}
      {showPersonaGroup && personas.data && (
        <RowGroup label="Personas" count={personaRecords.length}>
          {personaRecords.map((record) => (
            <MemoryRecordRow
              key={record.id}
              record={record}
              recallFloor={personas.data.recallFloor}
              selected={record.id === selected?.id}
              onOpen={(r) => setSelectedId(r.id)}
            />
          ))}
        </RowGroup>
      )}
    </>
  );

  return (
    <ErrorBoundary
      fallback={(err, reset) => <ErrorState error={err} onRetry={reset} title="Memory view failed" />}
    >
      <div className="lib-tab">
        <div className="lib-toolbar" role="group" aria-label="Memory filters">
          <Select<MemoryScope | ''>
            value={scopeFilter}
            aria-label="Filter by scope"
            onChange={setScopeFilter}
            options={[{ value: '', label: 'Any scope' }, ...MEMORY_SCOPES.map((s) => ({ value: s, label: sentence(s) }))]}
          />
          <Select<MemoryClass | ''>
            value={clsFilter}
            aria-label="Filter by type"
            onChange={setClsFilter}
            options={[{ value: '', label: 'Any type' }, ...MEMORY_CLASSES.map((c) => ({ value: c, label: sentence(c) }))]}
          />
          <Input
            className="lib-toolbar__tags"
            value={tagsInput}
            onChange={(event) => setTagsInput(event.target.value)}
            placeholder="Tags, comma separated"
            aria-label="Filter by tags"
          />
          <Checkbox checked={semantic} onChange={setSemantic}>Semantic</Checkbox>
          <span title="Apply the recall-injection contract server-side: exclude flagged records outright and drop records below the confidence floor, so this shows what the agent would actually recall.">
            <Checkbox checked={recall} onChange={setRecall}>What the agent would recall</Checkbox>
          </span>
          {filtersActive && <Button variant="ghost" size="sm" onClick={resetFilters}>Reset filters</Button>}
        </div>

        {mutationError && (
          <div className="lib-toolbar"><div className="dv-notice dv-notice--bad" role="alert"><span>{formatError(mutationError)}</span></div></div>
        )}

        <ListDetail

          mode="peek"
          list={listPane}
          detail={selected && (
            <MemoryRecordPane
              key={selected.id}
              record={selected}
              onClose={() => setSelectedId(null)}
              onDelete={(record) => remove.mutate(record)}
              deleting={remove.isPending && remove.variables.id === selected.id}
              onSaveReview={(id, input) => saveReview.mutate({ id, input })}
              saving={saveReview.isPending && saveReview.variables.id === selected.id}
            />
          )}
          detailOpen={selected !== undefined}
          onCloseDetail={() => setSelectedId(null)}
          listLabel="Memory records"
          detailLabel="Memory record"
          backLabel="All memory"
        />
      </div>
    </ErrorBoundary>
  );
}
