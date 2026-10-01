/**
 * ErrorState, inline failed-query state with a Retry action.
 * Use inside data-fetching views when a query errors but the whole page
 * should not crash (as opposed to ErrorBoundary for render errors).
 *
 * @example
 * {error && <ErrorState error={error} onRetry={refetch} />}
 */
import type { FC } from 'react';
import { formatError } from '../../lib/errors';
import { Button } from '../ui/Button';
import '../../styles/components/feedback.css';

export interface ErrorStateProps {
  /** The error to display. Passed to `formatError` for a human-readable message. */
  error: unknown;
  /** Called when the user clicks the Retry button. */
  onRetry?: () => void;
  /** Override the default title. */
  title?: string;
  className?: string;
}

export const ErrorState: FC<ErrorStateProps> = ({
  error,
  onRetry,
  title = 'Failed to load',
  className,
}) => {
  const message = formatError(error);

  return (
    <div
      className={['feedback-error-state', className].filter(Boolean).join(' ')}
      role="alert"
      aria-live="polite"
    >
      <span className="feedback-error-state__icon" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </span>
      <div className="feedback-error-state__body">
        <span className="feedback-error-state__title">{title}</span>
        {message && <span className="feedback-error-state__message">{message}</span>}
      </div>
      {onRetry && (
        <Button size="sm" className="feedback-error-state__retry" onClick={onRetry} aria-label="Retry">
          Retry
        </Button>
      )}
    </div>
  );
};
