import '../../styles/components/ui.css';

export type StatusTone = 'ok' | 'warn' | 'bad' | 'info' | 'idle' | 'live';

export interface StatusDotProps {
  tone: StatusTone;
  /**
   * Screen-reader word for the state when no visible word sits beside the dot.
   * Status is never color alone: pass this, or render a word next to the dot.
   */
  srLabel?: string;
  className?: string;
}

/** A 7px status dot. Only the dot carries the hue. */
export function StatusDot({ tone, srLabel, className }: StatusDotProps) {
  return (
    <>
      <span className={['gv-dot', `gv-dot--${tone}`, className ?? ''].filter(Boolean).join(' ')} aria-hidden="true" />
      {srLabel && <span className="gv-sr-only">{srLabel}</span>}
    </>
  );
}
