/**
 * SkeletonBlock, animated loading placeholder.
 * Named SkeletonBlock (not Skeleton) to avoid a name collision if the
 * toast/motion area ever grows its own Skeleton component.
 *
 * @example
 * <SkeletonBlock width="100%" height={20} />
 * <SkeletonBlock variant="text" lines={3} />
 * <SkeletonBlock variant="circle" size={40} />
 */
import type { CSSProperties, FC } from 'react';
import '../../styles/components/feedback.css';

export type SkeletonVariant = 'block' | 'text' | 'circle';

export interface SkeletonBlockProps {
  variant?: SkeletonVariant;
  /** Width (for block/circle variants). Accepts CSS value. */
  width?: number | string;
  /** Height (for block variant). Accepts CSS value. */
  height?: number | string;
  /** Diameter (for circle variant). */
  size?: number | string;
  /** Number of text lines to render (for text variant). */
  lines?: number;
  className?: string;
  style?: CSSProperties;
}

export const SkeletonBlock: FC<SkeletonBlockProps> = ({
  variant = 'block',
  width,
  height,
  size,
  lines = 3,
  className,
  style,
}) => {
  const base = ['feedback-skeleton', `feedback-skeleton--${variant}`, className]
    .filter(Boolean)
    .join(' ');

  if (variant === 'circle') {
    const dim = size ?? 40;
    const px = typeof dim === 'number' ? `${dim}px` : dim;
    return (
      <span
        className={base}
        aria-hidden="true"
        style={{ width: px, height: px, ...style }}
      />
    );
  }

  if (variant === 'text') {
    return (
      <div className="feedback-skeleton-text" aria-hidden="true" style={style}>
        {Array.from({ length: lines }, (_, i) => (
          <span
            key={i}
            className="feedback-skeleton feedback-skeleton--text-line"
            // Last line slightly shorter for a natural look
            style={i === lines - 1 ? { width: '70%' } : undefined}
          />
        ))}
      </div>
    );
  }

  const w = width != null ? (typeof width === 'number' ? `${width}px` : width) : '100%';
  const h = height != null ? (typeof height === 'number' ? `${height}px` : height) : '20px';

  return (
    <span
      className={base}
      aria-hidden="true"
      style={{ width: w, height: h, ...style }}
    />
  );
};
