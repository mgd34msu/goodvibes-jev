/**
 * Calendar subscribe wizard, the "Calendar workflows" card's real
 * connect flow. Subscribes to an external calendar by its iCalendar feed URL
 * (Google "secret address", Outlook published .ics, or any .ics URL), READ-ONLY.
 *
 * Security: the feed URL is secrets-adjacent, a Google secret address grants
 * read access to the whole calendar, so this follows the email-connect wizard's
 * pattern EXACTLY: it is a DIRECT host action (not a slash-command string), so the
 * URL never flows through the generic dispatch pipeline that echoes command text
 * back into the workspace UI (which would render the secret). The URL is persisted
 * ONLY through the secret manager (CalendarSubscriptionRegistry stores it under a
 * per-subscription secret key; the on-disk store holds the key, never the URL) and
 * the field is masked (`redact: true`). Validation fetches the feed BEFORE saving
 * and names the failing stage honestly (fetch vs parse); the URL/name are kept so
 * nothing is retyped.
 */
import type { CommandContext } from './command-registry.ts';
import { isAffirmative } from './agent-workspace-editors.ts';
import { subscriptionRegistryForWrite } from './commands/calendar-subscription-runtime.ts';
import type { CalendarSubscriptionRegistry } from '../agent/calendar-subscription-registry.ts';
import { buildAgentWorkspaceRuntimeSnapshot } from './agent-workspace-snapshot.ts';
import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor, AgentWorkspaceRuntimeSnapshot } from './agent-workspace-types.ts';

type FieldReader = (id: string) => string;

export interface AgentWorkspaceCalendarSubscribeEditorHost {
  localEditor: AgentWorkspaceLocalEditor | null;
  runtimeSnapshot: AgentWorkspaceRuntimeSnapshot | null;
  status: string;
  lastActionResult: AgentWorkspaceActionResult | null;
}

/** Fields in wizard-step order. The URL is masked and secrets-adjacent. */
export function createCalendarSubscribeWizardEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'calendar-subscribe-wizard',
    mode: 'create',
    title: 'Subscribe to a Calendar',
    selectedFieldIndex: 0,
    message: [
      'Subscribe to an external calendar by its iCalendar (.ics) feed URL, read-only, merged into /calendar.',
      'Google: Settings → your calendar → "Secret address in iCal format", copy that URL.',
      'Outlook: Settings → Calendar → Shared calendars → Publish → copy the ICS link.',
      'Any .ics URL works too. The URL is stored through the Agent secret manager (a secret address grants read access), and validated by fetching before it is saved.',
    ].join('\n'),
    fields: [
      { id: 'url', label: 'Feed URL', value: '', required: true, multiline: false, hint: 'The .ics feed URL. Stored as a secret; masked here and never rendered in results.', redact: true },
      { id: 'name', label: 'Name', value: '', required: false, multiline: false, hint: 'Optional. Left blank, the calendar\'s own name is used.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to validate the feed and subscribe.' },
    ],
  };
}

/** Injectable for tests, production callers omit it and get the real registry (real HTTP fetch). */
export type CalendarSubscribeRegistryBuilder = (context: CommandContext) => CalendarSubscriptionRegistry | null;

const defaultRegistryBuilder: CalendarSubscribeRegistryBuilder = (context) => subscriptionRegistryForWrite(context);

export async function submitAgentWorkspaceCalendarSubscribeWizardEditor(
  host: AgentWorkspaceCalendarSubscribeEditorHost,
  editor: AgentWorkspaceLocalEditor,
  context: CommandContext | null,
  readField: FieldReader,
  buildRegistry: CalendarSubscribeRegistryBuilder = defaultRegistryBuilder,
): Promise<void> {
  if (!isAffirmative(readField('confirm'))) {
    host.localEditor = { ...editor, message: 'Calendar subscription not confirmed. Type yes, then press Enter.' };
    host.status = 'Calendar subscription not confirmed.';
    return;
  }
  if (!context) {
    const detail = 'This runtime has no command context; cannot subscribe to a calendar.';
    host.localEditor = { ...editor, message: detail };
    host.status = 'Calendar subscribe unavailable.';
    host.lastActionResult = { kind: 'error', title: 'Calendar subscribe unavailable', detail, safety: 'safe' };
    return;
  }

  const url = readField('url').trim();
  if (!url) {
    const detail = 'A feed URL is required.';
    host.localEditor = { ...editor, message: detail };
    host.status = detail;
    host.lastActionResult = { kind: 'error', title: 'Calendar subscribe incomplete', detail, safety: 'safe' };
    return;
  }
  const requestedName = readField('name').trim() || undefined;

  try {
    const registry = buildRegistry(context);
    if (!registry) {
      const detail = 'No secret manager is available in this runtime, and a feed URL is stored only as a secret. Cannot subscribe.';
      host.localEditor = { ...editor, message: detail };
      host.status = 'Calendar subscribe unavailable.';
      host.lastActionResult = { kind: 'error', title: 'Calendar subscribe unavailable', detail, safety: 'safe' };
      return;
    }

    const result = await registry.subscribe(url, requestedName);
    if (!result.ok) {
      // Settings kept so the URL/name are not retyped; the stage is named honestly.
      host.localEditor = { ...editor, message: `Could not subscribe (${result.stage} stage): ${result.detail}` };
      host.status = `Calendar subscription failed (${result.stage}).`;
      host.lastActionResult = {
        kind: 'error',
        title: 'Calendar subscription failed',
        detail: `Could not subscribe at the ${result.stage} stage: ${result.detail}. The URL was not saved, fix it above and try again.`,
        safety: 'safe',
      };
      return;
    }

    host.localEditor = null;
    host.status = `Subscribed to ${result.name}.`;
    host.lastActionResult = {
      kind: 'refreshed',
      title: 'Calendar subscribed',
      detail: `Subscribed to '${result.name}' (${result.eventCount} events, refresh every ${Math.round(result.refreshIntervalMs / 60000)} min). These events are read-only and appear source-labeled in /calendar.`,
      safety: 'safe',
    };
    host.runtimeSnapshot = buildAgentWorkspaceRuntimeSnapshot(context);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    host.localEditor = { ...editor, message: detail };
    host.status = detail;
    host.lastActionResult = { kind: 'error', title: 'Calendar subscribe failed', detail, safety: 'safe' };
  }
}
