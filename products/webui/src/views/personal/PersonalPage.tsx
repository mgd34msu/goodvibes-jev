/**
 * The page frame the three Personal tabs share: the Personal title and
 * description, the tab Segmented first in the filter row with the tab's own
 * filters after it, and the tab's one primary action in the header.
 *
 * Each tab view renders this itself so it can put its own filters and action in
 * the right slots. `tabs` is the Segmented PersonalView passes down; a tab
 * rendered on its own (a unit test) simply has no tab switcher.
 */
import type { ReactNode } from 'react';
import { DataPage } from '../../components/data-view/DataView';
import { PERSONAL } from '../../components/shell/nav';
import '../../styles/components/personal.css';

export interface PersonalPageProps {
  /** The Calendar / Mail / Occasions Segmented. */
  tabs?: ReactNode;
  /** The tab's own filters, in the same row as the tabs. */
  filters?: ReactNode;
  /** The tab's one primary action. */
  action?: ReactNode;
  children: ReactNode;
}

export function PersonalPage({ tabs, filters, action, children }: PersonalPageProps) {
  const row = tabs || filters ? <>{tabs}{filters}</> : undefined;
  return (
    <DataPage title={PERSONAL.label} description={PERSONAL.description} action={action} filters={row} className="personal-page">
      {children}
    </DataPage>
  );
}

/** An inline result line (created, imported, sent) above a tab's content. */
export function PersonalNotice({ tone, children }: { tone?: 'bad' | 'warn'; children: ReactNode }) {
  const classes = ['dv-notice', 'personal-notice', tone ? `dv-notice--${tone}` : ''].filter(Boolean).join(' ');
  return <div className={classes} role="status">{children}</div>;
}
