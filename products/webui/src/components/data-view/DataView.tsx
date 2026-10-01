/**
 * The data-view template (design doc "Data views"): every non-chat view is a
 * page header (title 20/600, one line of description, at most one primary
 * action, a filter row) over content that is a divided list, or a list and
 * detail split 400 / rest. No panel wraps the page and no panel sits inside
 * another; rows are kit Rows, chips are neutral, empty states are one icon,
 * one sentence and one action, and first loads show skeleton rows.
 *
 * The split's detail pane tells the shell a right panel is open
 * (useRightPanel), so the sidebar folds to its rail while a detail shows and
 * comes back when it closes. Under 900 wide the detail takes the full width
 * with a Back button in place of the list.
 */
import { ArrowLeft, X } from 'lucide-react';
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useRightPanel } from '../shell/ShellContext';
import { Button } from '../ui/Button';
import { Drawer } from '../ui/Drawer';
import { IconButton } from '../ui/IconButton';
import { RowList } from '../ui/Row';
import { PHONE_QUERY, useMediaQuery } from '../ui/overlay';
import '../../styles/components/data-view.css';

export interface DataPageProps {
  title: string;
  /** One line under the title. */
  description?: ReactNode;
  /** The page's one primary action (a kit Button). */
  action?: ReactNode;
  /** The filter row: a Segmented, a search Field, kit Selects. */
  filters?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** Page header plus content. The content area fills the rest of the view frame. */
export function DataPage({ title, description, action, filters, className, children }: DataPageProps) {
  const titleId = useId();
  return (
    <div className={['dv-page', className ?? ''].filter(Boolean).join(' ')} aria-labelledby={titleId} role="region">
      <header className="dv-header">
        <div className="dv-header__text">
          <h2 id={titleId} className="dv-title">{title}</h2>
          {description && <p className="dv-description">{description}</p>}
        </div>
        {action && <div className="dv-header__action">{action}</div>}
      </header>
      {filters && <div className="dv-filters">{filters}</div>}
      <div className="dv-body">{children}</div>
    </div>
  );
}

/** True inside a peek drawer: the detail pane keeps its close button on phones. */
const PeekHostContext = createContext(false);

export interface ListDetailProps {
  list: ReactNode;
  /** The detail pane's content; shown while `detailOpen`. */
  detail?: ReactNode;
  detailOpen: boolean;
  /** Close the detail (the phone Back button, Escape in the pane). */
  onCloseDetail: () => void;
  /** Accessible name of the list pane. */
  listLabel: string;
  /** Accessible name of the detail pane. */
  detailLabel: string;
  /** Back button text on phones, e.g. "All work". */
  backLabel?: string;
  /**
   * split (Work): the detail is the second pane of a 400 / rest split.
   * peek (Library, Personal): the list keeps the full width and the detail opens
   * as the right glass drawer, 440 wide, folding the sidebar to its rail; on a
   * phone it is a bottom sheet (design doc "Menus and modals").
   */
  mode?: 'split' | 'peek';
  className?: string;
}

/**
 * List and detail split, 400 / rest, or a full-width list with a peek drawer. The list pane and the detail pane scroll
 * on their own. Without a detail the list takes the full width.
 */
export function ListDetail({
  list,
  detail,
  detailOpen,
  onCloseDetail,
  listLabel,
  detailLabel,
  backLabel = 'Back',
  mode = 'split',
  className,
}: ListDetailProps) {
  const phone = useMediaQuery(PHONE_QUERY);
  const open = detailOpen && detail !== undefined && detail !== null;
  const peek = mode === 'peek';
  // The peek Drawer registers the right panel itself.
  useRightPanel(open && !phone && !peek);

  // Escape closes the detail from anywhere on the page, unless an overlay (a
  // dialog, menu, popover, drawer) is open or a field has the keyboard: those
  // keep their own Escape. It only closes a pane; it never stops work.
  const closeRef = useRef(onCloseDetail);
  useLayoutEffect(() => {
    closeRef.current = onCloseDetail;
  });
  useEffect(() => {
    if (!open || phone || peek) return undefined;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[data-gv-layer]:not(.gv-tooltip), [role="alertdialog"]')) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      closeRef.current();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, phone, peek]);

  if (peek) {
    return (
      <div className={['dv-split', 'dv-split--peek', className ?? ''].filter(Boolean).join(' ')} data-phone={phone ? '' : undefined}>
        <section className="dv-list" aria-label={listLabel}>{list}</section>
        <Drawer open={open} onClose={onCloseDetail} label={detailLabel} header={false} className="dv-peek">
          <PeekHostContext.Provider value>
            <section className="dv-detail" aria-label={detailLabel}>{detail}</section>
          </PeekHostContext.Provider>
        </Drawer>
      </div>
    );
  }

  const classes = ['dv-split', open ? 'dv-split--detail' : '', className ?? ''].filter(Boolean).join(' ');

  if (phone) {
    return (
      <div className={classes} data-phone="">
        {open ? (
          <section className="dv-detail" aria-label={detailLabel}>
            <div className="dv-detail__back">
              <Button variant="ghost" size="sm" icon={<ArrowLeft aria-hidden="true" />} onClick={onCloseDetail}>
                {backLabel}
              </Button>
            </div>
            {detail}
          </section>
        ) : (
          <section className="dv-list" aria-label={listLabel}>{list}</section>
        )}
      </div>
    );
  }

  return (
    <div className={classes}>
      <section className="dv-list" aria-label={listLabel}>{list}</section>
      {open && (
        <section className="dv-detail" aria-label={detailLabel}>
          {detail}
        </section>
      )}
    </div>
  );
}

export interface DetailPaneProps {
  title: ReactNode;
  /** One line of meta under the title. */
  meta?: ReactNode;
  /** A status line or chips beside the meta. */
  status?: ReactNode;
  /** Header actions (secondary buttons). */
  actions?: ReactNode;
  /** Tabs under the header (a kit Segmented). */
  tabs?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  /** A footer pinned to the bottom of the pane (the approve / deny buttons). */
  footer?: ReactNode;
  children?: ReactNode;
}

/** The detail pane's header (16/600 title, meta, close), optional tabs, scrolling body, footer. */
export function DetailPane({ title, meta, status, actions, tabs, onClose, closeLabel = 'Close', footer, children }: DetailPaneProps) {
  const inPeek = useContext(PeekHostContext);
  // On a phone the split shows a Back button instead; a peek sheet keeps its close.
  const phone = useMediaQuery(PHONE_QUERY) && !inPeek;
  return (
    <div className="dv-pane">
      <div className="dv-pane__header">
        <div className="dv-pane__titles">
          <h3 className="dv-pane__title">{title}</h3>
          {(Boolean(meta) || Boolean(status)) && (
            <div className="dv-pane__meta">
              {status}
              {meta && <span>{meta}</span>}
            </div>
          )}
        </div>
        {(Boolean(actions) || (Boolean(onClose) && !phone)) && (
          <div className="dv-pane__actions">
            {actions}
            {onClose && !phone && <IconButton label={closeLabel} icon={<X />} onClick={onClose} />}
          </div>
        )}
      </div>
      {tabs && <div className="dv-pane__tabs">{tabs}</div>}
      <div className="dv-pane__body">{children}</div>
      {footer && <div className="dv-pane__footer">{footer}</div>}
    </div>
  );
}

/** A labelled group of rows: a sentence-case label in --text-3, then the divided list. */
export function RowGroup({
  label,
  count,
  children,
  className,
}: {
  label: string;
  count?: number;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section className={['dv-group', className ?? ''].filter(Boolean).join(' ')} aria-labelledby={id}>
      <h3 id={id} className="dv-group__label">
        {label}
        {count !== undefined && <span className="dv-group__count">{count}</span>}
      </h3>
      <RowList aria-label={label}>{children}</RowList>
    </section>
  );
}

export interface EmptyStateProps {
  icon: ReactNode;
  /** Optional short heading; the sentence carries the meaning. */
  title?: string;
  /** One sentence: what will appear here, or what is missing and what fixes it. */
  children: ReactNode;
  /** One action (a kit Button). */
  action?: ReactNode;
  /** Status role for states that replace a feature (the mail empty state). */
  role?: 'status';
  className?: string;
}

/** A calm empty state: one icon in --text-3, one sentence, one action. */
export function EmptyState({ icon, title, children, action, role, className }: EmptyStateProps) {
  return (
    <div className={['dv-empty', className ?? ''].filter(Boolean).join(' ')} role={role}>
      <span className="dv-empty__icon" aria-hidden="true">{icon}</span>
      {title && <p className="dv-empty__title">{title}</p>}
      <p className="dv-empty__text">{children}</p>
      {action && <div className="dv-empty__action">{action}</div>}
    </div>
  );
}

/** Skeleton rows in --surface-2 for a first load (no spinners). */
export function SkeletonRows({ count = 5, label = 'Loading' }: { count?: number; label?: string }) {
  return (
    <ul className="gv-rows dv-skeleton" aria-busy="true" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="gv-row dv-skeleton__row" aria-hidden="true">
          <span className="dv-skeleton__dot" />
          <span className="dv-skeleton__text">
            <span className="dv-skeleton__bar" style={{ width: `${56 - ((i * 13) % 24)}%` }} />
            <span className="dv-skeleton__bar dv-skeleton__bar--meta" style={{ width: `${36 - ((i * 7) % 14)}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Label / value facts, label left in --text-3 and value right, divided by hairlines. */
export function Facts({ items }: { items: readonly { label: string; value: ReactNode }[] }) {
  const shown = items.filter((item) => item.value !== undefined && item.value !== null && item.value !== '');
  if (shown.length === 0) return null;
  return (
    <dl className="dv-facts">
      {shown.map((item) => (
        <div key={item.label} className="dv-facts__row">
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A disclosure: a quiet one-line summary that opens to more. */
export function Disclosure({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="dv-disclosure" open={defaultOpen || undefined}>
      <summary className="dv-disclosure__summary">{summary}</summary>
      <div className="dv-disclosure__body">{children}</div>
    </details>
  );
}

/** A code frame: hairline border, --code fill, optional label, mono text that wraps. */
export function CodeFrame({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <figure className="dv-code">
      {label && <figcaption className="dv-code__label">{label}</figcaption>}
      <pre className="dv-code__body"><code>{children}</code></pre>
    </figure>
  );
}

/** A section inside a detail pane: a 12.5 label in --text-3 over its content. */
export function DetailSection({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  const id = useId();
  return (
    <section className="dv-section" aria-labelledby={id}>
      <div className="dv-section__head">
        <h4 id={id} className="dv-section__title">{title}</h4>
        {actions && <div className="dv-section__actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
