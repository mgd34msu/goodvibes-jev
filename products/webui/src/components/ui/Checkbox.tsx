import { Check } from 'lucide-react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import '../../styles/components/ui.css';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'checked'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label beside the box; without it pass aria-label. */
  children?: ReactNode;
}

/**
 * A checkbox drawn by the kit: an 16 by 16 box with a 6 radius, accent fill and
 * a check mark when on. The real input stays in the page (visually replaced),
 * so labels, keyboard, forms and tests treat it as a checkbox.
 */
export function Checkbox({ checked, onChange, children, className, disabled, ...rest }: CheckboxProps) {
  return (
    <label
      className={['gv-checkbox', disabled ? 'gv-checkbox--disabled' : '', className ?? ''].filter(Boolean).join(' ')}
    >
      <span className="gv-checkbox__box">
        <input
          type="checkbox"
          className="gv-checkbox__input"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          {...rest}
        />
        <Check className="gv-checkbox__mark" aria-hidden="true" />
      </span>
      {children !== undefined && <span className="gv-checkbox__label">{children}</span>}
    </label>
  );
}
