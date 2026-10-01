import { type CSSProperties } from 'react';
import '../../styles/skeleton.css';

interface SkeletonProps {
  /** Width, any CSS value, e.g. "100%", "120px". Default "100%". */
  width?: string;
  /** Height, any CSS value. Default "1em". */
  height?: string;
  /** Border radius. Default var(--radius-xs). */
  radius?: string;
  /** Additional class names. */
  className?: string;
  /** Override inline styles. */
  style?: CSSProperties;
}

/**
 * Shimmer skeleton placeholder. Uses CSS motion tokens and
 * `prefers-reduced-motion` via the stylesheet.
 *
 * Import `src/styles/components/toast.css` (or the shared CSS
 * that includes `.skeleton` rules) to activate shimmer.
 */
export function Skeleton({ width = '100%', height = '1em', radius, className, style }: SkeletonProps) {
  return (
    <div
      className={['skeleton', className].filter(Boolean).join(' ')}
      style={{
        width,
        height,
        borderRadius: radius ?? 'var(--radius-xs)',
        ...style,
      }}
      aria-hidden="true"
    />
  );
}
