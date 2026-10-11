/**
 * Models and providers: what was the Providers view.
 *
 * The overview shows the current model (with "Change", which opens the model
 * workspace) and every provider as a row: a status dot, its state in plain
 * words, and how many models it serves. A provider row opens its detail in
 * place: models as rows (name left, context and price right, one action),
 * sign-in routes with per-route state and repair hints, the credential-status
 * panel scoped to it, and the raw runtime and usage behind "Show details".
 *
 * Provider status is derived exactly as the Providers view did
 * (provider-status.ts deriveProviderStatus over the merged list record and the
 * freshest providers.get snapshot), only its presentation changed.
 */
import { useProviderModelOptions } from '../../../../lib/use-provider-model-options';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sdk } from '../../../../lib/goodvibes';
import { queryKeys } from '../../../../lib/queries';
import { asRecord, bestTitle, firstString, readPath } from '../../../../lib/object';
import {
  modelOptionsForProvider,
  providerOptionsFromResponse,
  sortProvidersConfiguredFirst,
  type ModelOption,
} from '../../../../lib/provider-models';
import { deriveProviderStatus, freshnessPhrase, freshnessTone, providerStatePhrase } from '../../../../lib/provider-status';
import { formatError } from '../../../../lib/errors';
import { useToast } from '../../../../lib/toast';
import { DataBlock } from '../../../DataBlock';
import { CredentialStatusPanel } from '../../../CredentialStatusPanel';
import { ModelWorkspaceModal } from '../../../model-workspace/ModelWorkspaceModal';
import { ErrorState } from '../../../feedback/ErrorState';
import { SkeletonBlock } from '../../../feedback/SkeletonBlock';
import { Button } from '../../../ui/Button';
import { Chip } from '../../../ui/Chip';
import { Row, RowList } from '../../../ui/Row';
import { StatusDot } from '../../../ui/StatusDot';
import { ConfigGroupList, useConfigSettings } from '../ConfigSettings';
import { SettingsBlock, ShowDetails } from '../parts';
import { groupsForSection } from '../sections';

/** "200k context", "1M context", or '' when the catalog reports none. */
export function contextLabel(model: unknown): string {
  const raw = asRecord(model).contextWindow;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return '';
  if (raw >= 1_000_000) return `${Number((raw / 1_000_000).toFixed(1))}M context`;
  if (raw >= 1_000) return `${Math.round(raw / 1_000)}k context`;
  return `${raw} context`;
}

function money(n: number): string {
  return `$${Number(n.toFixed(2))}`;
}

/** "$3 in · $15 out per 1M", or '' when the catalog reports no pricing. */
export function priceLabel(model: unknown): string {
  const pricing = asRecord(asRecord(model).pricing);
  const input = pricing.inputPerMillionTokens;
  const output = pricing.outputPerMillionTokens;
  if (typeof input !== 'number' || typeof output !== 'number') return '';
  if (input === 0 && output === 0) return 'Free';
  return `${money(input)} in · ${money(output)} out per 1M`;
}

function useProviderData() {
  const providers = useQuery({ queryKey: queryKeys.providers, queryFn: () => sdk.operator.providers.list() });
  const modelCatalog = useQuery({ queryKey: ['models'], queryFn: () => sdk.operator.models.list() });
  const currentModel = useQuery({ queryKey: ['models', 'current'], queryFn: () => sdk.operator.models.current.get() });

  const catalogProviderOptions = useMemo(() => providerOptionsFromResponse(modelCatalog.data), [modelCatalog.data]);
  const providerOptions = useMemo(() => {
    const byId = new Map<string, ReturnType<typeof providerOptionsFromResponse>[number]>();
    for (const provider of providerOptionsFromResponse(providers.data)) byId.set(provider.id, provider);
    for (const provider of catalogProviderOptions) {
      const existing = byId.get(provider.id);
      byId.set(
        provider.id,
        existing ? { ...existing, value: { ...asRecord(existing.value), ...asRecord(provider.value) } } : provider,
      );
    }
    return sortProvidersConfiguredFirst([...byId.values()]);
  }, [catalogProviderOptions, providers.data]);
  const modelProviders = useMemo(() => catalogProviderOptions.map((p) => p.value), [catalogProviderOptions]);

  const currentModelRecord = asRecord(readPath(currentModel.data, ['model']));
  const catalogCurrentModel = asRecord(readPath(modelCatalog.data, ['currentModel']));
  const current = {
    registryKey: firstString(currentModelRecord, ['registryKey']) || firstString(catalogCurrentModel, ['registryKey']),
    provider: firstString(currentModelRecord, ['provider']) || firstString(catalogCurrentModel, ['provider']),
    id: firstString(currentModelRecord, ['id']) || firstString(catalogCurrentModel, ['id']),
    label: firstString(currentModelRecord, ['displayName', 'label', 'name']) || firstString(catalogCurrentModel, ['displayName', 'label', 'name']),
  };

  return { providers, modelCatalog, currentModel, providerOptions, modelProviders, current };
}

export function ModelsSection() {
  const { groups } = useConfigSettings();
  const data = useProviderData();
  const [selectedId, setSelectedId] = useState('');
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const selected = selectedId ? data.providerOptions.find((p) => p.id === selectedId) : undefined;

  return (
    <>
      {selected ? (
        <ProviderDetail
          provider={selected.value}
          providerId={selected.id}
          modelProviders={data.modelProviders}
          sourceRevision={`${data.providers.dataUpdatedAt}:${data.modelCatalog.dataUpdatedAt}`}
          sourceReady={data.providers.isSuccess && data.modelCatalog.isSuccess && !data.providers.isFetching && !data.modelCatalog.isFetching}
          currentRegistryKey={data.current.registryKey}
          onBack={() => setSelectedId('')}
        />
      ) : (
        <>
          <SettingsBlock
            title="Current model"
            description="Used for new chats. Each chat can switch in the composer."
            testId="current-model"
          >
            {data.currentModel.isLoading ? (
              <div className="settings-skeleton" aria-label="Loading current model" aria-busy="true">
                <SkeletonBlock variant="block" height={18} width={180} />
              </div>
            ) : data.currentModel.isError ? (
              <ErrorState
                error={data.currentModel.error}
                title="Failed to load current model"
                onRetry={() => void data.currentModel.refetch()}
              />
            ) : (
              <div className="settings-current-model">
                <div className="settings-current-model__text">
                  <strong>{data.current.label || data.current.id || 'No model selected'}</strong>
                  <span className="settings-mono">{data.current.registryKey || 'Daemon default is not configured'}</span>
                </div>
                <Button variant="outline" size="sm" aria-label="Change model" onClick={() => setWorkspaceOpen(true)}>
                  Change
                </Button>
              </div>
            )}
          </SettingsBlock>

          <SettingsBlock title="Providers" description="Configured providers first. Open one for its models and sign-in routes.">
            {data.providers.isError ? (
              <ErrorState
                error={data.providers.error}
                title="Failed to load providers"
                onRetry={() => {
                  void data.providers.refetch();
                  void data.modelCatalog.refetch();
                }}
              />
            ) : (data.providers.isLoading || data.modelCatalog.isLoading) && data.providerOptions.length === 0 ? (
              <div className="settings-skeleton" aria-label="Loading providers" aria-busy="true">
                {Array.from({ length: 4 }, (_, i) => <SkeletonBlock key={i} variant="block" height={40} />)}
              </div>
            ) : data.providerOptions.length === 0 ? (
              <p className="settings-empty">No providers are registered with the daemon.</p>
            ) : (
              <RowList aria-label="Providers">
                {data.providerOptions.map((provider) => {
                  const status = deriveProviderStatus(provider.value);
                  const count = modelOptionsForProvider(provider.value, data.modelProviders).length;
                  const title = bestTitle(provider.value, provider.id);
                  return (
                    <Row
                      key={provider.id}
                      className="settings-provider-row"
                      leading={<StatusDot tone={freshnessTone(status.freshness)} />}
                      title={title}
                      meta={providerStatePhrase(status)}
                      aria-label={`${title}: ${providerStatePhrase(status)}. ${count} model${count === 1 ? '' : 's'}`}
                      onSelect={() => setSelectedId(provider.id)}
                      trailing={(
                        <span className="settings-row-count" aria-hidden="true">
                          {count > 0 ? `${count} model${count === 1 ? '' : 's'}` : ''}
                          <ChevronRight />
                        </span>
                      )}
                    />
                  );
                })}
              </RowList>
            )}
          </SettingsBlock>
          <ConfigGroupList groups={groupsForSection('models', groups)} />
        </>
      )}
      {workspaceOpen && typeof document !== 'undefined' && createPortal(
        // data-gv-layer: focus inside the workspace still counts as inside the
        // settings dialog, so the dialog's focus trap leaves it alone.
        <div data-gv-layer="">
          <ModelWorkspaceModal open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} />
        </div>,
        document.body,
      )}
    </>
  );
}

function ProviderDetail({
  provider,
  providerId,
  modelProviders,
  sourceRevision,
  sourceReady,
  currentRegistryKey,
  onBack,
}: {
  provider: unknown;
  providerId: string;
  modelProviders: unknown[];
  sourceRevision: string;
  sourceReady: boolean;
  currentRegistryKey: string;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const detail = useQuery({
    queryKey: ['providers', providerId],
    enabled: Boolean(providerId),
    queryFn: () => sdk.operator.providers.get(providerId),
  });
  const usage = useQuery({
    queryKey: ['providers', providerId, 'usage'],
    enabled: Boolean(providerId),
    queryFn: () => sdk.operator.providers.usage(providerId),
  });
  // Status reads BOTH the merged list record (carries the catalog's flat
  // configured / configuredVia / routes) and the freshest providers.get
  // snapshot (current runtime.auth.routes, never a configuredVia); their key
  // names do not overlap, so the shallow merge cannot clobber either.
  const combined = useMemo(() => ({ ...asRecord(provider), ...asRecord(detail.data) }), [provider, detail.data]);
  const status = useMemo(() => deriveProviderStatus(combined), [combined]);
  const providerModels = useProviderModelOptions(provider, modelProviders,
    `${providerId}:${sourceRevision}:${detail.dataUpdatedAt}`, sourceReady && !detail.isFetching);
  const models: ModelOption[] = providerModels.models;
  const title = bestTitle(provider, providerId);

  const selectModel = useMutation({
    mutationFn: (registryKey: string) => {
      if (!providerModels.hasCurrentModel(registryKey)) throw new Error('Model options changed. Choose a current model.');
      return sdk.operator.models.current.set(registryKey);
    },
    onSuccess: async (_data, registryKey) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['models'] }),
        queryClient.invalidateQueries({ queryKey: ['models', 'current'] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers }),
      ]);
      const label = registryKey.split(':').slice(1).join(':') || registryKey;
      toast({ title: 'Model changed', description: label, tone: 'success' });
    },
    onError: (error: unknown) => {
      toast({ title: 'Failed to select model', description: formatError(error), tone: 'danger' });
    },
  });

  return (
    <>
      <div className="settings-provider-head">
        <Button variant="ghost" size="sm" icon={<ChevronLeft />} onClick={onBack}>
          All providers
        </Button>
        <div className="settings-provider-head__title">
          <h3 className="settings-block__title">{title}</h3>
          <span className="settings-provider-head__state">
            <StatusDot tone={freshnessTone(status.freshness)} />
            <span>{status.configured ? providerStatePhrase(status) : 'Not configured'}</span>
          </span>
          <span className="settings-mono">{providerId}</span>
        </div>
      </div>

      <SettingsBlock title="Models" description="Pick the model new chats use.">
        {selectModel.isError && <ErrorState error={selectModel.error} title="Model selection failed" />}
        {models.length === 0 ? (
          <p className="settings-empty">No models reported for this provider.</p>
        ) : (
          <RowList aria-label="Available models">
            {models.map((model) => {
              const isCurrent = model.registryKey === currentRegistryKey;
              const facts = [contextLabel(model.value), priceLabel(model.value)].filter(Boolean).join(' · ');
              return (
                <Row
                  key={model.id}
                  className="settings-model-row"
                  selected={isCurrent}
                  title={model.label}
                  meta={<span className="settings-mono">{model.registryKey}</span>}
                  trailing={(
                    <>
                      {facts && <span className="settings-model-row__facts">{facts}</span>}
                      {isCurrent ? (
                        <Chip size="sm">Current</Chip>
                      ) : (
                        <Button
                          size="sm"
                          disabled={selectModel.isPending}
                          aria-label={`Use ${model.label}`}
                          onClick={() => selectModel.mutate(model.registryKey)}
                        >
                          Use
                        </Button>
                      )}
                    </>
                  )}
                />
              );
            })}
          </RowList>
        )}
      </SettingsBlock>

      <SettingsBlock title="Sign-in routes" description="Each way this provider can authenticate, with its own state.">
        {status.routes.length === 0 ? (
          <p className="settings-empty">No sign-in route detail reported for this provider.</p>
        ) : (
          <RowList aria-label="Authentication routes">
            {status.routes.map((route, index) => (
              <Row
                key={`${route.route}-${index}`}
                className="settings-route-row"
                leading={<StatusDot tone={freshnessTone(route.freshness)} />}
                title={route.label}
                meta={[
                  freshnessPhrase(route.freshness),
                  route.detail ?? '',
                  route.repairHints.join('; '),
                ].filter(Boolean).join(' · ')}
              />
            ))}
          </RowList>
        )}
      </SettingsBlock>

      <CredentialStatusPanel selectedProviderId={providerId} />

      <SettingsBlock title="Runtime and usage" description="What the daemon reports for this provider, as it reports it.">
        <ShowDetails>
          <div className="settings-details__stack">
            <DataBlock title="Provider Runtime" value={detail.data ?? provider} />
            <DataBlock title="Usage" value={usage.data} />
          </div>
        </ShowDetails>
      </SettingsBlock>
    </>
  );
}
