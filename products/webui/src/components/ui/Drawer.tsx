import { X } from 'lucide-react';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useRightPanel } from '../shell/ShellContext';
import { IconButton } from './IconButton';
import { PHONE_QUERY, useMediaQuery, useModalFocus, useOverlayLayer, useTopLayerEscape } from './overlay';
import '../../styles/components/ui.css';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  side?: 'left' | 'right';
  /** Accessible name; also the header title when `title` is not given. */
  label: string;
  title?: ReactNode;
  /** Panel width in px (right peek drawers are 440). A CSS length is also accepted. */
  width?: number | string;
  /**
   * Modal drawers sit over the scrim and trap focus (the phone navigation drawer).
   * Non-modal drawers leave the page usable (a right-side peek on desktop). A right
   * drawer on a phone is always modal: it becomes a bottom sheet over the scrim.
   */
  modal?: boolean;
  /** Render the default header (title and close button). */
  header?: boolean;
  className?: string;
  /** Test hook on the panel. */
  'data-testid'?: string;
  children: ReactNode;
}

/**
 * Side drawer on glass. A right drawer is the peek surface (mail message, calendar
 * event, memory record, knowledge item): 440 wide on desktop, it tells the shell a
 * right panel is open so the sidebar folds to its rail; on a phone it is a bottom
 * sheet with a grabber and 20 top radius over the scrim.
 *
 * Focus moves into the panel on open and returns to the opener on close. Tab wraps
 * inside the panel. Escape closes it when it is the top overlay, from anywhere on
 * the page, and never reaches anything underneath (a running turn included).
 */
export function Drawer({
  open,
  onClose,
  side = 'right',
  label,
  title,
  width = side === 'right' ? 440 : '85%',
  modal: modalProp,
  header = true,
  className,
  'data-testid': testId,
  children,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const phone = useMediaQuery(PHONE_QUERY);
  const asSheet = side === 'right' && phone;
  const modal = asSheet || (modalProp ?? side === 'left');
  // Modal: full trap, stray focus pulled back. Non-modal: Tab wraps in the panel,
  // a click on the page beside it still takes focus there.
  useModalFocus(open, panelRef, modal ? undefined : panelRef, { recoverFocus: modal });
  const isTop = useOverlayLayer(open);
  const numericWidth = typeof width === 'number' ? width : undefined;
  useRightPanel(open && side === 'right' && !asSheet, { width: numericWidth, force: numericWidth === undefined });

  // Escape pressed on the page (focus outside the panel: beside a non-modal
  // drawer, or lost to the body) closes it while it is the top overlay.
  useTopLayerEscape(open, isTop, onClose);

  if (!open || typeof document === 'undefined') return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    // A dialog or sheet opened from inside the drawer owns its own Escape.
    const target = event.target instanceof Element ? event.target : null;
    const layer = target?.closest('[role="dialog"], [role="alertdialog"]');
    if (layer && layer !== panelRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  const classes = [
    'glass',
    'gv-drawer',
    `gv-drawer--${side}`,
    asSheet ? 'gv-drawer--sheet' : '',
    className ?? '',
  ].filter(Boolean).join(' ');

  return createPortal(
    <div className={modal ? 'gv-overlay' : 'gv-overlay gv-overlay--passthrough'} data-gv-layer="">
      {modal && <div className="scrim" aria-hidden="true" onClick={onClose} />}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={modal || undefined}
        aria-label={label}
        tabIndex={-1}
        className={classes}
        style={asSheet ? undefined : { width: typeof width === 'number' ? `min(${width}px, 100vw)` : width }}
        onKeyDown={onKeyDown}
        data-testid={testId}
      >
        {asSheet && <div className="gv-sheet__grabber" aria-hidden="true" />}
        {header && (
          <div className="gv-drawer__header">
            <h2 className="gv-drawer__title">{title ?? label}</h2>
            <IconButton label="Close" icon={<X />} onClick={onClose} noTooltip />
          </div>
        )}
        <div className="gv-drawer__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
