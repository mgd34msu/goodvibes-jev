/**
 * Library: Memory, Knowledge and Review on one page (design doc "Data views").
 * One search field serves the Memory and Knowledge tabs (and narrows the Review rows);
 * a Segmented switch carries the tab and the Review count; Add memory is the page's
 * primary action and opens a dialog. Record detail opens in the right-hand pane.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { useEffect, useState, type SyntheticEvent } from 'react';
import { DataPage } from '../../components/data-view/DataView';
import { LIBRARY, resolveTab } from '../../components/shell/nav';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { formatError } from '../../lib/errors';
import { sdk, type MemoryAddInput } from '../../lib/goodvibes';
import type { LibraryTab } from '../../lib/router';
import { KnowledgeView } from '../KnowledgeView';
import { AddMemoryDialog } from '../memory/AddMemoryDialog';
import { MemoryView } from '../memory/MemoryView';
import { useDebouncedValue, useReviewCount } from './library-data';
import { ReviewTab } from './ReviewTab';
import '../../styles/components/library.css';

export interface LibraryViewProps {
  tab?: string;
  onTabChange: (tab: LibraryTab) => void;
}

export function LibraryView({ tab, onTabChange }: LibraryViewProps) {
  const queryClient = useQueryClient();
  const current = resolveTab(LIBRARY, tab);
  const [text, setText] = useState('');
  const settled = useDebouncedValue(text);
  // Enter applies the search at once instead of waiting out the pause.
  const [forced, setForced] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [memoryServed, setMemoryServed] = useState(true);
  const reviewCount = useReviewCount();

  useEffect(() => setForced(null), [text]);
  const query = forced ?? settled;

  const add = useMutation({
    mutationFn: (input: MemoryAddInput) => sdk.operator.memory.add(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['memory'] });
      setAdding(false);
      if (current !== 'memory') onTabChange('memory');
    },
  });

  function submitSearch(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setForced(text);
  }

  const searchLabel = 'Search memory and knowledge';
  return (
    <>
      <DataPage
        title={LIBRARY.label}
        description={LIBRARY.description}
        action={memoryServed ? (
          <Button
            variant="primary"
            icon={<Plus aria-hidden="true" />}
            onClick={() => { add.reset(); setAdding(true); }}
          >
            Add memory
          </Button>
        ) : undefined}
        filters={(
          <>
            <form className="dv-filters__search lib-search" role="search" onSubmit={submitSearch}>
              <Search className="lib-search__icon" aria-hidden="true" />
              <Input
                type="search"
                className="gv-input--search"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={searchLabel}
                aria-label={searchLabel}
              />
            </form>
            <Segmented<LibraryTab>
              label="Library sections"
              value={current}
              options={LIBRARY.tabs.map((t) => ({
                value: t.tab as LibraryTab,
                label: t.tab === 'review' && reviewCount > 0 ? `${t.label} · ${reviewCount}` : t.label,
              }))}
              onChange={onTabChange}
            />
          </>
        )}
        className="lib-page"
      >
        {current === 'memory' && <MemoryView query={query} onAddMemory={() => setAdding(true)} onServedChange={setMemoryServed} />}
        {current === 'knowledge' && <KnowledgeView query={query} />}
        {current === 'review' && <ReviewTab query={query} />}
      </DataPage>

      <AddMemoryDialog
        open={adding}
        onClose={() => setAdding(false)}
        isPending={add.isPending}
        error={add.error ? formatError(add.error) : null}
        onSubmit={(input) => add.mutate(input)}
      />
    </>
  );
}
