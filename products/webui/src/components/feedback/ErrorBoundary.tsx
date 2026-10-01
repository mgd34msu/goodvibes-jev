/**
 * ErrorBoundary, React class error boundary.
 * The app currently has no top-level error boundary; this is the critical missing piece.
 *
 * Contract: default export, prop `fallback?: (error, reset) => ReactNode`
 * See: docs/ux-overhaul/TOKEN-CONTRACT.md
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { formatError } from '../../lib/errors';
import { Button } from '../ui/Button';
import '../../styles/components/feedback.css';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Custom fallback renderer. Receives the caught error and a reset callback.
   * When omitted a default inline error state with a Retry button is rendered.
   */
  fallback?: (error: unknown, reset: () => void) => ReactNode;
  /** Optional handler called each time an error is caught (e.g. for logging). */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: unknown;
}

/**
 * Wrap any subtree to catch unhandled render errors.
 *
 * @example
 * <ErrorBoundary fallback={(err, reset) => <ErrorState error={err} onRetry={reset} />}>
 *   <RiskyComponent />
 * </ErrorBoundary>
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.props.onError?.(error, errorInfo);
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  override render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback(this.state.error, this.handleReset);
    }

    const message = formatError(this.state.error);

    return (
      <div className="feedback-error-boundary" role="alert" aria-live="assertive">
        <div className="feedback-error-boundary__icon" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <p className="feedback-error-boundary__title">Something went wrong</p>
        <p className="feedback-error-boundary__message">{message}</p>
        <Button className="feedback-error-boundary__retry" onClick={this.handleReset}>
          Try again
        </Button>
      </div>
    );
  }
}
