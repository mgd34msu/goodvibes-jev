/**
 * EmptyState, icon + title + description + optional action.
 * Use when a list or view has no items to display.
 *
 * @example
 * <EmptyState
 *   icon={<FolderIcon />}
 *   title="No sessions yet"
 *   description="Start a conversation to see sessions here."
 *   action={{ label: 'New session', onClick: handleNew }}
 * />
 */
import type { FC, ReactNode } from 'react';
import { Button } from '../ui/Button';
import '../../styles/components/feedback.css';

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

export interface EmptyStateProps {
  /** Icon element rendered above the title (e.g. an SVG or Lucide icon). */
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: EmptyStateAction;
  className?: string;
}

export const EmptyState: FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  className,
}) => (
  <div
    className={['feedback-empty-state', className].filter(Boolean).join(' ')}
    role="status"
    aria-label={title}
  >
    {icon && (
      <span className="feedback-empty-state__icon" aria-hidden="true">
        {icon}
      </span>
    )}
    <p className="feedback-empty-state__title">{title}</p>
    {description && (
      <p className="feedback-empty-state__description">{description}</p>
    )}
    {action && (
      <div className="feedback-empty-state__action">
        <Button onClick={action.onClick}>{action.label}</Button>
      </div>
    )}
  </div>
);
