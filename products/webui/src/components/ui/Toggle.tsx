import type { ButtonHTMLAttributes, ReactNode } from 'react';
import '../../styles/components/ui.css';

export interface ToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label beside the switch; without it pass aria-label. */
  children?: ReactNode;
}

/** A switch: 34 by 20 track, accent when on (design doc "Segmented, toggle, chips, status"). */
export function Toggle({ checked, onChange, children, className, ...rest }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={['gv-toggle', className ?? ''].filter(Boolean).join(' ')}
      onClick={() => onChange(!checked)}
      {...rest}
    >
      <span className="gv-toggle__track" aria-hidden="true"><span className="gv-toggle__thumb" /></span>
      {children}
    </button>
  );
}
