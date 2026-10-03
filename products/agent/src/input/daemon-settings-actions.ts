import type { CommandContext } from './command-registry.ts';
import type { SelectionItem } from './selection-modal.ts';

/** Selecting this item clears daemon.timezone back to '' (UTC). */
const UTC_UNSET_ID = '__daemon_timezone_utc_unset__';

/**
 * A picker over every IANA zone name Intl actually recognizes on this host,
 * plus an explicit unset option, never a free-text field, so a typo can't
 * silently produce an invalid zone the daemon then fails to parse.
 */
export function openDaemonTimezonePicker(ctx: CommandContext): boolean {
  if (!ctx.openSelection) return false;

  const current = String(ctx.platform.configManager.get('daemon.timezone') ?? '').trim();
  const zones = Intl.supportedValuesOf('timeZone');

  const items: SelectionItem[] = [
    {
      id: UTC_UNSET_ID,
      label: 'UTC (unset)',
      detail: current === '' ? '(current)' : 'clears daemon.timezone',
      category: 'timezone',
      primaryAction: 'select',
      actions: '[Enter] set timezone',
    },
    ...zones.map((zone) => ({
      id: zone,
      label: zone,
      detail: zone === current ? `${zone}  (current)` : zone,
      category: 'IANA timezones',
      primaryAction: 'select' as const,
      actions: '[Enter] set timezone',
    })),
  ];

  ctx.openSelection('Choose Daemon Timezone', items, { preSelectId: current || UTC_UNSET_ID, allowSearch: true }, (result) => {
    if (!result) return;
    const nextZone = result.item.id === UTC_UNSET_ID ? '' : result.item.id;
    ctx.platform.configManager.setDynamic('daemon.timezone', nextZone);
    ctx.print(nextZone ? `Daemon timezone set to ${nextZone}.` : 'Daemon timezone cleared (UTC).');
    ctx.renderRequest();
  });
  return true;
}
