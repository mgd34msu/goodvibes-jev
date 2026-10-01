import type { InputHTMLAttributes, ReactNode } from 'react';
import '../../styles/components/ui.css';

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'checked'> {
  checked: boolean;
  /** Called when this option is picked. */
  onChange: () => void;
  /** Visible label beside the dot; without it pass aria-label. */
  children?: ReactNode;
}

/**
 * A radio drawn by the kit: a 16 round box that fills with the accent and a dot
 * when picked. The real input stays in the page (visually replaced), so labels,
 * keyboard (arrow keys within a shared `name`), forms and tests treat it as a radio.
 */
export function Radio({ checked, onChange, children, className, disabled, ...rest }: RadioProps) {
  return (
    <label className={['gv-checkbox', 'gv-radio', disabled ? 'gv-checkbox--disabled' : '', className ?? ''].filter(Boolean).join(' ')}>
      <span className="gv-checkbox__box gv-radio__box">
        <input
          type="radio"
          className="gv-checkbox__input"
          checked={checked}
          disabled={disabled}
          onChange={() => onChange()}
          {...rest}
        />
        <span className="gv-radio__dot" aria-hidden="true" />
      </span>
      {children !== undefined && <span className="gv-checkbox__label">{children}</span>}
    </label>
  );
}
