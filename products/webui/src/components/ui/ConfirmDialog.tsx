/**
 * ConfirmDialog (design doc "Menus and modals"): 420 wide glass over the scrim,
 * a title, one sentence, and two right-aligned buttons, secondary Cancel and the
 * primary or danger action. On a phone it is a bottom sheet with a grabber.
 *
 * It replaces every browser confirm() and every one-off confirm sheet. A view
 * awaits a boolean through useConfirm():
 *
 *   const confirm = useConfirm();
 *   if (await confirm.ask({ title: 'Delete this chat?', description: '...', tone: 'danger', confirmLabel: 'Delete' })) {
 *     remove.mutate(id);
 *   }
 *   return <>{confirm.element}...</>;
 *
 * The mutation runs after the dialog resolves and closes, so no busy state lives
 * in the dialog. Escape, the scrim and Cancel all resolve false. Focus lands on
 * the action for an ordinary confirm and on Cancel for a destructive one, and
 * returns to the opener on close.
 */
import { useCallback, useRef, useState, type ReactElement } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';

export interface ConfirmDialogProps {
  open: boolean;
  /** The question or action, short: "Restore this checkpoint?". */
  title: string;
  /** What the action acts on (a checkpoint label, a task title), one quiet line. */
  target?: string;
  /** One sentence of consequence. */
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  /** Disables both buttons while the caller's write is in flight. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  target,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const hasBody = Boolean(target);
  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onCancel}
      title={title}
      description={description}
      size="confirm"
      role="alertdialog"
      hideClose
      initialFocusRef={tone === 'danger' ? cancelRef : confirmRef}
      className={`gv-confirm gv-confirm--${tone}`}
      footer={(
        <>
          <Button ref={cancelRef} variant="secondary" className="gv-confirm__cancel" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={tone === 'danger' ? 'danger' : 'primary'}
            className="gv-confirm__confirm"
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {confirmLabel}
          </Button>
        </>
      )}
    >
      {hasBody ? <p className="gv-confirm__target">{target}</p> : null}
    </Dialog>
  );
}

export interface ConfirmRequest {
  title: string;
  target?: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}

export interface ConfirmController {
  ask: (request: ConfirmRequest) => Promise<boolean>;
  element: ReactElement | null;
}

/** A promise-returning confirm gate; render `element` anywhere in the view. */
export function useConfirm(): ConfirmController {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setRequest(null);
    resolve?.(confirmed);
  }, []);

  const ask = useCallback((next: ConfirmRequest): Promise<boolean> => {
    // A second ask while one is open resolves the first as cancelled: never a
    // dangling promise, never two dialogs stacked.
    resolverRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setRequest(next);
    });
  }, []);

  const element = request ? (
    <ConfirmDialog
      open
      title={request.title}
      target={request.target}
      description={request.description}
      confirmLabel={request.confirmLabel}
      cancelLabel={request.cancelLabel}
      tone={request.tone}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  ) : null;

  return { ask, element };
}
