/**
 * Navigation map (design doc "Navigation map").
 *
 * Thirteen-plus top-level views became four sidebar destinations. Chat is the
 * first; Work, Library and Personal are views of their own, each switching its
 * sections with its own segmented control (the old view ids redirect to a
 * destination and tab, see LEGACY_VIEW_REDIRECTS in lib/router.ts). Admin,
 * Providers and Principals are sections of the settings dialog; the phone-node
 * page and Check-ins are pages reached from the settings dialog and the
 * account menu.
 */
import type { LibraryTab, PersonalTab, ViewId, WorkTab } from '../../lib/router';

export type DestinationId = 'chat' | 'work' | 'library' | 'personal' | 'account';

export interface DestinationTab<T extends string = string> {
  tab: T;
  label: string;
}

export interface Destination<T extends string = string> {
  id: 'work' | 'library' | 'personal';
  label: string;
  /** The view a click on the destination opens. */
  view: ViewId;
  /** One line under the page title. */
  description: string;
  tabs: readonly DestinationTab<T>[];
}

export const WORK: Destination<WorkTab> = {
  id: 'work',
  label: 'Work',
  view: 'work',
  description: 'What is running for you, and what needs you',
  tabs: [
    { tab: 'all', label: 'All' },
    { tab: 'sessions', label: 'Sessions' },
    { tab: 'agents', label: 'Agents' },
    { tab: 'processes', label: 'Processes' },
  ],
};

export const LIBRARY: Destination<LibraryTab> = {
  id: 'library',
  label: 'Library',
  view: 'library',
  description: 'What GoodVibes remembers and knows',
  tabs: [
    { tab: 'memory', label: 'Memory' },
    { tab: 'knowledge', label: 'Knowledge' },
    { tab: 'review', label: 'Review' },
  ],
};

export const PERSONAL: Destination<PersonalTab> = {
  id: 'personal',
  label: 'Personal',
  view: 'personal',
  description: 'Your calendar, mail and the occasions GoodVibes keeps track of',
  tabs: [
    { tab: 'calendar', label: 'Calendar' },
    { tab: 'mail', label: 'Mail' },
    { tab: 'occasions', label: 'Occasions' },
  ],
};

export const DESTINATIONS: readonly Destination[] = [WORK, LIBRARY, PERSONAL];

/** Pages outside the destinations: the phone node (from Settings, Account, Devices and pairing). */
export const ACCOUNT_VIEWS: readonly { view: ViewId; label: string }[] = [
  { view: 'phone', label: 'Phone node' },
];

/** Which sidebar destination owns a view. */
export function destinationOf(view: ViewId): DestinationId {
  if (view === 'chat') return 'chat';
  return DESTINATIONS.find((d) => d.view === view)?.id ?? 'account';
}

export function destinationById(id: DestinationId): Destination | undefined {
  return DESTINATIONS.find((d) => d.id === id);
}

/** The destination's tab for a URL tab value: the value when it names one, else the first tab. */
export function resolveTab<T extends string>(destination: Destination<T>, tab: string | undefined): T {
  const match = destination.tabs.find((t) => t.tab === tab);
  return (match ?? destination.tabs[0]).tab;
}

/** The page title the header shows for a view. */
export function viewTitle(view: ViewId): string {
  if (view === 'chat') return 'Chat';
  const destination = DESTINATIONS.find((d) => d.view === view);
  if (destination) return destination.label;
  return ACCOUNT_VIEWS.find((entry) => entry.view === view)?.label ?? 'GoodVibes';
}
