import type { ReactNode } from 'react';
import '../../styles/components/ui.css';

export interface RowProps {
  title: ReactNode;
  meta?: ReactNode;
  /** Leading slot: a status dot or a 16 icon. */
  leading?: ReactNode;
  /** Right-aligned value or action; buttons here stay separately clickable. */
  trailing?: ReactNode;
  selected?: boolean;
  /** Makes the whole row one button (the trailing slot stays independent). */
  onSelect?: () => void;
  /** Accessible name for the row button when the title is not plain text. */
  'aria-label'?: string;
  className?: string;
}

/**
 * A list row: divided by --line, 12 vertical padding, title 14/500, one line of
 * meta in --text-3, one value or action on the right. Selected rows get a
 * --surface fill and a 2px accent marker on the left edge. Never a card.
 */
export function Row({ title, meta, leading, trailing, selected = false, onSelect, className, ...aria }: RowProps) {
  const body = (
    <>
      {leading}
      <span className="gv-row__text">
        <span className="gv-row__title">{title}</span>
        {meta && <span className="gv-row__meta">{meta}</span>}
      </span>
    </>
  );
  return (
    <li className={['gv-row', selected ? 'gv-row--selected' : '', className ?? ''].filter(Boolean).join(' ')}>
      {onSelect ? (
        <button
          type="button"
          className="gv-row__main"
          aria-current={selected || undefined}
          aria-label={aria['aria-label']}
          onClick={onSelect}
        >
          {body}
        </button>
      ) : (
        <div className="gv-row__main" aria-current={selected || undefined}>{body}</div>
      )}
      {trailing && <div className="gv-row__trailing">{trailing}</div>}
    </li>
  );
}

/** The divided list a set of Rows sits in. */
export function RowList({ children, 'aria-label': ariaLabel }: { children: ReactNode; 'aria-label'?: string }) {
  return <ul className="gv-rows" aria-label={ariaLabel}>{children}</ul>;
}
