import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import {
  PHONE_QUERY,
  useFloatingPosition,
  useMediaQuery,
  useOutsidePress,
  type Placement,
} from './overlay';
import '../../styles/components/ui.css';

const ITEM_SELECTOR = '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';

interface MenuContextValue {
  close: (refocus?: boolean) => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export interface MenuProps {
  /** Accessible name of the menu. */
  label: string;
  /** Render the trigger; spread the props onto a button. */
  trigger: (props: MenuTriggerProps) => ReactElement;
  placement?: Placement;
  /** Under 900 the menu opens as a bottom sheet over the scrim (default true). */
  sheetOnPhone?: boolean;
  className?: string;
  /** Minimum width in px (the design doc's menus are 240 to 270). */
  width?: number;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

function items(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter(
    (el) => !(el as HTMLButtonElement).disabled,
  );
}

/**
 * A glass menu that follows the WAI-ARIA menu pattern: arrows move, Home and
 * End jump, a letter jumps to the next item starting with it, Enter or Space
 * picks, Escape closes and returns focus to the trigger, Tab closes. Left and
 * Right move within a radio group. On a phone it opens as a bottom sheet.
 */
export function Menu({
  label,
  trigger,
  placement = 'bottom-start',
  sheetOnPhone = true,
  className,
  width,
  onOpenChange,
  children,
}: MenuProps) {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpenState] = useState(false);
  const [focusEdge, setFocusEdge] = useState<'first' | 'last'>('first');
  const isPhone = useMediaQuery(PHONE_QUERY);
  const asSheet = sheetOnPhone && isPhone;
  const position = useFloatingPosition(open && !asSheet, triggerRef, menuRef, placement);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  }, [onOpenChange]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, [setOpen]);

  useOutsidePress(open && !asSheet, [triggerRef, menuRef], () => close(false));

  useEffect(() => {
    if (!open) return;
    const list = items(menuRef.current);
    const target = focusEdge === 'last' ? list[list.length - 1] : list[0];
    (target ?? menuRef.current)?.focus({ preventScroll: true });
  }, [open, focusEdge]);

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setFocusEdge('first');
      setOpen(true);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setFocusEdge('last');
      setOpen(true);
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items(menuRef.current);
    const current = document.activeElement as HTMLElement | null;
    const index = current ? list.indexOf(current) : -1;
    const focusAt = (i: number) => list[(i + list.length) % list.length]?.focus();
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); focusAt(index + 1); break;
      case 'ArrowUp': event.preventDefault(); focusAt(index - 1); break;
      case 'Home': event.preventDefault(); focusAt(0); break;
      case 'End': event.preventDefault(); focusAt(list.length - 1); break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        const group = current?.closest('[role="group"]');
        if (!group || current?.getAttribute('role') !== 'menuitemradio') break;
        event.preventDefault();
        const radios = Array.from(group.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
        const at = radios.indexOf(current);
        const next = radios[(at + (event.key === 'ArrowRight' ? 1 : -1) + radios.length) % radios.length];
        next?.focus();
        break;
      }
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case 'Tab':
        event.preventDefault();
        close(true);
        break;
      default:
        if (event.key.length === 1 && /\S/.test(event.key) && !event.ctrlKey && !event.metaKey) {
          const letter = event.key.toLowerCase();
          for (let step = 1; step <= list.length; step += 1) {
            const candidate = list[(index + step) % list.length];
            if ((candidate.textContent ?? '').trim().toLowerCase().startsWith(letter)) {
              candidate.focus();
              break;
            }
          }
        }
    }
  };

  const menuBody = (
    <div
      ref={menuRef}
      id={menuId}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      data-gv-layer=""
      className={asSheet
        ? ['gv-menu', 'gv-sheet__body', className ?? ''].filter(Boolean).join(' ')
        : ['glass', 'gv-popover', 'gv-menu', className ?? ''].filter(Boolean).join(' ')}
      style={asSheet
        ? undefined
        : {
          ...(width ? { minWidth: width, width } : null),
          ...(position ? { top: position.top, left: position.left } : { top: -9999, left: -9999 }),
        }}
      onKeyDown={onMenuKeyDown}
    >
      {children}
    </div>
  );

  return (
    <MenuContext.Provider value={{ close }}>
      {trigger({
        ref: triggerRef,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? menuId : undefined,
        onClick: () => {
          setFocusEdge('first');
          if (open) close(false);
          else setOpen(true);
        },
        onKeyDown: onTriggerKeyDown,
      })}
      {open && typeof document !== 'undefined' && createPortal(
        asSheet ? (
          <div className="gv-overlay" data-gv-layer="">
            <div className="scrim" aria-hidden="true" onClick={() => close(true)} />
            <div className="glass gv-sheet" data-gv-layer="">
              <div className="gv-sheet__grabber" aria-hidden="true" />
              {menuBody}
            </div>
          </div>
        ) : menuBody,
        document.body,
      )}
    </MenuContext.Provider>
  );
}

function useMenu(): MenuContextValue {
  const ctx = useContext(MenuContext);
  if (!ctx) throw new Error('Menu items must be rendered inside a Menu');
  return ctx;
}

export interface MenuItemProps {
  icon?: ReactNode;
  /** Right-aligned keyboard hint or value in --text-3. */
  hint?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Keep the menu open after this item is picked. */
  keepOpen?: boolean;
  /** Let a long label wrap onto a second line instead of truncating. */
  wrap?: boolean;
  children: ReactNode;
}

export function MenuItem({ icon, hint, onSelect, disabled, danger, keepOpen, wrap, children }: MenuItemProps) {
  const { close } = useMenu();
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      disabled={disabled}
      className={['gv-menu-item', danger ? 'gv-menu-item--danger' : '', wrap ? 'gv-menu-item--wrap' : ''].filter(Boolean).join(' ')}
      onClick={() => {
        onSelect?.();
        if (!keepOpen) close(false);
      }}
    >
      {icon}
      <span className="gv-menu-item__label">{children}</span>
      {hint && <span className="gv-menu-item__hint">{hint}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="gv-menu__separator" />;
}

/** Non-interactive text inside a menu (the signed-in line at the top). */
export function MenuMeta({ children }: { children: ReactNode }) {
  return <div role="none" className="gv-menu__meta">{children}</div>;
}

export interface MenuRadioGroupProps<V extends string> {
  label: string;
  icon?: ReactNode;
  /** Null when none of the options is the current value. */
  value: V | null;
  options: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
}

/** A labelled row of radio items drawn as a segmented control; stays open on pick. */
export function MenuRadioGroup<V extends string>({ label, icon, value, options, onChange }: MenuRadioGroupProps<V>) {
  return (
    <div role="group" aria-label={label} className="gv-menu__row">
      {icon}
      <span className="gv-menu__row-label" aria-hidden="true">{label}</span>
      <span className="gv-menu-seg">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={option.value === value}
            tabIndex={-1}
            className="gv-menu-seg__item"
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </span>
    </div>
  );
}

export interface MenuCheckboxItemProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  icon?: ReactNode;
  children: ReactNode;
}

/** A checkable item drawn with a switch on the right; stays open on toggle. */
export function MenuCheckboxItem({ checked, onChange, icon, children }: MenuCheckboxItemProps) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      tabIndex={-1}
      className="gv-menu-item gv-menu-item--switch"
      onClick={() => onChange(!checked)}
    >
      {icon}
      <span className="gv-menu-item__label">{children}</span>
      <span className="gv-toggle__track" aria-hidden="true">
        <span className="gv-toggle__thumb" />
      </span>
    </button>
  );
}
