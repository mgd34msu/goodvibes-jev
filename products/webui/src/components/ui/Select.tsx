import { Check, ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useFloatingPosition, useOutsidePress, type Placement } from './overlay';
import '../../styles/components/ui.css';

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<V extends string = string> {
  value: V | '';
  onChange: (value: V) => void;
  options: readonly SelectOption<V>[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  /** Accessible name when no visible <label> points at this control. */
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  placement?: Placement;
  className?: string;
}

/**
 * A styled select: a trigger that looks like an input and a glass listbox
 * popover. No native <select> anywhere (design doc "Fields").
 *
 * Keyboard: Enter, Space, ArrowDown or ArrowUp open; in the list, arrows move,
 * Home and End jump, a letter jumps to the next match, Enter or Space picks,
 * Escape and Tab close and return focus to the trigger.
 */
export function Select<V extends string = string>({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  disabled = false,
  id,
  placement = 'bottom-start',
  className,
  ...aria
}: SelectProps<V>) {
  const autoId = useId();
  const listId = `${autoId}-list`;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const position = useFloatingPosition(open, triggerRef, listRef, placement, { matchWidth: true });
  const selectedIndex = useMemo(() => options.findIndex((o) => o.value === value), [options, value]);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useOutsidePress(open, [triggerRef, listRef], () => close(false));

  const enabledIndexes = useMemo(
    () => options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0),
    [options],
  );

  const openList = (start: 'selected' | 'first' | 'last') => {
    if (disabled || enabledIndexes.length === 0) return;
    const initial = start === 'first'
      ? enabledIndexes[0]
      : start === 'last'
        ? enabledIndexes[enabledIndexes.length - 1]
        : selectedIndex >= 0 ? selectedIndex : enabledIndexes[0];
    setActive(initial);
    setOpen(true);
  };

  useEffect(() => {
    if (open) listRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open || active < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  const pick = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    close(true);
  };

  const move = (delta: number) => {
    if (enabledIndexes.length === 0) return;
    const pos = enabledIndexes.indexOf(active);
    const next = pos < 0 ? 0 : Math.min(enabledIndexes.length - 1, Math.max(0, pos + delta));
    setActive(enabledIndexes[next]);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openList('selected');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openList('selected');
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); move(1); break;
      case 'ArrowUp': event.preventDefault(); move(-1); break;
      case 'Home': event.preventDefault(); setActive(enabledIndexes[0]); break;
      case 'End': event.preventDefault(); setActive(enabledIndexes[enabledIndexes.length - 1]); break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        pick(active);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case 'Tab':
        close(false);
        break;
      default:
        if (event.key.length === 1 && /\S/.test(event.key)) {
          const letter = event.key.toLowerCase();
          const start = Math.max(0, active);
          const order = [...options.keys()].map((i) => (start + 1 + i) % options.length);
          const hit = order.find((i) => !options[i].disabled && options[i].label.toLowerCase().startsWith(letter));
          if (hit !== undefined) setActive(hit);
        }
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        // The APG select-only combobox: role="combobox" (allowed on <button>)
        // carries aria-expanded/aria-controls and, unlike role button,
        // aria-invalid, which Field injects when the value is refused.
        role="combobox"
        className={['gv-select__trigger', className ?? ''].filter(Boolean).join(' ')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={aria['aria-label']}
        aria-describedby={aria['aria-describedby']}
        aria-invalid={aria['aria-invalid']}
        disabled={disabled}
        onClick={() => (open ? close(false) : openList('selected'))}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={selected ? 'gv-select__value' : 'gv-select__value gv-select__value--placeholder'}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown className="gv-select__chevron" aria-hidden="true" />
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          data-gv-layer=""
          className="glass gv-popover"
          aria-label={aria['aria-label']}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          onKeyDown={onListKeyDown}
          style={position ? { top: position.top, left: position.left } : { top: -9999, left: -9999 }}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              id={`${listId}-${index}`}
              data-index={index}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled ? true : undefined}
              data-active={index === active}
              className="gv-option"
              onMouseEnter={() => !option.disabled && setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(index)}
            >
              <span className="gv-option__label">{option.label}</span>
              {option.value === value && <Check className="gv-option__check" aria-hidden="true" />}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
