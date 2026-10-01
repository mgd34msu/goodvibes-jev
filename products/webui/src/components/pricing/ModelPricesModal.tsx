/**
 * ModelPricesModal, manual model-price editing reachable from any price
 * display (fleet cost badges, session cost chips, attribution rows), one
 * action away. Wraps the same ModelPricesEditor the settings surface uses, so
 * a price entered here is the identical config.set('pricing.modelPrices')
 * write. A manual price applies live (no restart) and always wins over
 * provider-served and catalog pricing, so cost-bearing queries are
 * invalidated on every successful commit.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog } from '../ui/Dialog';
import { sdk } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { readConfigPath } from '../../lib/settings-model';
import { formatError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { ErrorState } from '../feedback/ErrorState';
import { SkeletonBlock } from '../feedback/SkeletonBlock';
import { ModelPricesEditor } from '../settings/ModelPricesEditor';
import '../../styles/components/pricing.css';

export interface ModelPricesModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Pre-fill the add form with this "provider:model" key. */
  readonly initialModelKey?: string;
}

export function ModelPricesModal({ open, onClose, initialModelKey }: ModelPricesModalProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const config = useQuery({
    queryKey: queryKeys.config,
    queryFn: () => sdk.operator.config.get(),
    enabled: open,
    retry: false,
  });

  async function commit(next: Record<string, unknown>): Promise<void> {
    try {
      await sdk.operator.config.set('pricing.modelPrices', next);
    } catch (error) {
      toast({ title: 'Failed to save model prices', description: formatError(error), tone: 'danger' });
      throw error;
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.config }),
      // Manual prices apply live in the resolver, refresh every dollar display.
      queryClient.invalidateQueries({ queryKey: ['cost'] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.fleet }),
      queryClient.invalidateQueries({ queryKey: queryKeys.workstream }),
    ]);
    toast({ title: 'Model prices saved', description: 'Manual prices apply live and win over catalog pricing.', tone: 'success' });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Model prices"
      description="Your own prices, in US dollars per 1M tokens, written as provider:model. A price you set beats the catalog and applies right away. You can also edit them in Settings."
    >
      {config.isPending ? (
        <SkeletonBlock variant="block" height={64} />
      ) : config.isError ? (
        <ErrorState error={config.error} title="Config unavailable" onRetry={() => void config.refetch()} />
      ) : (
        <ModelPricesEditor
          value={readConfigPath(config.data, 'pricing.modelPrices').value}
          onCommit={commit}
          {...(initialModelKey ? { initialModelKey } : {})}
        />
      )}
    </Dialog>
  );
}
