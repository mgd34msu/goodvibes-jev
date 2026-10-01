import type { HTMLAttributes, ReactNode } from 'react';
import { StatusDot, type StatusTone } from './StatusDot';
import '../../styles/components/ui.css';

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  /** Optional status: draws a dot. The chip itself stays neutral. */
  tone?: StatusTone;
  size?: 'sm' | 'md';
  children: ReactNode;
}

/** A neutral pill; a status chip adds a dot, never a colored fill. */
export function Chip({ tone, size = 'md', className, children, ...rest }: ChipProps) {
  return (
    <span className={['gv-chip', size === 'sm' ? 'gv-chip--sm' : '', className ?? ''].filter(Boolean).join(' ')} {...rest}>
      {tone && <StatusDot tone={tone} />}
      {children}
    </span>
  );
}
