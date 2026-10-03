import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { writeStoreFile } from '@/utils/store-file.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { assertNoSecretLikeText } from './persona-registry.ts';
import { parseIcs, renderIcs } from './ics-calendar.ts';

// ──────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────

export interface AgentCalendarEvent {
  readonly id: string;
  readonly title: string;
  /** ISO-8601 start, YYYY-MM-DD for all-day, YYYY-MM-DDTHH:MM:SS[Z] for timed */
  readonly start: string;
  /** ISO-8601 end, optional */
  readonly end?: string;
  readonly allDay: boolean;
  readonly location?: string;
  readonly notes?: string;
  /**
   * IANA timezone identifier for timed events with a TZID-qualified DTSTART.
   * When present, `start` holds the wall-clock time in this zone (no Z suffix).
   * Undefined for UTC events (start ends with Z) and floating/all-day events.
   */
  readonly tzid?: string;
  /** Source UID from an imported .ics file */
  readonly sourceProvenance?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentCalendarEventCreateInput {
  readonly title: string;
  readonly start: string;
  readonly end?: string;
  readonly allDay?: boolean;
  readonly location?: string;
  readonly notes?: string;
  /** IANA timezone identifier, if the start time is wall-clock in a named zone */
  readonly tzid?: string;
  readonly sourceProvenance?: string;
}

export interface AgentCalendarSnapshot {
  readonly path: string;
  readonly events: readonly AgentCalendarEvent[];
}

interface CalendarStoreFile {
  readonly version: 1;
  readonly events: readonly AgentCalendarEvent[];
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

const STORE_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nowIso(): string {
  return new Date().toISOString();
}

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'event';
}

function assertNoCalendarSecretLikeText(fields: readonly string[]): void {
  try {
    assertNoSecretLikeText(fields);
  } catch {
    throw new Error('Calendar events cannot store secret-looking values. Remove the sensitive text.');
  }
}

function parseEvent(value: unknown): AgentCalendarEvent | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const title = readString(value.title).trim();
  const start = readString(value.start).trim();
  if (!id || !title || !start) return null;
  return {
    id,
    title,
    start,
    end: readString(value.end).trim() || undefined,
    allDay: value.allDay === true,
    location: readString(value.location).trim() || undefined,
    notes: readString(value.notes).trim() || undefined,
    tzid: readString(value.tzid).trim() || undefined,
    sourceProvenance: readString(value.sourceProvenance).trim() || undefined,
    createdAt: readString(value.createdAt, nowIso()),
    updatedAt: readString(value.updatedAt, nowIso()),
  };
}

function parseStore(raw: string): CalendarStoreFile {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return { version: STORE_VERSION, events: [] };
  return {
    version: STORE_VERSION,
    events: Array.isArray(parsed.events)
      ? parsed.events.map(parseEvent).filter((e): e is AgentCalendarEvent => e !== null)
      : [],
  };
}

function formatStore(store: CalendarStoreFile): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

type AgentLocalStorePaths = Pick<ShellPathService, 'resolveUserPath'>;

export function calendarStorePath(shellPaths: AgentLocalStorePaths): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'calendar', 'events.json');
}

// ──────────────────────────────────────────────────────────────────
// Registry
// ──────────────────────────────────────────────────────────────────

export class AgentCalendarRegistry {
  public constructor(private readonly storePath: string) {}

  public static fromShellPaths(shellPaths: AgentLocalStorePaths): AgentCalendarRegistry {
    return new AgentCalendarRegistry(calendarStorePath(shellPaths));
  }

  public snapshot(): AgentCalendarSnapshot {
    const store = this.readStore();
    const events = [...store.events].sort((a, b) => a.start.localeCompare(b.start));
    return { path: this.storePath, events };
  }

  public list(): readonly AgentCalendarEvent[] {
    return this.snapshot().events;
  }

  public get(id: string): AgentCalendarEvent | null {
    const lookup = id.trim().toLowerCase();
    if (!lookup) return null;
    return this.list().find((e) => e.id.toLowerCase() === lookup) ?? null;
  }

  /**
   * Return events whose start falls within the next `rangeDays` days from now.
   */
  public upcoming(rangeDays = 7): readonly AgentCalendarEvent[] {
    const now = new Date();
    const horizon = new Date(now.getTime() + rangeDays * 86_400_000);
    const nowIsoStr = now.toISOString().slice(0, 10);
    const horizonIsoStr = horizon.toISOString().slice(0, 10);
    return this.list().filter((e) => {
      // Compare lexicographically: ISO date strings sort correctly
      const start = e.allDay ? e.start : e.start.slice(0, 10);
      return start >= nowIsoStr && start <= horizonIsoStr;
    });
  }

  public create(input: AgentCalendarEventCreateInput): AgentCalendarEvent {
    const store = this.readStore();
    const title = input.title.trim();
    const start = input.start.trim();
    if (!title) throw new Error('Event title is required.');
    if (!start) throw new Error('Event start is required.');
    assertNoCalendarSecretLikeText([title, input.notes ?? '', input.location ?? '']);
    const timestamp = nowIso();
    const event: AgentCalendarEvent = {
      id: this.nextId(title, store.events),
      title,
      start,
      end: input.end?.trim() || undefined,
      allDay: input.allDay ?? !start.includes('T'),
      location: input.location?.trim() || undefined,
      notes: input.notes?.trim() || undefined,
      tzid: input.tzid?.trim() || undefined,
      sourceProvenance: input.sourceProvenance?.trim() || undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.writeStore({ ...store, events: [...store.events, event] });
    return event;
  }

  public delete(id: string): AgentCalendarEvent {
    const store = this.readStore();
    const existing = this.findInStore(store, id);
    if (!existing) throw new Error(`Unknown calendar event ${id}`);
    this.writeStore({ ...store, events: store.events.filter((e) => e.id !== existing.id) });
    return existing;
  }

  /**
   * Import events from iCalendar (.ics) text.
   *
   * Each event is individually checked:
   * - Secret-bearing events are skipped and counted in `secretSkipped` (never thrown, never imported).
   * - Duplicate events (same slug / id collision from a prior import) are skipped and counted in `skipped`.
   *
   * Returns { imported, skipped, secretSkipped } so callers can surface feedback to the user.
   */
  public importIcs(content: string): { imported: readonly AgentCalendarEvent[]; skipped: number; secretSkipped: number } {
    const icsEvents = parseIcs(content);
    const imported: AgentCalendarEvent[] = [];
    let skipped = 0;
    let secretSkipped = 0;
    for (const icsEvent of icsEvents) {
      const title = icsEvent.summary.trim();
      const notes = icsEvent.description?.trim();
      // Per-event secret scan: skip (don't abort) if secret-looking values found.
      try {
        assertNoCalendarSecretLikeText([title, notes ?? '', icsEvent.location ?? '', icsEvent.uid ?? '']);
      } catch {
        secretSkipped++;
        continue;
      }
      // Skip events whose UID was already imported (sourceProvenance dedup).
      const uid = icsEvent.uid;
      const alreadyImported = this.list().some((e) => e.sourceProvenance === uid);
      if (alreadyImported) {
        skipped++;
        continue;
      }
      try {
        const created = this.create({
          title,
          start: icsEvent.dtstart,
          end: icsEvent.dtend,
          allDay: icsEvent.allDay,
          location: icsEvent.location?.trim(),
          notes,
          tzid: icsEvent.tzid,
          sourceProvenance: uid,
        });
        imported.push(created);
      } catch {
        // Skip events that fail for any other reason.
        skipped++;
      }
    }
    return { imported, skipped, secretSkipped };
  }

  /**
   * Export events as iCalendar text.
   * @param eventIds - if provided, export only those IDs; otherwise exports all.
   * @param destPath - if provided, write to disk; throws if file already exists.
   */
  public exportIcs(eventIds?: readonly string[], destPath?: string): string {
    const all = this.list();
    const toExport = eventIds
      ? all.filter((e) => eventIds.includes(e.id))
      : all;

    const icsContent = renderIcs(
      toExport.map((e) => ({
        uid: e.sourceProvenance ?? e.id,
        summary: e.title,
        description: e.notes,
        location: e.location,
        dtstart: e.start,
        dtend: e.end,
        allDay: e.allDay,
        tzid: e.tzid,
        rrule: undefined,
      })),
    );

    if (destPath) {
      const abs = resolve(destPath);
      if (existsSync(abs)) throw new Error(`File already exists: ${abs}. Remove it or choose a different path.`);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, icsContent, 'utf-8');
    }

    return icsContent;
  }

  private nextId(title: string, events: readonly AgentCalendarEvent[]): string {
    const base = slugify(title);
    const ids = new Set(events.map((e) => e.id));
    if (!ids.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base}-${i}`;
      if (!ids.has(candidate)) return candidate;
    }
    throw new Error(`Could not allocate event id for ${title}.`);
  }

  private findInStore(store: CalendarStoreFile, id: string): AgentCalendarEvent | null {
    const lookup = id.trim().toLowerCase();
    if (!lookup) return null;
    return store.events.find((e) => e.id.toLowerCase() === lookup) ?? null;
  }

  private readStore(): CalendarStoreFile {
    if (!existsSync(this.storePath)) return { version: STORE_VERSION, events: [] };
    try {
      return parseStore(readFileSync(this.storePath, 'utf-8'));
    } catch (error) {
      throw new Error(`Could not read calendar store: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private writeStore(store: CalendarStoreFile): void {
    writeStoreFile(this.storePath, formatStore(store));
  }
}
