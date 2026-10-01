import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Tooltip } from './Tooltip';
import type { Placement } from './overlay';
import '../../styles/components/ui.css';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  /** Required: the accessible name, also shown as the tooltip. */
  label: string;
  icon: ReactNode;
  /** Keyboard hint shown in the tooltip, e.g. "Ctrl B". */
  shortcut?: string;
  tooltipPlacement?: Placement;
  size?: 'sm' | 'md';
  /** Suppress the tooltip (the label is still the accessible name). */
  noTooltip?: boolean;
}

/**
 * Icon-only button. It always has an aria-label and a tooltip carrying the same
 * words (design doc: "Icon-only buttons always carry a tooltip and an aria-label").
 * 32 square, 44 on coarse pointers.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, shortcut, tooltipPlacement = 'bottom', size = 'md', noTooltip = false, className, type = 'button', ...rest },
  ref,
) {
  const classes = ['gv-icon-button', size === 'sm' ? 'gv-icon-button--sm' : '', className ?? ''].filter(Boolean).join(' ');
  const button = (
    <button ref={ref} type={type} aria-label={label} className={classes} {...rest}>
      {icon}
    </button>
  );
  if (noTooltip) return button;
  return (
    <Tooltip content={label} shortcut={shortcut} placement={tooltipPlacement} labelOnly>
      {button}
    </Tooltip>
  );
});
