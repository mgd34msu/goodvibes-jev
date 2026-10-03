import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import {
  MAX_SETTING_LIMIT,
  countHarnessSettingCatalog,
  harnessSettingQueryRelaxed,
  listEffectiveHarnessSettings,
} from '../agent/harness-control.ts';
import { settingDomainRelatedCommand } from '../config/settings-search-vocabulary.ts';
import { settingsPolicySummary } from './agent-harness-metadata.ts';
import { CATALOG_QUERIES } from './agent-harness-catalog-filters.ts';
import { catalogEnvelope, catalogFilters, readLimit, readString } from './agent-harness-tool-utils.ts';
import type { AgentHarnessToolArgs } from './agent-harness-tool-types.ts';

/**
 * The `settings` catalog page, with the count of what matched beside it.
 *
 * This mode used to return `{ settings, returned, total }` built by hand, with
 * the page ceiling wired to the shared 500 that the settings catalog had almost
 * outgrown. A page that stopped at the ceiling was indistinguishable from the
 * complete catalog, so a real setting past the cut read as a setting that does
 * not exist. It now takes the settings-specific ceiling and goes out through
 * {@link catalogEnvelope}, which states in words when the page is short of
 * `total` and how to ask for the rest.
 *
 * `total` is the size of the catalog the filters name, NOT the number that
 * matched the query. It used to be the latter, which is how a search for
 * "spending limit" answered `{"settings": [], "returned": 0, "total": 0}`, a
 * page that says zero settings exist, from a schema holding 572 of them, 32 of
 * them about payments. `returned` says how many matched; `total` says how many
 * there are; the envelope's own sentence says which filter emptied the page.
 */
export async function harnessSettingsCatalog(
  configManager: ConfigManager,
  args: AgentHarnessToolArgs,
): Promise<Record<string, unknown>> {
  const filters = {
    category: readString(args.category) || undefined,
    prefix: readString(args.prefix) || undefined,
    query: readString(args.query) || undefined,
    includeHidden: args.includeHidden === true,
    limit: readLimit(args.limit, MAX_SETTING_LIMIT, MAX_SETTING_LIMIT),
  };
  // Ownership-aware: daemon-owned keys carry the DAEMON's live value.
  const settings = await listEffectiveHarnessSettings(configManager, { ...filters }, {
    includeParameters: args.includeParameters === true,
  });
  const related = relatedSettingCommands(settings);
  return {
    ...catalogEnvelope(
      'settings',
      settings,
      countHarnessSettingCatalog(configManager, filters),
      catalogFilters(args, CATALOG_QUERIES.settings.filters),
      CATALOG_QUERIES.settings.discovery,
      { relaxedQuery: harnessSettingQueryRelaxed(configManager, filters) },
    ),
    ...(related.length > 0 ? { relatedCommands: related } : {}),
    policy: settingsPolicySummary(),
  };
}

/**
 * The guided flows for the domains on this page.
 *
 * Some of what a domain needs cannot be a setting: the card number behind
 * `payments.*` is typed at a local terminal through a masked prompt and stored
 * write-only. A page of payment settings that never mentions `/payments card`
 * leaves a reader concluding the platform cannot take a card at all, which is
 * how the live failure ended.
 */
function relatedSettingCommands(
  settings: readonly { readonly key?: unknown }[],
): readonly Record<string, string>[] {
  const seen = new Map<string, Record<string, string>>();
  for (const setting of settings) {
    const key = typeof setting.key === 'string' ? setting.key : '';
    const related = key ? settingDomainRelatedCommand(key) : undefined;
    if (!related || seen.has(related.command)) continue;
    seen.set(related.command, {
      command: related.command,
      why: related.why,
      modelRoute: `agent_harness mode:"run_command" commandName:"${related.command.replace(/^\//, '').split(' ')[0]}"`,
    });
  }
  return Array.from(seen.values());
}
