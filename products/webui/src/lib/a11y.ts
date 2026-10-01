/**
 * Accessibility helpers shared across the app.
 * See: docs/ux-overhaul/TOKEN-CONTRACT.md
 */
import type React from 'react';
import { useId } from 'react';

/**
 * React hook that generates a stable, hydration-safe unique id using
 * React's built-in `useId`. Use this in all component code needing a stable id.
 *
 * @example
 * function Dialog({ title }: { title: string }) {
 *   const titleId = useGenId('dialog-title');
 *   return <dialog aria-labelledby={titleId}>...</dialog>;
 * }
 */
export function useGenId(prefix: string): string {
  const reactId = useId();
  // useId returns ':r0:' style strings; strip colons for valid HTML id attr
  return `${prefix}-${reactId.replace(/:/g, '')}`;
}

/**
 * CSS class name that visually hides an element while keeping it
 * accessible to screen readers. Defined in feedback.css.
 */
export const SR_ONLY_CLASS = 'sr-only';

/**
 * Inline style equivalent of .sr-only, use when you cannot apply a class.
 */
export const srOnlyStyle: React.CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  borderWidth: 0,
};
