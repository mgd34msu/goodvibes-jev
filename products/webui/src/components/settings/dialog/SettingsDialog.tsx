/**
 * The settings dialog (design doc "Menus and modals", "Settings dialog
 * sections"; deep dive "Settings dialog"). One glass dialog, 880 by 640 on
 * desktop over the scrim, a full-screen sheet on a phone.
 *
 * Left column (220): a search field, then seven pages in the sidebar's
 * nav-item style with no group headings (owner review 2026-09-30). Right
 * column: the page title, a row of jump links when the page holds more than
 * one section, then the page's own blocks, then each further section under
 * its own heading, scrolling on its own.
 * The close button sits top right; Escape closes; focus is trapped and
 * returned (the kit Dialog). On a phone the two columns become two screens:
 * the list, and a page with a back button.
 *
 * The open section lives in the URL (`?settings=<section>`, App.tsx): a link
 * opens the section's page and scrolls to it, and Back closes the dialog.
 *
 * Focus: opening the dialog focuses the page title, not the search field (no
 * focus ring greets the person). Typing a character while focus is in the nav
 * or a page (not in a field) moves it into search with that character, and
 * `/` or Ctrl+F focus search.
 */
import {
  Bell,
  BookOpen,
  Box,
  ChevronLeft,
  ChevronRight,
  Mic,
  Search,
  Settings2,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ViewId } from '../../../lib/router';
import ErrorBoundary from '../../feedback/ErrorBoundary';
import { ErrorState } from '../../feedback/ErrorState';
import { Dialog } from '../../ui/Dialog';
import { IconButton } from '../../ui/IconButton';
import { Input } from '../../ui/Field';
import { PHONE_QUERY, useMediaQuery } from '../../ui/overlay';
import { ConfigGroupList, ConfigSettingsProvider, useConfigSettings } from './ConfigSettings';
import { SettingsHeadingLevel } from './parts';
import {
  groupsForSection,
  matchSettingsPages,
  matchSettingsSections,
  pageOfSection,
  resolveSettingsSection,
  sectionsOfPage,
  settingsPage,
  settingsSection,
  type SectionMatch,
  type SettingsPageId,
  type SettingsSectionId,
} from './sections';
import { GeneralSection } from './sections/GeneralSection';
import { AccountSection } from './sections/AccountSection';
import { ModelsSection } from './sections/ModelsSection';
import {
  AboutSection,
  AllSettingsSection,
  CheckinsSection,
  CredentialsSection,
  DevicesSection,
  MemorySection,
  NetworkSection,
  NotificationsSection,
  PeopleSection,
  PermissionsSection,
  UsageSection,
  VoiceSection,
} from './sections/MoreSections';
import '../../../styles/components/settings.css';
import '../../../styles/components/settings-dialog.css';

const PAGE_ICONS: Record<SettingsPageId, ReactNode> = {
  general: <Settings2 aria-hidden="true" />,
  account: <UserRound aria-hidden="true" />,
  models: <Box aria-hidden="true" />,
  voice: <Mic aria-hidden="true" />,
  notifications: <Bell aria-hidden="true" />,
  memory: <BookOpen aria-hidden="true" />,
  permissions: <ShieldCheck aria-hidden="true" />,
};

/** The DOM id of a section's wrapper, the jump links' and deep links' target. */
function sectionDomId(id: SettingsSectionId): string {
  return `settings-section-${id}`;
}

/** True when a key press lands in a control that takes typing itself. */
function typingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  return Boolean(target.closest('[role="combobox"], [role="listbox"], [role="menu"], [role="textbox"]'));
}

export interface SettingsDialogProps {
  open: boolean;
  /** The `?settings=` value; unknown values open General. */
  section: string;
  onSectionChange: (section: SettingsSectionId) => void;
  onClose: () => void;
  /** Leave the dialog for a page (the phone node). */
  onOpenView: (view: ViewId) => void;
  realtimeError?: string | null;
}

export function SettingsDialog(props: SettingsDialogProps) {
  if (!props.open) return null;
  return (
    <ConfigSettingsProvider>
      <SettingsDialogBody {...props} />
    </ConfigSettingsProvider>
  );
}

function SettingsDialogBody({ section, onSectionChange, onClose, onOpenView, realtimeError }: SettingsDialogProps) {
  const phone = useMediaQuery(PHONE_QUERY);
  const { groups } = useConfigSettings();
  const [query, setQuery] = useState('');
  const requested = resolveSettingsSection(section);
  const requestedPage = pageOfSection(requested);
  // Phone: the list is its own screen. A link or menu entry naming a section
  // opens straight on it; the plain "Settings" entry (General) opens the list.
  const [phoneList, setPhoneList] = useState(() => requested === 'general');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);

  const sectionMatches = useMemo(() => matchSettingsSections(query, groups), [query, groups]);
  const pageMatches = useMemo(() => matchSettingsPages(sectionMatches), [sectionMatches]);
  const searching = query.trim().length > 0;
  // While a search hides the open page, show the first matching page instead.
  const activePageMatch = pageMatches.find((p) => p.id === requestedPage) ?? pageMatches[0] ?? null;
  const activePage = activePageMatch ? settingsPage(activePageMatch.id) : null;
  const visibleSections: SectionMatch[] = activePageMatch
    ? (searching ? activePageMatch.sections : sectionsOfPage(activePageMatch.id).map((s) => ({ id: s.id, whole: true, settingCount: 0 })))
    : [];
  const multi = activePage ? sectionsOfPage(activePage.id).length > 1 : false;
  const scrollTarget: SettingsSectionId | null = activePageMatch
    ? (visibleSections.some((s) => s.id === requested) ? requested : (searching ? visibleSections[0]?.id ?? null : null))
    : null;

  const selectPage = (id: SettingsPageId) => {
    // A page's id is also its first section's id.
    onSectionChange(id);
    setPhoneList(false);
  };

  // Keep the linked section at the top of the pane while the sections above it
  // finish loading and grow; let go as soon as the person scrolls, or after 2 s.
  const pinRef = useRef<SettingsSectionId | null>(null);
  const firstVisible = visibleSections[0]?.id ?? null;
  const activePageId = activePageMatch?.id ?? null;
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return undefined;
    if (!scrollTarget || scrollTarget === firstVisible) {
      pane.scrollTop = 0;
      return undefined;
    }
    pinRef.current = scrollTarget;
    const place = () => {
      const target = pinRef.current ? pane.querySelector<HTMLElement>(`#${sectionDomId(pinRef.current)}`) : null;
      if (target) pane.scrollTop = target.offsetTop - pane.offsetTop;
    };
    place();
    const release = () => { pinRef.current = null; };
    const observer = new ResizeObserver(() => { if (pinRef.current) place(); });
    if (pane.firstElementChild) observer.observe(pane.firstElementChild);
    const timer = window.setTimeout(release, 2000);
    pane.addEventListener('wheel', release, { passive: true });
    pane.addEventListener('touchstart', release, { passive: true });
    pane.addEventListener('keydown', release);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      pane.removeEventListener('wheel', release);
      pane.removeEventListener('touchstart', release);
      pane.removeEventListener('keydown', release);
    };
  }, [scrollTarget, firstVisible, activePageId, phoneList]);

  const focusSearch = (append?: string) => {
    if (phone && !phoneList) setPhoneList(true);
    if (append) setQuery((q) => q + append);
    window.requestAnimationFrame(() => searchRef.current?.focus());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || typingTarget(event.target)) return;
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === '/' || (mod && !event.altKey && event.key.toLowerCase() === 'f')) {
      event.preventDefault();
      event.stopPropagation();
      focusSearch();
      return;
    }
    if (event.key.length === 1 && event.key !== ' ' && !mod && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      focusSearch(event.key);
    }
  };

  const nav = (
    <nav className="settings-nav" aria-label="Settings sections">
      <div className="settings-search">
        <Search className="settings-search__icon" aria-hidden="true" />
        <Input
          ref={searchRef}
          type="search"
          className="gv-input--search"
          value={query}
          placeholder="Search settings"
          aria-label="Search settings"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {pageMatches.length === 0 ? (
        <p className="settings-nav__empty" role="status">No settings match “{query.trim()}”.</p>
      ) : (
        <div className="settings-nav__pages">
          {pageMatches.map((match) => {
            const page = settingsPage(match.id);
            const current = !phone && match.id === activePageMatch?.id;
            return (
              <button
                key={page.id}
                type="button"
                className="shell-nav-item settings-nav-item"
                aria-current={current ? 'page' : undefined}
                data-section={page.id}
                onClick={() => selectPage(page.id)}
              >
                <span className="shell-nav-item__icon">{PAGE_ICONS[page.id]}</span>
                <span className="shell-nav-item__label">{page.label}</span>
                {searching && match.settingCount > 0 && (
                  <span className="settings-nav-item__count" aria-label={`${match.settingCount} matching setting${match.settingCount === 1 ? '' : 's'}`}>{match.settingCount}</span>
                )}
                {phone && <ChevronRight className="settings-nav-item__chevron" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </nav>
  );

  const closeButton = (
    <IconButton ref={closeRef} label="Close" icon={<X />} onClick={onClose} noTooltip className="settings-close" />
  );

  const showList = phone && phoneList;

  return (
    <Dialog
      open
      bare
      size="large"
      title="Settings"
      className="settings-dialog"
      onClose={onClose}
      initialFocusRef={phone ? closeRef : titleRef}
    >
      {/* Not a control itself: it only catches keys bubbling up from the nav and the page, to route typing into search. */}
      <div className={showList ? 'settings-layout settings-layout--list' : 'settings-layout'} role="presentation" onKeyDown={onKeyDown}>
        {(!phone || showList) && (
          <aside className="settings-sidebar">
            {phone && (
              <div className="settings-pane-head settings-pane-head--list">
                <div className="settings-pane-head__titles">
                  <div className="settings-pane-title" aria-hidden="true">Settings</div>
                </div>
                {closeButton}
              </div>
            )}
            {nav}
          </aside>
        )}
        {!showList && (
          <div className="settings-main">
            <div className="settings-pane-head">
              {phone && (
                <IconButton label="Back to settings" icon={<ChevronLeft />} onClick={() => setPhoneList(true)} noTooltip />
              )}
              <div className="settings-pane-head__titles">
                <h2 ref={titleRef} tabIndex={-1} className="settings-pane-title">{activePage ? activePage.label : 'Settings'}</h2>
                {activePage && <p className="settings-pane-description">{activePage.description}</p>}
                {multi && visibleSections.length > 1 && (
                  <nav className="settings-jump" aria-label={`Sections in ${activePage?.label ?? 'this page'}`}>
                    {visibleSections.map((match) => (
                      <button
                        key={match.id}
                        type="button"
                        className="settings-jump__link"
                        onClick={() => {
                          onSectionChange(match.id);
                          const target = paneRef.current?.querySelector<HTMLElement>(`#${sectionDomId(match.id)}`);
                          if (target && paneRef.current) paneRef.current.scrollTop = target.offsetTop - paneRef.current.offsetTop;
                        }}
                      >
                        {settingsSection(match.id).label}
                      </button>
                    ))}
                  </nav>
                )}
              </div>
              {closeButton}
            </div>
            <div className="settings-pane" ref={paneRef} key={`${activePageMatch?.id ?? 'none'}:${searching ? 'search' : 'full'}`}>
              <div className="settings-pane__sections">
                {!activePage ? (
                  <p className="settings-empty">No settings match “{query.trim()}”.</p>
                ) : visibleSections.map((match) => {
                  const def = settingsSection(match.id);
                  const partial = searching && !match.whole;
                  const body = partial ? (
                    <>
                      <p className="settings-search-note" role="status">
                        Settings in {def.label} matching “{query.trim()}”.
                      </p>
                      <ConfigGroupList groups={groupsForSection(def.id, groups)} query={query} />
                    </>
                  ) : (
                    <ErrorBoundary
                      fallback={(err, reset) => <ErrorState error={err} title="This section failed to load" onRetry={reset} />}
                    >
                      <SectionContent id={def.id} onOpenView={onOpenView} realtimeError={realtimeError} />
                    </ErrorBoundary>
                  );
                  if (!multi) {
                    return <div key={def.id} id={sectionDomId(def.id)} className="settings-section settings-section--only">{body}</div>;
                  }
                  // The page's namesake section (same id, always first) is the page
                  // itself: its heading would only restate the page title and
                  // description just above it, so its blocks sit directly under
                  // them. The wrapper keeps its id, so the jump link and a
                  // `?settings=` deep link still land on it.
                  if (def.id === activePage.id) {
                    return <div key={def.id} id={sectionDomId(def.id)} className="settings-section settings-section--lead">{body}</div>;
                  }
                  return (
                    <section key={def.id} id={sectionDomId(def.id)} className="settings-section" aria-labelledby={`${sectionDomId(def.id)}-title`}>
                      <div className="settings-section__head">
                        <h3 id={`${sectionDomId(def.id)}-title`} className="settings-section__title">{def.label}</h3>
                        <p className="settings-section__description">{def.description}</p>
                      </div>
                      <SettingsHeadingLevel.Provider value={4}>{body}</SettingsHeadingLevel.Provider>
                    </section>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function SectionContent({
  id,
  onOpenView,
  realtimeError,
}: {
  id: SettingsSectionId;
  onOpenView: (view: ViewId) => void;
  realtimeError?: string | null;
}) {
  switch (id) {
    case 'general': return <GeneralSection />;
    case 'account': return <AccountSection />;
    case 'devices': return <DevicesSection onOpenView={onOpenView} />;
    case 'people': return <PeopleSection />;
    case 'models': return <ModelsSection />;
    case 'credentials': return <CredentialsSection />;
    case 'usage': return <UsageSection />;
    case 'voice': return <VoiceSection />;
    case 'notifications': return <NotificationsSection />;
    case 'memory': return <MemorySection />;
    case 'permissions': return <PermissionsSection />;
    case 'network': return <NetworkSection />;
    case 'all': return <AllSettingsSection />;
    case 'about': return <AboutSection realtimeError={realtimeError} />;
    case 'checkins': return <CheckinsSection />;
  }
}
