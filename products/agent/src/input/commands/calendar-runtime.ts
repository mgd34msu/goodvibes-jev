import { existsSync, readFileSync } from 'node:fs';
import { AgentCalendarRegistry } from '../../agent/calendar-registry.ts';
import { parseIcs } from '../../agent/ics-calendar.ts';
import { parseIcs as parseIcsHonest } from '@goodvibes-jev/engine/sdk/platform/calendar';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { parseAgentLocalLibraryArgs } from './agent-local-library-args.ts';
import { requireShellPaths } from './runtime-services.ts';
import {
  CALENDAR_SUBSCRIPTION_VERBS,
  renderSubscribedSection,
  runCalendarSubscriptionCommand,
  subscriptionRegistryForRead,
} from './calendar-subscription-runtime.ts';
import {
  fetchProviderUpcoming,
  runCalendarAccounts,
  runCalendarConnect,
  runCalendarDisconnect,
  sourceLabel,
} from './calendar-connect-runtime.ts';

/** Today's date as 'YYYY-MM-DD' (UTC), for windowed occurrence expansion. */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIsoDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Append the merged, source-labeled subscribed section to a local-events block. */
function withSubscribedSection(localBlock: string, subscribed: string): string {
  return subscribed ? `${localBlock}\n\n${subscribed}` : localBlock;
}

/**
 * F7b: the old unknown-subcommand usage line was one 13-verb run-on
 * ("list|upcoming ...|connect ...|disconnect ...|accounts|import ...|export
 * ...|add ...|delete ...|subscribe ...|unsubscribe ...|subscriptions|refresh
 * ..."), unreadable at a glance. Grouped by what each verb is FOR instead.
 */
const CALENDAR_USAGE_MESSAGE = [
  'Usage: /calendar <command>',
  '  Viewing         list | upcoming [--days N]',
  '  Connecting      connect <google|outlook> [--device] | disconnect <google|outlook> | accounts',
  '  Subscriptions   subscribe <ics-url> [--name N] [--every MIN] [--yes] | unsubscribe <name> --yes | subscriptions | refresh [name]',
  '  Local events    add --title <title> --start <ISO> --yes | delete <id> --yes | import <path> [--yes] | export [--dest <path>] [--yes]',
].join('\n');

const CALENDAR_VALUE_FLAGS = ['title', 'start', 'end', 'location', 'notes', 'dest', 'path', 'days'] as const;

function parseCalendarArgs(args: readonly string[]) {
  return parseAgentLocalLibraryArgs(args, { valueFlags: CALENDAR_VALUE_FLAGS });
}

function registryFromContext(ctx: CommandContext): AgentCalendarRegistry {
  return AgentCalendarRegistry.fromShellPaths(requireShellPaths(ctx));
}

function printError(ctx: CommandContext, error: unknown): void {
  ctx.print([
    'Error',
    `  message ${error instanceof Error ? error.message : String(error)}`,
  ].join('\n'));
}

function formatEventLine(e: { readonly id: string; readonly title: string; readonly start: string; readonly end?: string; readonly allDay: boolean; readonly location?: string }): string {
  const when = e.allDay ? e.start : e.start.slice(0, 16).replace('T', ' ');
  const loc = e.location ? `  at ${e.location}` : '';
  return `  ${e.id}  ${when}  ${e.title}${loc}`;
}

function renderEventList(events: readonly Parameters<typeof formatEventLine>[0][], path: string): string {
  if (events.length === 0) {
    return [
      'Local calendar events',
      `  store ${path}`,
      '  No events yet. Add one with /calendar add --title <title> --start <ISO> --yes',
    ].join('\n');
  }
  return [
    `Local calendar events (${events.length})`,
    `  store ${path}`,
    ...events.map(formatEventLine),
  ].join('\n');
}

export async function runCalendarRuntimeCommand(args: readonly string[], ctx: CommandContext): Promise<void> {
  const sub = (args[0] ?? 'list').toLowerCase();

  // Connected-provider verbs (OAuth). Handled before the local-store registry so a
  // connect/accounts call never touches the local .ics file.
  if (sub === 'connect' || sub === 'disconnect' || sub === 'accounts') {
    try {
      if (sub === 'connect') await runCalendarConnect(args, ctx);
      else if (sub === 'disconnect') await runCalendarDisconnect(args, ctx);
      else await runCalendarAccounts(ctx);
    } catch (error) {
      printError(ctx, error);
    }
    return;
  }

  const registry = registryFromContext(ctx);
  // A read-only subscription registry merges subscribed feed events into the
  // views below. Tolerant of a missing secret manager (seeds/occurrences read
  // only the on-disk cache), so a failure to build it never breaks local views.
  let subs: ReturnType<typeof subscriptionRegistryForRead> | null = null;
  try {
    subs = subscriptionRegistryForRead(ctx);
  } catch {
    subs = null;
  }

  try {
    // list / upcoming
    if (sub === 'list' || sub === 'all') {
      const snap = registry.snapshot();
      const local = renderEventList([...snap.events], snap.path);
      const subscribed = subs ? renderSubscribedSection(subs.seeds()) : '';
      ctx.print(withSubscribedSection(local, subscribed));
      return;
    }

    if (sub === 'upcoming') {
      const parsed = parseCalendarArgs(args.slice(1));
      const days = parsed.flags.has('days') ? Math.max(1, parseInt(parsed.flags.get('days') ?? '7', 10) || 7) : 7;
      const snap = registry.snapshot();
      const events = registry.upcoming(days);
      const local = renderEventList([...events], snap.path);
      // A9's subscribed-feed section (ics-feed source), merged read-only.
      const subscribed = subs ? renderSubscribedSection(subs.occurrencesInWindow(todayIsoDate(), addDaysIsoDate(days))) : '';
      // A10: connected-provider events (google-api / microsoft-graph), best-effort.
      const now = new Date();
      const to = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      const { events: providerEvents, notes } = await fetchProviderUpcoming(ctx, {
        timeMin: now.toISOString(),
        timeMax: to.toISOString(),
      });
      const providerLines = providerEvents.map((e) =>
        `  [${sourceLabel(e.source)}] ${e.start.value.slice(0, 16).replace('T', ' ')}  ${e.summary}${e.calendarLabel ? `  (${e.calendarLabel})` : ''}`,
      );
      const providerBlock = providerEvents.length > 0
        ? [`Connected calendars (${providerEvents.length})`, ...providerLines].join('\n')
        : '';
      const notesBlock = notes.length > 0 ? ['Notes', ...notes].join('\n') : '';
      ctx.print([withSubscribedSection(local, subscribed), providerBlock, notesBlock].filter(Boolean).join('\n\n'));
      return;
    }

    // import <path> [--yes]
    if (sub === 'import') {
      const parsed = parseCalendarArgs(args.slice(1));
      const filePath = parsed.rest[0] ?? parsed.flags.get('path');
      if (!filePath) {
        ctx.print('Usage: /calendar import <path-to-ics> [--yes]');
        return;
      }
      if (!existsSync(filePath)) {
        ctx.print(`File not found: ${filePath}`);
        return;
      }
      const content = readFileSync(filePath, 'utf-8');
      if (!parsed.yes) {
        const preview = parseIcs(content);
        ctx.print([
          'Calendar import preview',
          `  file ${filePath}`,
          `  events found ${preview.length}`,
          ...preview.slice(0, 5).map((e) => `  - ${e.summary} (${e.dtstart})`),
          preview.length > 5 ? `  ... and ${preview.length - 5} more` : '',
          '  rerun with --yes to import',
        ].filter(Boolean).join('\n'));
        return;
      }
      const { imported, skipped, secretSkipped } = registry.importIcs(content);
      // Honest recurrence/skip report from the SDK reader: events the local store
      // could not use, and recurring events whose RRULE this build does not fully
      // expand (imported as a single seed, never silently dropped or mis-expanded).
      const honest = parseIcsHonest(content);
      const unsupportedRecurring = honest.events.filter((e) => e.recurrence?.expansion === 'unsupported');
      ctx.print([
        `Imported ${imported.length} event${imported.length === 1 ? '' : 's'} from ${filePath}`,
        ...imported.slice(0, 10).map((e) => `  ${e.id}  ${e.start}  ${e.title}`),
        imported.length > 10 ? `  ... and ${imported.length - 10} more` : '',
        skipped > 0 ? `Skipped ${skipped} event${skipped === 1 ? '' : 's'} that already exist.` : '',
        secretSkipped > 0 ? `Skipped ${secretSkipped} event${secretSkipped === 1 ? '' : 's'} for safety.` : '',
        honest.skipped.length > 0 ? `Could not parse ${honest.skipped.length} entr${honest.skipped.length === 1 ? 'y' : 'ies'}: ${honest.skipped[0]?.message ?? ''}` : '',
        unsupportedRecurring.length > 0
          ? `${unsupportedRecurring.length} recurring event${unsupportedRecurring.length === 1 ? '' : 's'} imported as a single date only (recurrence not fully expanded): ${unsupportedRecurring.slice(0, 3).map((e) => e.summary).join(', ')}${unsupportedRecurring.length > 3 ? ', ...' : ''}`
          : '',
      ].filter(Boolean).join('\n'));
      return;
    }

    // export [--dest <path>] [--yes]
    if (sub === 'export') {
      const parsed = parseCalendarArgs(args.slice(1));
      const dest = parsed.flags.get('dest') ?? parsed.rest[0];
      if (!parsed.yes) {
        const events = registry.list();
        ctx.print([
          'Calendar export preview',
          `  events ${events.length}`,
          dest ? `  dest ${dest}` : '  output to stdout (no --dest given)',
          '  rerun with --yes to export',
        ].join('\n'));
        return;
      }
      const ics = registry.exportIcs(undefined, dest);
      if (!dest) {
        ctx.print(ics);
      } else {
        ctx.print(`Exported calendar to ${dest}`);
      }
      return;
    }

    // add --title <title> --start <ISO> [--end <ISO>] [--location <loc>] [--notes <notes>] --yes
    if (sub === 'add' || sub === 'create') {
      const parsed = parseCalendarArgs(args.slice(1));
      const title = parsed.flags.get('title')?.trim() ?? parsed.rest.join(' ').trim();
      const start = parsed.flags.get('start')?.trim();
      if (!title || !start) {
        ctx.print('Usage: /calendar add --title <title> --start <ISO-date-or-datetime> [--end <ISO>] [--location <loc>] [--notes <notes>] --yes');
        return;
      }
      if (!parsed.yes) {
        ctx.print([
          'Calendar event preview',
          `  title ${title}`,
          `  start ${start}`,
          parsed.flags.get('end') ? `  end   ${parsed.flags.get('end')}` : '',
          parsed.flags.get('location') ? `  location ${parsed.flags.get('location')}` : '',
          parsed.flags.get('notes') ? `  notes ${parsed.flags.get('notes')}` : '',
          '  rerun with --yes to save',
        ].filter(Boolean).join('\n'));
        return;
      }
      const event = registry.create({
        title,
        start,
        end: parsed.flags.get('end')?.trim(),
        location: parsed.flags.get('location')?.trim(),
        notes: parsed.flags.get('notes')?.trim(),
      });
      ctx.print([
        `Added calendar event ${event.id}`,
        `  id    ${event.id}`,
        `  title ${event.title}`,
        `  start ${event.start}`,
        event.end ? `  end   ${event.end}` : '',
      ].filter(Boolean).join('\n'));
      return;
    }

    // delete <id> --yes
    if (sub === 'delete' || sub === 'remove') {
      const parsed = parseCalendarArgs(args.slice(1));
      const id = parsed.rest[0];
      if (!id) {
        ctx.print('Usage: /calendar delete <id> --yes');
        return;
      }
      if (id.startsWith('sub:')) {
        const subName = id.split(':')[1] ?? 'a subscription';
        ctx.print(`Cannot delete ${id}: it is a read-only event from the '${subName}' subscription. Edit it in the source calendar, or run /calendar unsubscribe ${subName} --yes to remove the whole feed.`);
        return;
      }
      if (!parsed.yes) {
        const event = registry.get(id);
        if (!event) {
          ctx.print(`Unknown calendar event ${id}`);
          return;
        }
        ctx.print([
          `Delete calendar event preview`,
          `  id    ${event.id}`,
          `  title ${event.title}`,
          `  start ${event.start}`,
          '  rerun with --yes to delete',
        ].join('\n'));
        return;
      }
      const removed = registry.delete(id);
      ctx.print(`Deleted calendar event ${removed.id}  ${removed.title}`);
      return;
    }

    ctx.print(CALENDAR_USAGE_MESSAGE);
  } catch (error) {
    printError(ctx, error);
  }
}

export function registerCalendarRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'calendar',
    aliases: ['cal'],
    description: 'Manage local calendar events, external calendar subscriptions, and connected calendar accounts',
    usage: '[list|upcoming [--days N]|connect <google|outlook> [--device]|disconnect <google|outlook>|accounts|import <path> [--yes]|export [--dest <path>] [--yes]|add --title <title> --start <ISO> [--end <ISO>] [--location <loc>] [--notes <notes>] --yes|delete <id> --yes|subscribe <ics-url> [--name N] [--every MIN] [--yes]|unsubscribe <name> --yes|subscriptions|refresh [name]]',
    handler: async (args: readonly string[], ctx: CommandContext) => {
      const sub = (args[0] ?? 'list').toLowerCase();
      if (CALENDAR_SUBSCRIPTION_VERBS.has(sub)) {
        await runCalendarSubscriptionCommand(sub, args.slice(1), ctx);
        return;
      }
      await runCalendarRuntimeCommand(args, ctx);
    },
  });
}
