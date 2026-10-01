import { useRef, type KeyboardEvent } from 'react';
import '../../styles/components/ui.css';

export interface SegmentedOption<V extends string = string> {
  value: V;
  label: string;
}

export interface SegmentedProps<V extends string = string> {
  value: V;
  onChange: (value: V) => void;
  options: readonly SegmentedOption<V>[];
  /** Accessible name of the group. */
  label: string;
  className?: string;
  size?: 'sm' | 'md';
}

/**
 * Segmented control: a radiogroup of pills on a --surface-2 track. Roving
 * tabindex; Left/Right (and Up/Down) move and select, Home/End jump.
 */
export function Segmented<V extends string = string>({ value, onChange, options, label, className }: SegmentedProps<V>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(0, options.findIndex((o) => o.value === value));

  const select = (next: number) => {
    const wrapped = (next + options.length) % options.length;
    onChange(options[wrapped].value);
    refs.current[wrapped]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); select(index + 1); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); select(index - 1); }
    else if (event.key === 'Home') { event.preventDefault(); select(0); }
    else if (event.key === 'End') { event.preventDefault(); select(options.length - 1); }
  };

  return (
    <div role="radiogroup" aria-label={label} className={['gv-segmented', className ?? ''].filter(Boolean).join(' ')}>
      {options.map((option, i) => (
        <button
          key={option.value}
          ref={(node) => { refs.current[i] = node; }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={i === index ? 0 : -1}
          className="gv-segmented__item"
          onClick={() => onChange(option.value)}
          onKeyDown={onKeyDown}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
