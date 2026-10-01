/**
 * Personal: Calendar, Mail and Occasions as tabs of one data page (design doc
 * "Data views"). The Segmented sits in the filter row of whichever tab is
 * showing; each tab view owns its own filters, its one primary action and its
 * list and detail.
 */
import { PERSONAL, resolveTab } from '../../components/shell/nav';
import { Segmented } from '../../components/ui/Segmented';
import type { PersonalTab } from '../../lib/router';
import { CalendarView } from '../calendar/CalendarView';
import { DatesView } from '../dates/DatesView';
import { MailView } from '../mail/MailView';

export interface PersonalViewProps {
  tab?: string;
  onTabChange: (tab: PersonalTab) => void;
}

export function PersonalView({ tab, onTabChange }: PersonalViewProps) {
  const current = resolveTab(PERSONAL, tab);
  const tabs = (
    <Segmented<PersonalTab>
      label="Personal sections"
      value={current}
      options={PERSONAL.tabs.map((t) => ({ value: t.tab as PersonalTab, label: t.label }))}
      onChange={onTabChange}
    />
  );
  if (current === 'mail') return <MailView tabs={tabs} />;
  if (current === 'occasions') return <DatesView tabs={tabs} />;
  return <CalendarView tabs={tabs} />;
}
