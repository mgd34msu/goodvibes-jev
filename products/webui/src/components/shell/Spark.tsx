/**
 * The GoodVibes spark: a four-point star filled with the brand gradient (cyan
 * #5ee0e6 to violet #d18cf5, the TUI's brand and brandEnd). Drawn as an inline
 * SVG so it needs no mask support; the gradient id is unique per instance.
 */
import { useId } from 'react';

export function Spark({ size = 16, className }: { size?: number; className?: string }) {
  const gradientId = `gv-spark-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg
      className={['gv-spark', className ?? ''].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" className="gv-spark__from" />
          <stop offset="1" className="gv-spark__to" />
        </linearGradient>
      </defs>
      <path d="M12 1.5l2.6 7.9 7.9 2.6-7.9 2.6L12 22.5l-2.6-7.9L1.5 12l7.9-2.6z" fill={`url(#${gradientId})`} />
    </svg>
  );
}
