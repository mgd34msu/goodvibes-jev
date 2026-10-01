/**
 * The settings dialog's section map (design doc "Navigation map", "Settings
 * dialog sections"). Pure data and search logic, no React.
 *
 * Seven pages in the nav (owner review 2026-09-30: the long nav felt cramped),
 * each holding one or more sections that render one under another: General
 * (appearance and behavior, network, about, advanced), Account (sign-in,
 * devices and pairing, people and channels), Models and providers (models,
 * credentials, usage), Voice, Notifications (with check-ins), Memory and
 * Permissions. A page's namesake section (the one sharing its id, always
 * first) renders under the page title with no heading of its own, since that
 * heading would only restate the page; every further section carries its own
 * heading. A `?settings=<section>` link opens the section's page and scrolls
 * to it, so every older section link still works.
 *
 * Every SDK config namespace belongs to exactly one section: the section that
 * lists it in `namespaces`, else "All settings", which also holds namespaces
 * the daemon reports that this build has never heard of. So a schema key is
 * never unreachable, and moving a namespace between sections is a one-line
 * change here.
 *
 * Search matches a section on its label, its keywords, or the names of the
 * hand-built settings it shows (`items`), and separately counts the schema
 * settings inside it that match (settings-model.ts's filterSettingsModel).
 */
import type { SettingsGroupModel } from '../../../lib/settings-model';
import { filterSettingsModel } from '../../../lib/settings-model';

export type SettingsSectionId =
  | 'general'
  | 'account'
  | 'devices'
  | 'people'
  | 'models'
  | 'credentials'
  | 'usage'
  | 'voice'
  | 'notifications'
  | 'memory'
  | 'permissions'
  | 'network'
  | 'all'
  | 'about'
  | 'checkins';

/** The seven pages the nav lists. Each page's id is also its first section's id. */
export type SettingsPageId = 'general' | 'account' | 'models' | 'voice' | 'notifications' | 'memory' | 'permissions';

export interface SettingsPageDef {
  id: SettingsPageId;
  label: string;
  /** One line under the page title. */
  description: string;
}

export const SETTINGS_PAGES: readonly SettingsPageDef[] = [
  { id: 'general', label: 'General', description: 'How GoodVibes looks and behaves, how devices reach it, and every other setting.' },
  { id: 'account', label: 'Account', description: 'How this browser signs in, your paired devices, and the people behind each channel.' },
  { id: 'models', label: 'Models and providers', description: 'The model new chats use, the providers and credentials behind it, and what it costs.' },
  { id: 'voice', label: 'Voice', description: 'Dictation, spoken replies and the wake word.' },
  { id: 'notifications', label: 'Notifications', description: 'Push notifications, install, occasion reminders and check-ins.' },
  { id: 'memory', label: 'Memory', description: 'What GoodVibes remembers, how it tidies it up, and the daemon\'s memory use.' },
  { id: 'permissions', label: 'Permissions', description: 'Approval rules, the sandbox and tool policy.' },
];

export interface SettingsSectionDef {
  id: SettingsSectionId;
  /** The section's heading inside its page, and its name in search. */
  label: string;
  /** The page that holds the section. */
  page: SettingsPageId;
  /** One line under the section heading. */
  description: string;
  /** Config namespaces rendered in this section, in order. */
  namespaces: readonly string[];
  /** Extra search words. */
  keywords: readonly string[];
  /** Names of the hand-built settings the section shows, searchable. */
  items: readonly string[];
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  {
    id: 'general',
    label: 'Appearance and behavior',
    page: 'general',
    description: 'Appearance and how GoodVibes behaves on this browser.',
    namespaces: ['display', 'ui', 'behavior', 'daemon', 'update', 'release', 'diagnostics'],
    keywords: ['appearance', 'theme', 'dark', 'light', 'neon', 'density', 'compact', 'timezone'],
    items: ['Theme', 'GoodVibes Neon', 'Density', 'Language', 'Line numbers in code blocks'],
  },
  {
    id: 'account',
    label: 'Sign-in',
    page: 'account',
    description: 'How this browser signs in to your daemon, and what it knows about you.',
    namespaces: ['profile', 'email', 'calendar', 'google'],
    keywords: ['sign in', 'login', 'password', 'token', 'auth', 'passkey', 'step-up', 'profile', 'mail', 'calendar', 'admin'],
    items: ['Sign in', 'Operator token', 'Current sign-in', 'Step-up verification', 'Owner profile', 'Mail and calendar accounts'],
  },
  {
    id: 'devices',
    label: 'Devices and pairing',
    page: 'account',
    description: 'Paired devices, their tokens, and this computer\'s power.',
    namespaces: ['device', 'surfaces', 'fleet', 'cluster', 'power'],
    keywords: ['pair', 'pairing', 'phone', 'device', 'qr', 'revoke', 'keep awake', 'sleep', 'slack', 'discord', 'telegram'],
    items: ['Paired devices', 'Power', 'This browser as a phone node'],
  },
  {
    id: 'people',
    label: 'People and channels',
    page: 'account',
    description: 'Who a channel message belongs to, and each channel\'s defaults.',
    namespaces: [],
    keywords: ['principals', 'identity', 'channel', 'binding', 'profiles'],
    items: ['Principals', 'Channel profiles'],
  },
  {
    id: 'models',
    label: 'Current model and providers',
    page: 'models',
    description: 'The model new chats use, and the providers that serve it.',
    namespaces: ['provider', 'pricing', 'cache'],
    keywords: ['model', 'provider', 'llm', 'ai', 'route', 'context', 'price', 'openai', 'anthropic'],
    items: ['Current model', 'Providers', 'Models', 'Sign-in routes', 'Browse models'],
  },
  {
    id: 'credentials',
    label: 'Credentials',
    page: 'models',
    description: 'What the daemon\'s credential store holds, and the accounts behind each provider.',
    namespaces: ['atRest'],
    keywords: ['secret', 'key', 'api key', 'subscription', 'accounts', 'store'],
    items: ['Credential status', 'Accounts and subscriptions'],
  },
  {
    id: 'usage',
    label: 'Usage',
    page: 'models',
    description: 'What each provider has used, budgets, and payments.',
    namespaces: ['payments', 'telemetry', 'batch'],
    keywords: ['usage', 'cost', 'spend', 'budget', 'payment', 'card', 'tokens'],
    items: ['Provider usage'],
  },
  {
    id: 'voice',
    label: 'Voice',
    page: 'voice',
    description: 'Dictation, spoken replies and the wake word.',
    namespaces: ['voice', 'tts'],
    keywords: ['speech', 'microphone', 'mic', 'dictation', 'wake', 'stt', 'tts'],
    items: ['Voice input', 'Wake word'],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    page: 'notifications',
    description: 'Push notifications, install and occasion reminders.',
    namespaces: ['notifications', 'push', 'occasions'],
    keywords: ['push', 'install', 'alert', 'reminder'],
    items: ['Push notifications', 'Install'],
  },
  {
    id: 'checkins',
    label: 'Check-ins',
    page: 'notifications',
    description: 'GoodVibes looks in on you on a schedule and tells you what is worth knowing.',
    namespaces: ['checkin'],
    keywords: ['check-in', 'checkin', 'proactive', 'schedule', 'quiet hours', 'cadence'],
    items: ['Check-in settings', 'Run check-in now', 'Recent receipts'],
  },
  {
    id: 'memory',
    label: 'Memory',
    page: 'memory',
    description: 'What GoodVibes remembers, how it tidies it up, and the daemon\'s memory use.',
    namespaces: ['memory', 'learning'],
    keywords: ['provenance', 'consolidation', 'remember', 'recall', 'diagnostics'],
    items: ['Memory provenance chips', 'Memory diagnostics'],
  },
  {
    id: 'permissions',
    label: 'Permissions',
    page: 'permissions',
    description: 'Approval rules, the sandbox and tool policy.',
    namespaces: ['permissions', 'sandbox', 'policy', 'security', 'danger', 'tools', 'conversationGate', 'fetch'],
    keywords: ['approval', 'approve', 'allow', 'deny', 'sandbox', 'policy', 'safety'],
    items: [],
  },
  {
    id: 'network',
    label: 'Network',
    page: 'general',
    description: 'How devices reach your daemon: Tailscale, the relay and the listeners.',
    namespaces: ['network', 'relay', 'httpListener', 'controlPlane', 'web', 'cloudflare', 'service'],
    keywords: ['tailscale', 'https', 'serve', 'lan', 'relay', 'port', 'listener'],
    items: ['Tailscale'],
  },
  {
    id: 'all',
    label: 'Advanced',
    page: 'general',
    description: 'Every other daemon setting, and a raw editor for keys the schema does not know.',
    namespaces: [],
    keywords: ['all settings', 'config', 'raw', 'key', 'schema'],
    items: ['Advanced: unschema\'d keys'],
  },
  {
    id: 'about',
    label: 'About',
    page: 'general',
    description: 'Your daemon, this browser\'s connection to it, and local sign-in.',
    namespaces: [],
    keywords: ['version', 'status', 'daemon', 'origin', 'realtime', 'diagnostics'],
    items: ['Daemon status', 'Connection', 'Local sign-in'],
  },
];

const SECTION_BY_ID = new Map(SETTINGS_SECTIONS.map((s) => [s.id, s]));
const PAGE_BY_ID = new Map(SETTINGS_PAGES.map((p) => [p.id, p]));

/** The order sections render in on their page. */
const PAGE_SECTION_ORDER: Readonly<Record<SettingsPageId, readonly SettingsSectionId[]>> = {
  general: ['general', 'network', 'about', 'all'],
  account: ['account', 'devices', 'people'],
  models: ['models', 'credentials', 'usage'],
  voice: ['voice'],
  notifications: ['notifications', 'checkins'],
  memory: ['memory'],
  permissions: ['permissions'],
};

export function settingsPage(id: SettingsPageId): SettingsPageDef {
  return PAGE_BY_ID.get(id) ?? SETTINGS_PAGES[0];
}

/** The page a section lives on. */
export function pageOfSection(id: SettingsSectionId): SettingsPageId {
  return settingsSection(id).page;
}

/** A page's sections, in the order they render. */
export function sectionsOfPage(id: SettingsPageId): SettingsSectionDef[] {
  return PAGE_SECTION_ORDER[id].map((sectionId) => settingsSection(sectionId));
}

/** Old or alternate section names that deep links may carry. */
const SECTION_ALIASES: Readonly<Record<string, SettingsSectionId>> = {
  admin: 'account',
  providers: 'models',
  principals: 'people',
  pairing: 'devices',
  advanced: 'all',
  checkin: 'checkins',
};

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'general';

/** The section a `?settings=` value names; unknown values open General. */
export function resolveSettingsSection(raw: string | null | undefined): SettingsSectionId {
  const key = (raw ?? '').trim();
  if (SECTION_BY_ID.has(key as SettingsSectionId)) return key as SettingsSectionId;
  return SECTION_ALIASES[key] ?? DEFAULT_SETTINGS_SECTION;
}

export function settingsSection(id: SettingsSectionId): SettingsSectionDef {
  return SECTION_BY_ID.get(id) ?? SETTINGS_SECTIONS[0];
}

const NAMESPACE_OWNER = new Map<string, SettingsSectionId>();
for (const section of SETTINGS_SECTIONS) {
  for (const ns of section.namespaces) NAMESPACE_OWNER.set(ns, section.id);
}

/** The section that renders a config namespace ("All settings" for the rest). */
export function sectionForNamespace(namespace: string): SettingsSectionId {
  return NAMESPACE_OWNER.get(namespace) ?? 'all';
}

/** The config groups a section renders, in its declared order ("All settings": everything unclaimed). */
export function groupsForSection(id: SettingsSectionId, groups: readonly SettingsGroupModel[]): SettingsGroupModel[] {
  if (id === 'all') return groups.filter((g) => !NAMESPACE_OWNER.has(g.id));
  const order = settingsSection(id).namespaces;
  return order
    .map((ns) => groups.find((g) => g.id === ns))
    .filter((g): g is SettingsGroupModel => Boolean(g));
}

export interface SectionMatch {
  id: SettingsSectionId;
  /** The label, a keyword or a hand-built setting matched: show the whole section. */
  whole: boolean;
  /** How many schema settings in the section match the query. */
  settingCount: number;
}

function countSettings(groups: readonly SettingsGroupModel[]): number {
  return groups.reduce(
    (n, g) => n + g.plainRows.length + g.rawRows.length
      + g.featureUnits.reduce((m, u) => m + Math.max(1, u.fields.length), 0),
    0,
  );
}

/**
 * Sections that match a search query, in nav order. With an empty query every
 * section matches whole. `groups` is the full config model (possibly empty
 * while config is loading or refused, then only labels and words match).
 */
export function matchSettingsSections(query: string, groups: readonly SettingsGroupModel[]): SectionMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return SETTINGS_SECTIONS.map((s) => ({ id: s.id, whole: true, settingCount: 0 }));
  const out: SectionMatch[] = [];
  for (const section of SETTINGS_SECTIONS) {
    const words = [section.label, ...section.keywords, ...section.items].map((w) => w.toLowerCase());
    const whole = words.some((w) => w.includes(q));
    const filtered = filterSettingsModel(groupsForSection(section.id, groups), q);
    const settingCount = countSettings(filtered);
    if (whole || settingCount > 0) out.push({ id: section.id, whole, settingCount });
  }
  return out;
}

export interface PageMatch {
  id: SettingsPageId;
  /** The page's sections that match, in render order. */
  sections: SectionMatch[];
  /** Matching schema settings across the page. */
  settingCount: number;
}

/** Pages with at least one matching section, in nav order, from section matches. */
export function matchSettingsPages(matches: readonly SectionMatch[]): PageMatch[] {
  const byId = new Map(matches.map((m) => [m.id, m]));
  const out: PageMatch[] = [];
  for (const page of SETTINGS_PAGES) {
    const sections = PAGE_SECTION_ORDER[page.id]
      .map((id) => byId.get(id))
      .filter((m): m is SectionMatch => Boolean(m));
    if (sections.length === 0) continue;
    out.push({ id: page.id, sections, settingCount: sections.reduce((n, m) => n + m.settingCount, 0) });
  }
  return out;
}
