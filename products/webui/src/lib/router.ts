/**
 * router.ts, dependency-free URL state encoder/decoder
 *
 * URL schema:
 *   ?view=chat|work|library|personal|phone
 *   &tab=<tab>                    (work, library and personal: the section shown)
 *   &session=<sessionId>          (chat view only; omitted when empty)
 *   &settings=<section>           (the settings dialog is open on that section)
 *   &filter[<key>]=<value>        (per-view filters; any number of pairs)
 *
 * Old view ids keep working. Admin, Providers and Principals are sections of
 * the settings dialog: `?view=admin` decodes to the chat view with the dialog
 * open on Account, `?view=providers` on Models and providers, `?view=principals`
 * on People and channels, and the old Check-ins page `?view=checkin` on the
 * Check-ins section (LEGACY_SETTINGS_VIEWS). The thirteen data views
 * became three destinations (design doc "Navigation map"): `?view=fleet` and
 * the rest decode to their destination and tab (LEGACY_VIEW_REDIRECTS), and
 * useUrlState rewrites such a link in place, keeping its fragment (a push
 * notification's `#approval-action=…` or `#fleet-node=…` rides it).
 *
 * No react-router. Uses window.history + URLSearchParams directly.
 */

import { nonEmpty } from './non-empty';

export type ViewId =
  | 'chat'
  | 'work'
  | 'library'
  | 'personal'
  | 'phone';

/** The Work view's kind filter, plus `checkpoints` (a session's Checkpoints tab). */
export type WorkTab = 'all' | 'sessions' | 'agents' | 'processes' | 'checkpoints';
export type LibraryTab = 'memory' | 'knowledge' | 'review';
export type PersonalTab = 'calendar' | 'mail' | 'occasions';

export interface AppUrlState {
  view: ViewId;
  session: string;
  filters: Record<string, string>;
  /** The open settings dialog section; absent or '' while the dialog is closed. */
  settings?: string;
  /** The destination's tab (work, library, personal); absent or '' for the default. */
  tab?: string;
}

/** Old view ids that now open the settings dialog, and the section each opens on. */
export const LEGACY_SETTINGS_VIEWS: Readonly<Record<string, string>> = {
  admin: 'account',
  providers: 'models',
  principals: 'people',
  checkin: 'checkins',
};

/** Old data-view ids and the destination and tab each now lives on. */
export const LEGACY_VIEW_REDIRECTS: Readonly<Record<string, { view: ViewId; tab: string }>> = {
  sessions: { view: 'work', tab: 'sessions' },
  'hosted-sessions': { view: 'work', tab: 'sessions' },
  fleet: { view: 'work', tab: 'all' },
  'approvals-tasks': { view: 'work', tab: 'all' },
  workstream: { view: 'work', tab: 'processes' },
  'ci-watches': { view: 'work', tab: 'processes' },
  checkpoints: { view: 'work', tab: 'checkpoints' },
  knowledge: { view: 'library', tab: 'knowledge' },
  memory: { view: 'library', tab: 'memory' },
  calendar: { view: 'personal', tab: 'calendar' },
  mail: { view: 'personal', tab: 'mail' },
  dates: { view: 'personal', tab: 'occasions' },
};

const VALID_VIEWS: ReadonlySet<string> = new Set<ViewId>([
  'chat',
  'work',
  'library',
  'personal',
  'phone',
]);

/**
 * Resolve any view id, current or old, to where it lives now. Returns null for
 * an id the router does not know.
 */
export function resolveViewId(raw: string): { view: ViewId; tab: string } | null {
  if (VALID_VIEWS.has(raw)) return { view: raw as ViewId, tab: '' };
  return LEGACY_VIEW_REDIRECTS[raw] ?? null;
}

const DEFAULT_STATE: AppUrlState = {
  view: 'chat',
  session: '',
  filters: {},
};

const FILTER_PREFIX = 'filter[';

/** Parse the current URL (or a supplied search string) into AppUrlState. */
export function decodeUrlState(search: string = window.location.search): AppUrlState {
  const params = new URLSearchParams(search);

  const rawView = params.get('view') ?? '';
  const resolved = resolveViewId(rawView);
  const view: ViewId = resolved?.view ?? DEFAULT_STATE.view;
  const settings = nonEmpty(params.get('settings')) ?? nonEmpty(LEGACY_SETTINGS_VIEWS[rawView]) ?? '';
  const tab = nonEmpty(params.get('tab')) ?? nonEmpty(resolved?.tab) ?? '';

  const session = params.get('session') ?? '';

  const filters: Record<string, string> = {};
  params.forEach((value, key) => {
    if (key.startsWith(FILTER_PREFIX) && key.endsWith(']')) {
      const filterKey = key.slice(FILTER_PREFIX.length, -1);
      if (filterKey.length > 0) {
        filters[filterKey] = value;
      }
    }
  });

  const state: AppUrlState = { view, session, filters };
  if (settings) state.settings = settings;
  if (tab) state.tab = tab;
  return state;
}

/** True when the search string names an old view that now opens the settings dialog. */
export function isLegacySettingsView(search: string = window.location.search): boolean {
  const rawView = new URLSearchParams(search).get('view') ?? '';
  return rawView in LEGACY_SETTINGS_VIEWS;
}

/** True when the search string names an old view id the URL should be rewritten from. */
export function isLegacyView(search: string = window.location.search): boolean {
  const rawView = new URLSearchParams(search).get('view') ?? '';
  return rawView in LEGACY_SETTINGS_VIEWS || rawView in LEGACY_VIEW_REDIRECTS;
}

/** Encode AppUrlState into a URLSearchParams string (no leading '?'). */
export function encodeUrlState(state: AppUrlState): string {
  const params = new URLSearchParams();

  params.set('view', state.view);

  if (state.tab) {
    params.set('tab', state.tab);
  }

  if (state.session) {
    params.set('session', state.session);
  }

  if (state.settings) {
    params.set('settings', state.settings);
  }

  const filterKeys = Object.keys(state.filters).sort();
  for (const key of filterKeys) {
    const value = state.filters[key];
    if (value !== '') {
      params.set(`${FILTER_PREFIX}${key}]`, value);
    }
  }

  return params.toString();
}

/** Push a new history entry for the given state. */
export function pushState(state: AppUrlState): void {
  const search = encodeUrlState(state);
  const url = `${window.location.pathname}?${search}`;
  window.history.pushState(state, '', url);
}

/** Replace the current history entry with the given state. */
export function replaceState(state: AppUrlState): void {
  const search = encodeUrlState(state);
  const url = `${window.location.pathname}?${search}`;
  window.history.replaceState(state, '', url);
}

/** Read the current URL state without subscribing. */
export function getCurrentUrlState(): AppUrlState {
  return decodeUrlState(window.location.search);
}
