import { X } from 'lucide-react';
import { useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './IconButton';
import { useModalFocus, useOverlayLayer, useTopLayerEscape } from './overlay';
import '../../styles/components/ui.css';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  /**
   * confirm: 420 wide. default: 560. wide: 880 wide, content height (a table or
   * a comparison). large: 880 by 640 (the settings dialog).
   */
  size?: 'confirm' | 'default' | 'wide' | 'large';
  /** alertdialog for a confirmation that interrupts; dialog otherwise. */
  role?: 'dialog' | 'alertdialog';
  /** Controls in the header before the close button (a target switcher). */
  headerActions?: ReactNode;
  /** Right-aligned buttons: secondary Cancel, then the one primary or danger action. */
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Hide the close button (confirm dialogs that already have Cancel). */
  hideClose?: boolean;
  /**
   * Bare layout: no header, body padding or footer. The title stays the
   * accessible name (visually hidden) and the children draw the whole panel,
   * close button included. The settings dialog uses it for its two columns.
   */
  bare?: boolean;
  /** Extra class on the panel. */
  className?: string;
  children?: ReactNode;
}

/**
 * Modal dialog: glass, 16 radius, centered over the scrim; a bottom sheet with
 * a grabber on phones. Focus is trapped and returned on close; Escape and a
 * scrim click close it.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  size = 'default',
  role = 'dialog',
  headerActions,
  footer,
  initialFocusRef,
  hideClose = false,
  bare = false,
  className,
  children,
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(open, panelRef, initialFocusRef);
  const isTop = useOverlayLayer(open);
  useTopLayerEscape(open, isTop, onClose);

  if (!open || typeof document === 'undefined') return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      // A dialog nested inside this one (a confirm sheet, a modal a section
      // opens) owns its own Escape; React bubbles portal and inline events
      // through here, so leave those alone.
      const target = event.target instanceof Element ? event.target : null;
      const layer = target?.closest('[role="dialog"], [role="alertdialog"]');
      if (layer && layer !== panelRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const sizeClass = size === 'default' ? '' : `gv-dialog--${size}`;
  return createPortal(
    <div className="gv-overlay" data-gv-layer="">
      <div className="scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={['glass', 'gv-dialog', sizeClass, bare ? 'gv-dialog--bare' : '', className ?? ''].filter(Boolean).join(' ')}
        onKeyDown={onKeyDown}
      >
        {bare ? (
          <>
            <h2 id={titleId} className="gv-sr-only">{title}</h2>
            {description && <p id={descriptionId} className="gv-sr-only">{description}</p>}
            {children}
          </>
        ) : (
        <>
        <div className="gv-dialog__header">
          <div className="gv-dialog__titles">
            <h2 id={titleId} className="gv-dialog__title">{title}</h2>
            {description && <p id={descriptionId} className="gv-dialog__description">{description}</p>}
          </div>
          {headerActions && <div className="gv-dialog__header-actions">{headerActions}</div>}
          {!hideClose && <IconButton label="Close" icon={<X />} onClick={onClose} noTooltip />}
        </div>
        {children && <div className="gv-dialog__body">{children}</div>}
        {footer && <div className="gv-dialog__footer">{footer}</div>}
        </>
        )}
      </div>
    </div>,
    document.body,
  );
}
