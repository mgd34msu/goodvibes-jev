/**
 * The smaller settings sections. Each one gathers the panels that used to sit
 * on the Admin and Providers pages (or were their own page) and the config
 * groups sections.ts assigns to it.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Smartphone } from 'lucide-react';
import { GOODVIBES_BASE_URL, WEBUI_VERSION, invokeMethod, sdk } from '../../../../lib/goodvibes';
import { queryKeys } from '../../../../lib/queries';
import { bestTitle } from '../../../../lib/object';
import { providerOptionsFromResponse, sortProvidersConfiguredFirst } from '../../../../lib/provider-models';
import { useWebUiPreferences } from '../../../../lib/ui-preferences';
import type { ViewId } from '../../../../lib/router';
import { AccountsPanel } from '../../../AccountsPanel';
import { CredentialStatusPanel } from '../../../CredentialStatusPanel';
import { ErrorState } from '../../../feedback/ErrorState';
import { SkeletonBlock } from '../../../feedback/SkeletonBlock';
import { VoiceSettings } from '../../../voice/VoiceSettings';
import { Button } from '../../../ui/Button';
import { Select } from '../../../ui/Select';
import { StatusDot } from '../../../ui/StatusDot';
import { Toggle } from '../../../ui/Toggle';
import { MemoryDiagnostics } from '../../MemoryDiagnostics';
import { PermissionRules } from '../../PermissionRules';
import { NotificationSettings } from '../../NotificationSettings';
import { PairingTokensSettings } from '../../PairingTokensSettings';
import { PowerSettings } from '../../PowerSettings';
import { TailscaleSettings } from '../../TailscaleSettings';
import { PrincipalsView } from '../../../../views/principals/PrincipalsView';
import { ConfigGroupList, RawConfigEditor, useConfigSettings } from '../ConfigSettings';
import { ReadableValue, SettingRow, SettingsBlock } from '../parts';
import { groupsForSection, type SettingsSectionId } from '../sections';
import { CheckInSettings } from '../../../../views/checkin/CheckInView';

function SectionConfig({ id, emptyText }: { id: SettingsSectionId; emptyText?: string }) {
  const { groups } = useConfigSettings();
  return <ConfigGroupList groups={groupsForSection(id, groups)} emptyText={emptyText} />;
}

export function DevicesSection({ onOpenView }: { onOpenView: (view: ViewId) => void }) {
  return (
    <>
      <PairingTokensSettings />
      <SettingsBlock title="This browser as a phone node" description="Offer this device's camera, screen, location and clipboard to the agent, one confirmed request at a time.">
        <div className="settings-rows">
          <SettingRow
            label="Phone node"
            description="Opens as its own page: it stays connected while that page is open."
            control={(
              <Button size="sm" icon={<Smartphone />} onClick={() => onOpenView('phone')}>
                Open
              </Button>
            )}
          />
        </div>
      </SettingsBlock>
      <PowerSettings />
      <SectionConfig id="devices" />
    </>
  );
}

export function PeopleSection() {
  return <PrincipalsView />;
}

export function CredentialsSection() {
  const accounts = useQuery({ queryKey: queryKeys.accounts, queryFn: () => sdk.operator.accounts.snapshot() });
  return (
    <>
      <CredentialStatusPanel />
      <AccountsPanel
        data={accounts.data}
        isLoading={accounts.isLoading}
        isError={accounts.isError}
        error={accounts.error}
        onRetry={() => void accounts.refetch()}
      />
      <SectionConfig id="credentials" />
    </>
  );
}

export function UsageSection() {
  const providers = useQuery({ queryKey: queryKeys.providers, queryFn: () => sdk.operator.providers.list() });
  const options = useMemo(() => sortProvidersConfiguredFirst(providerOptionsFromResponse(providers.data)), [providers.data]);
  const [picked, setPicked] = useState('');
  const providerId = picked || options[0]?.id || '';
  const usage = useQuery({
    queryKey: ['providers', providerId, 'usage'],
    enabled: Boolean(providerId),
    queryFn: () => sdk.operator.providers.usage(providerId),
  });

  return (
    <>
      <SettingsBlock
        title="Provider usage"
        description="What the daemon has recorded for one provider."
        actions={options.length > 0 ? (
          <Select
            aria-label="Provider"
            value={providerId}
            placement="bottom-end"
            options={options.map((o) => ({ value: o.id, label: bestTitle(o.value, o.id) }))}
            onChange={setPicked}
          />
        ) : undefined}
      >
        {providers.isError ? (
          <ErrorState error={providers.error} title="Failed to load providers" onRetry={() => void providers.refetch()} />
        ) : !providerId ? (
          providers.isLoading
            ? <SkeletonBlock variant="text" lines={3} />
            : <p className="settings-empty">No providers are registered with the daemon.</p>
        ) : usage.isLoading ? (
          <SkeletonBlock variant="text" lines={3} />
        ) : usage.isError ? (
          <ErrorState error={usage.error} title="Usage unavailable" onRetry={() => void usage.refetch()} />
        ) : (
          <ReadableValue value={usage.data} title="Usage" empty="No usage recorded for this provider." />
        )}
      </SettingsBlock>
      <SectionConfig id="usage" />
    </>
  );
}

export function VoiceSection() {
  return (
    <>
      <div className="settings-embed settings-embed--voice"><VoiceSettings /></div>
      <SectionConfig id="voice" />
    </>
  );
}

export function NotificationsSection() {
  return (
    <>
      <NotificationSettings />
      <SectionConfig id="notifications" />
    </>
  );
}

export function CheckinsSection() {
  return (
    <>
      <CheckInSettings />
      <SectionConfig id="checkins" />
    </>
  );
}

export function MemorySection() {
  const [preferences, setPreference] = useWebUiPreferences();
  return (
    <>
      <SettingsBlock title="In chat" description="Applies to this browser only.">
        <div className="settings-rows">
          <SettingRow
            label="Memory provenance chips"
            description="When a reply used memories, show a small chip under it that lists which ones."
            control={(
              <Toggle
                checked={preferences.memoryProvenanceChipEnabled}
                aria-label="Memory provenance chips"
                onChange={(on) => setPreference('memoryProvenanceChipEnabled', on)}
              />
            )}
          />
        </div>
      </SettingsBlock>
      <SectionConfig id="memory" />
      <MemoryDiagnostics />
    </>
  );
}

export function PermissionsSection() {
  return (
    <>
      <PermissionRules />
      <SectionConfig id="permissions" emptyText="No permission settings reported." />
    </>
  );
}

export function NetworkSection() {
  return (
    <>
      <TailscaleSettings />
      <SectionConfig id="network" />
    </>
  );
}

export function AllSettingsSection() {
  return (
    <>
      <SectionConfig id="all" emptyText="Every setting the daemon reports has a home in another section." />
      <RawConfigEditor />
    </>
  );
}

export function AboutSection({ realtimeError }: { realtimeError?: string | null }) {
  const status = useQuery({ queryKey: queryKeys.status, queryFn: () => sdk.operator.control.status() });
  const localAuth = useQuery({ queryKey: queryKeys.localAuth, queryFn: () => invokeMethod('local_auth.status') });

  return (
    <>
      <SettingsBlock title="Connection" description="How this browser reaches your daemon.">
        <div className="settings-rows" aria-live="polite" aria-label="Surface runtime status">
          <SettingRow label="Daemon origin" control={<span className="settings-row__value settings-mono">{GOODVIBES_BASE_URL}</span>} />
          <SettingRow
            label="Live updates"
            description={realtimeError ?? 'The realtime event stream is connected.'}
            control={(
              <span className="settings-row__value">
                <StatusDot tone={realtimeError ? 'warn' : 'ok'} />
                {realtimeError ? 'Degraded' : 'Listening'}
              </span>
            )}
          />
          <SettingRow label="Web app version" control={<span className="settings-row__value settings-mono">{WEBUI_VERSION ?? 'unknown'}</span>} />
        </div>
      </SettingsBlock>

      <SettingsBlock title="Daemon status">
        {status.isPending ? (
          <SkeletonBlock variant="text" lines={4} />
        ) : status.error ? (
          <ErrorState error={status.error} onRetry={() => status.refetch()} title="Daemon status unavailable" />
        ) : (
          <ReadableValue value={status.data} title="Daemon Status" />
        )}
      </SettingsBlock>

      <SettingsBlock title="Local sign-in" description="The daemon's own local account, if it has one.">
        {localAuth.isPending ? (
          <SkeletonBlock variant="text" lines={3} />
        ) : localAuth.error ? (
          <ErrorState error={localAuth.error} onRetry={() => localAuth.refetch()} title="Local auth unavailable" />
        ) : (
          <ReadableValue value={localAuth.data} title="Local Auth" />
        )}
      </SettingsBlock>
    </>
  );
}
