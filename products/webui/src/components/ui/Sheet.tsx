import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus, useOverlayLayer, useTopLayerEscape } from './overlay';
import '../../styles/components/ui.css';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name. */
  label: string;
  children: ReactNode;
}

/**
 * Bottom sheet: glass with a grabber and 20 top radius over the scrim. Used for
 * phone menus and dialogs; on a wide screen it is a centered 640-wide sheet.
 */
export function Sheet({ open, onClose, label, children }: SheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(open, panelRef);
  const isTop = useOverlayLayer(open);
  useTopLayerEscape(open, isTop, onClose);
  if (!open || typeof document === 'undefined') return null;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  return createPortal(
    <div className="gv-overlay" data-gv-layer="">
      <div className="scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="glass gv-sheet"
        onKeyDown={onKeyDown}
      >
        <div className="gv-sheet__grabber" aria-hidden="true" />
        <div className="gv-sheet__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
