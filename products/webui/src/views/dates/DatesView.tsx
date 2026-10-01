/**
 * Occasions, the Occasions tab of Personal: upcoming occasions, plans, and the
 * open items the daemon is holding, over its sixteen `occasions.*` verbs
 * (docs/occasions.md). This surface renders what the read verbs return and calls
 * the write verbs for the actions they support; nothing here computes a
 * proximity word, a lead-time adjustment, a nudge cadence, or a nudge date, every
 * one of those stays server-side (docs/occasions.md §7's governing line: a
 * consumer that computed anything beyond calling these verbs and rendering the
 * answers would be a second implementation of a rule that lives in the daemon).
 *
 * LAYOUT: one list of rows in groups (Open items, Upcoming, Plans) with the
 * selected row's detail in the right pane: an occasion shows its facts, your
 * answer and its gift history; a plan shows its dates; a gift interview shows
 * its next question. "Add occasion" is the tab's one primary action and "Add
 * plan" sits beside it; both open a dialog that previews before it confirms. The
 * daemon's own record counts and the sweep sit in a quiet disclosure at the end.
 *
 * PULL-ONLY, NOT A NUDGE CHANNEL: the daemon pushes occasion/plan nudges to
 * Telegram and the agent, never the TUI (docs/occasions.md §4.2). This panel is
 * the same kind of interface, so it never originates a push, it only reads
 * what's outstanding (`occasions.pending`) and lets the operator act on it
 * (answer / resolve a conflict / continue an interview), which is a pull.
 *
 * DATES: occasions.list is the one read verb that returns real dates
 * (`nextOccurrence`, `daysUntil`), docs/occasions.md §4.3 draws this exactly.
 * occasions.pending's nudge subjects carry only `proximity` (a word), never a
 * date, this view renders that distinction verbatim rather than flattening both
 * to "the date".
 *
 * HONESTY: occasions.* may not be wired on every daemon build yet. When the list
 * read answers 404/501 the whole tab is one empty state that says so and offers
 * the daemon update; when a later read fails the group it feeds says so in place.
 */
import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Cake, Plane, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { sdk } from '../../lib/goodvibes';
import type { OperatorMethodInput, OperatorMethodOutput } from '../../lib/goodvibes';
import { WEBUI_PROFILE_AUTHORITY, WEBUI_PROFILE_SURFACE } from '../../lib/owner-profile';
import { queryKeys } from '../../lib/queries';
import { formatError, isMethodNotInvokableError, isMethodUnavailableError } from '../../lib/errors';
import { formatRelative } from '../../lib/object';
import ErrorBoundary from '../../components/feedback/ErrorBoundary';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../lib/toast';
import {
  DetailPane,
  DetailSection,
  Disclosure,
  EmptyState,
  Facts,
  ListDetail,
  RowGroup,
  SkeletonRows,
} from '../../components/data-view/DataView';
import {
  Button,
  Checkbox,
  Chip,
  Dialog,
  Field,
  IconButton,
  Input,
  Row,
  Select,
  StatusDot,
  type StatusTone,
} from '../../components/ui';
import { DateField } from '../../components/ui/DateField';
import { PersonalPage } from '../personal/PersonalPage';
import { openSettingsSection } from '../personal/openSettings';
import { DatesGiftHistoryBody } from './DatesGiftHistoryPeek';
import '../../styles/components/dates.css';

/** The utterance a manual occasions-tab capture carries, same role
 * owner-profile.ts's SETTINGS_EDIT_UTTERANCE plays for a settings edit: a plain
 * statement of where the fact came from, honest for THIS surface only (the operator
 * typing directly into the tab), never hardcoded by a caller that could be
 * relaying someone else's words. */
const DATES_PANEL_UTTERANCE = '(added in the dates panel)';

type OccasionsListResult = OperatorMethodOutput<'occasions.list'>;
type OccasionListEntry = OccasionsListResult['occasions'][number];
type UnparsedLine = OccasionsListResult['unparsed'][number];
type PlansListResult = OperatorMethodOutput<'occasions.plans.list'>;
type PlanEntry = PlansListResult['plans'][number];
type PendingResult = OperatorMethodOutput<'occasions.pending'>;
type InterviewState = NonNullable<PendingResult['interviews']>[number];
type OccasionKind = 'gift-giving' | 'neither' | 'remember-only';
type Recurrence = 'annual' | 'once';

type Selection = { kind: 'occasion' | 'plan' | 'interview'; id: string } | null;

const KIND_OPTIONS = [
  { value: 'gift-giving', label: 'Gift-giving' },
  { value: 'remember-only', label: 'Remember only' },
  { value: 'neither', label: 'Neither' },
] as const;

const RECURRENCE_OPTIONS = [
  { value: 'annual', label: 'Every year' },
  { value: 'once', label: 'One time' },
] as const;

function isNotAvailable(error: unknown): boolean {
  return isMethodUnavailableError(error) || isMethodNotInvokableError(error);
}

function kindLabel(kind: OccasionKind): string {
  if (kind === 'gift-giving') return 'Gift-giving';
  if (kind === 'remember-only') return 'Remember only';
  return 'Neither';
}

function answerLabel(answer: OccasionListEntry['answer']): string {
  if (answer === 'yes') return 'Yes';
  if (answer === 'no') return 'No';
  if (answer === 'later') return 'Later';
  return 'Not yet answered';
}

function answerTone(answer: OccasionListEntry['answer']): StatusTone {
  if (answer === 'yes') return 'ok';
  if (answer === 'no') return 'bad';
  if (answer === 'later') return 'warn';
  return 'idle';
}

/** `daysUntil` is the one place this view renders a real date-derived number, the
 * verb it comes from (occasions.list) is the explicit-ask read docs/occasions.md
 * §4.3 carves out, not the nudge path that never carries one. */
function daysUntilLabel(daysUntil: number | null): string {
  if (daysUntil === null) return 'No date';
  if (daysUntil === 0) return 'Today';
  if (daysUntil === 1) return 'Tomorrow';
  if (daysUntil < 0) return `${String(Math.abs(daysUntil))} days ago`;
  return `in ${String(daysUntil)} days`;
}

function formatDateOnly(iso: string | null): string {
  if (!iso) return 'No date';
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function joinMeta(parts: readonly (string | null | undefined | false)[]): string {
  return parts.filter(Boolean).join(' · ');
}

/** Shared between occasions.list.unparsed and occasions.plans.list.unparsed, both
 * carry the exact same {lineIndex, text, reason} shape (the profile grammar never
 * rewrites a line it cannot parse; it reports why instead, docs/occasions.md §3.1). */
function UnparsedLinesNote({ items }: { items: readonly UnparsedLine[] }) {
  if (items.length === 0) return null;
  return (
    <div className="dv-notice dv-notice--warn dates-note" role="status" data-testid="dates-unparsed">
      <AlertCircle aria-hidden="true" />
      <div>
        <p className="dates-note__title">
          {items.length === 1 ? '1 line could not be read' : `${String(items.length)} lines could not be read`}
        </p>
        <ul>
          {items.map((item) => (
            <li key={item.lineIndex}>
              <code>{item.text}</code>: {item.reason}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** A read that failed after the list loaded: say so where its rows would be. */
function LoadNote({ label, error, onRetry }: { label: string; error: unknown; onRetry: () => void }) {
  const unavailable = isNotAvailable(error);
  return (
    <div className={unavailable ? 'dv-notice dates-note' : 'dv-notice dv-notice--bad dates-note'} role="status">
      <AlertCircle aria-hidden="true" />
      <div className="dates-note__row">
        <span>{unavailable ? `${label} aren’t available on this daemon yet.` : `${label} failed to load: ${formatError(error)}`}</span>
        {!unavailable && <Button variant="ghost" size="sm" onClick={onRetry}>Try again</Button>}
      </div>
    </div>
  );
}

interface OccasionDraft {
  title: string;
  date: string;
  person: string;
  kind: OccasionKind | '';
  recurrence: Recurrence;
  leadDays: string;
}

interface PlanDraft {
  title: string;
  from: string;
  to: string;
  away: boolean;
  destination: string;
}

const EMPTY_OCCASION: OccasionDraft = { title: '', date: '', person: '', kind: '', recurrence: 'annual', leadDays: '' };
const EMPTY_PLAN: PlanDraft = { title: '', from: '', to: '', away: false, destination: '' };

export interface DatesViewProps {
  /** The Personal tab switcher; shown first in the filter row. */
  tabs?: ReactNode;
}

export function DatesView({ tabs }: DatesViewProps = {}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [selection, setSelection] = useState<Selection>(null);
  const [sweepResult, setSweepResult] = useState<OperatorMethodOutput<'occasions.sweep'> | null>(null);

  const [occasionOpen, setOccasionOpen] = useState(false);
  const [occasion, setOccasion] = useState<OccasionDraft>(EMPTY_OCCASION);
  const [occasionProposal, setOccasionProposal] = useState<OperatorMethodOutput<'occasions.propose'> | null>(null);

  const [planOpen, setPlanOpen] = useState(false);
  const [plan, setPlan] = useState<PlanDraft>(EMPTY_PLAN);
  const [planProposal, setPlanProposal] = useState<OperatorMethodOutput<'occasions.plans.propose'> | null>(null);

  const [interviewDrafts, setInterviewDrafts] = useState<Record<string, string>>({});
  const [landedOnDrafts, setLandedOnDrafts] = useState<Record<string, string>>({});

  const list = useQuery({ queryKey: queryKeys.occasionsList, queryFn: () => sdk.operator.occasions.list() });
  const plans = useQuery({ queryKey: queryKeys.occasionsPlansList, queryFn: () => sdk.operator.occasions.plans.list() });
  const pending = useQuery({ queryKey: queryKeys.occasionsPending, queryFn: () => sdk.operator.occasions.pending() });
  const state = useQuery({ queryKey: queryKeys.occasionsState, queryFn: () => sdk.operator.occasions.state() });

  function invalidateAll(): Promise<void> {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.occasionsList }),
      queryClient.invalidateQueries({ queryKey: queryKeys.occasionsPlansList }),
      queryClient.invalidateQueries({ queryKey: queryKeys.occasionsPending }),
      queryClient.invalidateQueries({ queryKey: queryKeys.occasionsState }),
    ]).then(() => undefined);
  }

  const answerOccasion = useMutation({
    mutationFn: (input: OperatorMethodInput<'occasions.answer'>) => sdk.operator.occasions.answer(input),
    onSuccess: async (result) => {
      await invalidateAll();
      if (!result.ok) {
        toast({ title: 'Answer not recorded', description: result.reason ?? undefined, tone: 'danger' });
        return;
      }
      toast({
        title: 'Answer recorded',
        description: result.interview ? 'A short gift interview opened: continue it under Gift interviews.' : undefined,
        tone: 'success',
      });
    },
    onError: (error: unknown) => toast({ title: 'Failed to record answer', description: formatError(error), tone: 'danger' }),
  });

  const removeOccasion = useMutation({
    mutationFn: (occasionId: string) =>
      sdk.operator.occasions.remove({ occasionId, confirmed: true, authority: WEBUI_PROFILE_AUTHORITY }),
    onSuccess: async (result) => {
      await invalidateAll();
      if (result.ok) setSelection(null);
      toast({
        title: result.ok ? 'Removed' : 'Not removed',
        description: result.ok ? result.disclosure : (result.reason ?? undefined),
        tone: result.ok ? 'success' : 'danger',
      });
    },
    onError: (error: unknown) => toast({ title: 'Removal failed', description: formatError(error), tone: 'danger' }),
  });

  const resolveConflict = useMutation({
    mutationFn: (occasionId: string) => sdk.operator.occasions.conflict.resolve(occasionId),
    onSuccess: async () => {
      await invalidateAll();
      toast({ title: 'Conflict resolved', tone: 'success' });
    },
    onError: (error: unknown) => toast({ title: 'Failed to resolve conflict', description: formatError(error), tone: 'danger' }),
  });

  const answerInterview = useMutation({
    mutationFn: (input: OperatorMethodInput<'occasions.interview.answer'>) => sdk.operator.occasions.interview.answer(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.occasionsPending });
    },
    onError: (error: unknown) => toast({ title: 'Failed to record interview answer', description: formatError(error), tone: 'danger' }),
  });

  const recordInterview = useMutation({
    mutationFn: (input: OperatorMethodInput<'occasions.interview.record'>) => sdk.operator.occasions.interview.record(input),
    onSuccess: async (result) => {
      await invalidateAll();
      if (result.interview) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.occasionsGifts(result.interview.occasionId) });
      }
      toast({ title: 'Recorded what you landed on', tone: 'success' });
    },
    onError: (error: unknown) => toast({ title: 'Failed to close the interview', description: formatError(error), tone: 'danger' }),
  });

  const runSweep = useMutation({
    mutationFn: () => sdk.operator.occasions.sweep(),
    onSuccess: async (result) => {
      setSweepResult(result);
      await invalidateAll();
    },
    onError: (error: unknown) => toast({ title: 'Sweep failed', description: formatError(error), tone: 'danger' }),
  });

  const proposeOccasion = useMutation({
    mutationFn: () =>
      sdk.operator.occasions.propose({
        title: occasion.title.trim(),
        date: occasion.date,
        ...(occasion.kind ? { kind: occasion.kind } : {}),
        ...(occasion.person.trim() ? { person: occasion.person.trim() } : {}),
        recurrence: occasion.recurrence,
        ...(occasion.leadDays.trim() ? { leadDays: Number(occasion.leadDays) } : {}),
      }),
    onSuccess: (result) => setOccasionProposal(result),
    onError: (error: unknown) => toast({ title: 'Preview failed', description: formatError(error), tone: 'danger' }),
  });

  const confirmOccasion = useMutation({
    mutationFn: () =>
      sdk.operator.occasions.confirm({
        title: occasion.title.trim(),
        date: occasion.date,
        kind: occasion.kind as OccasionKind,
        ...(occasion.person.trim() ? { person: occasion.person.trim() } : {}),
        recurrence: occasion.recurrence,
        ...(occasion.leadDays.trim() ? { leadDays: Number(occasion.leadDays) } : {}),
        surface: WEBUI_PROFILE_SURFACE,
        said: DATES_PANEL_UTTERANCE,
        authority: WEBUI_PROFILE_AUTHORITY,
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.occasionsList });
      if (!result.ok) {
        toast({ title: 'Not saved', description: result.reason ?? undefined, tone: 'danger' });
        return;
      }
      setOccasion(EMPTY_OCCASION);
      setOccasionProposal(null);
      setOccasionOpen(false);
      toast({ title: 'Occasion added', description: result.disclosure, tone: 'success' });
    },
    onError: (error: unknown) => toast({ title: 'Save failed', description: formatError(error), tone: 'danger' }),
  });

  const proposePlan = useMutation({
    mutationFn: () =>
      sdk.operator.occasions.plans.propose({
        title: plan.title.trim(),
        from: plan.from,
        to: plan.to,
        away: plan.away,
        ...(plan.destination.trim() ? { destination: plan.destination.trim() } : {}),
      }),
    onSuccess: (result) => setPlanProposal(result),
    onError: (error: unknown) => toast({ title: 'Preview failed', description: formatError(error), tone: 'danger' }),
  });

  const confirmPlan = useMutation({
    mutationFn: () =>
      sdk.operator.occasions.plans.confirm({
        title: plan.title.trim(),
        from: plan.from,
        to: plan.to,
        away: plan.away,
        ...(plan.destination.trim() ? { destination: plan.destination.trim() } : {}),
        surface: WEBUI_PROFILE_SURFACE,
        said: DATES_PANEL_UTTERANCE,
        authority: WEBUI_PROFILE_AUTHORITY,
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.occasionsPlansList });
      if (!result.ok) {
        toast({ title: 'Not saved', description: result.reason ?? undefined, tone: 'danger' });
        return;
      }
      setPlan(EMPTY_PLAN);
      setPlanProposal(null);
      setPlanOpen(false);
      toast({ title: 'Plan added', description: result.disclosure, tone: 'success' });
    },
    onError: (error: unknown) => toast({ title: 'Save failed', description: formatError(error), tone: 'danger' }),
  });

  /** Editing any field makes an earlier preview stale, so it is dropped. */
  function editOccasion(patch: Partial<OccasionDraft>): void {
    setOccasion((current) => ({ ...current, ...patch }));
    setOccasionProposal(null);
  }

  function editPlan(patch: Partial<PlanDraft>): void {
    setPlan((current) => ({ ...current, ...patch }));
    setPlanProposal(null);
  }

  function submitOccasionProposal(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (occasion.title.trim() && occasion.date) proposeOccasion.mutate();
  }

  function submitPlanProposal(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (plan.title.trim() && plan.from && plan.to) proposePlan.mutate();
  }

  async function askRemove(kind: 'occasion' | 'plan', id: string, title: string): Promise<void> {
    const ok = await confirm.ask({
      title: kind === 'occasion' ? 'Remove this occasion?' : 'Remove this plan?',
      target: title,
      description: kind === 'occasion'
        ? 'It leaves your profile for good, along with its acknowledgements and gift records.'
        : 'It leaves your profile for good, along with every record against it.',
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (ok) removeOccasion.mutate(id);
  }

  function refreshAll(): void {
    void list.refetch();
    void plans.refetch();
    void pending.refetch();
    void state.refetch();
  }

  const occasionEntries: readonly OccasionListEntry[] = list.data?.occasions ?? [];
  const planEntries: readonly PlanEntry[] = plans.data?.plans ?? [];
  const nudge = pending.data?.nudge ?? null;
  const pendingConflicts = pending.data?.conflicts ?? [];
  const listConflicts = list.data?.conflicts ?? [];
  const interviews: readonly InterviewState[] = pending.data?.interviews ?? [];
  const conflictCount = listConflicts.length + pendingConflicts.length;

  const listUnavailable = list.error ? isNotAvailable(list.error) : false;

  const selectedOccasion = selection?.kind === 'occasion'
    ? occasionEntries.find((entry) => entry.occasion.id === selection.id)
    : undefined;
  const selectedPlan = selection?.kind === 'plan' ? planEntries.find((entry) => entry.id === selection.id) : undefined;
  const selectedInterview = selection?.kind === 'interview'
    ? interviews.find((entry) => entry.interviewId === selection.id)
    : undefined;
  const detailOpen = Boolean(selectedOccasion ?? selectedPlan ?? selectedInterview);

  const occasionTitleFor = (occasionId: string): string =>
    occasionEntries.find((entry) => entry.occasion.id === occasionId)?.occasion.title ?? occasionId;

  function openOccasion(occasionId: string): void {
    if (occasionEntries.some((entry) => entry.occasion.id === occasionId)) setSelection({ kind: 'occasion', id: occasionId });
  }

  // ── Detail pane ──────────────────────────────────────────────────
  function renderDetail(): ReactNode {
    if (selectedOccasion) {
      const entry = selectedOccasion;
      return (
        <DetailPane
          title={entry.occasion.title}
          meta={joinMeta([entry.occasion.person, kindLabel(entry.occasion.kind)])}
          onClose={() => setSelection(null)}
          closeLabel="Close occasion"
          actions={(
            <Button
              variant="ghost"
              size="sm"
              icon={<Trash2 />}
              disabled={removeOccasion.isPending}
              onClick={() => void askRemove('occasion', entry.occasion.id, entry.occasion.title)}
            >
              Remove
            </Button>
          )}
        >
          <Facts
            items={[
              { label: 'Next date', value: formatDateOnly(entry.nextOccurrence) },
              { label: 'Countdown', value: daysUntilLabel(entry.daysUntil) },
              { label: 'Person', value: entry.occasion.person ?? undefined },
              { label: 'Kind', value: kindLabel(entry.occasion.kind) },
              { label: 'Gift this year', value: answerLabel(entry.answer) },
              { label: 'Reminders', value: entry.inLeadWindow ? 'In lead window' : undefined },
              { label: 'Calendar', value: entry.mirrored ? 'Mirrored to calendar' : undefined },
            ]}
          />
          <DetailSection title="Your answer">
            <div className="dates-answers" role="group" aria-label="Your answer">
              {(['yes', 'no', 'later'] as const).map((answer) => (
                <Button
                  key={answer}
                  variant="outline"
                  size="sm"
                  aria-pressed={entry.answer === answer}
                  disabled={answerOccasion.isPending}
                  onClick={() => answerOccasion.mutate({ occasionId: entry.occasion.id, answer })}
                >
                  {answerLabel(answer)}
                </Button>
              ))}
            </div>
          </DetailSection>
          <DetailSection title="Gift history">
            <DatesGiftHistoryBody occasionId={entry.occasion.id} />
          </DetailSection>
        </DetailPane>
      );
    }

    if (selectedPlan) {
      const item = selectedPlan;
      return (
        <DetailPane
          title={item.title}
          meta={`${formatDateOnly(item.from)} to ${formatDateOnly(item.to)}`}
          onClose={() => setSelection(null)}
          closeLabel="Close plan"
          actions={(
            <Button
              variant="ghost"
              size="sm"
              icon={<Trash2 />}
              disabled={removeOccasion.isPending}
              onClick={() => void askRemove('plan', item.id, item.title)}
            >
              Remove
            </Button>
          )}
        >
          <Facts
            items={[
              { label: 'From', value: formatDateOnly(item.from) },
              { label: 'To', value: formatDateOnly(item.to) },
              { label: 'Destination', value: item.destination ?? undefined },
              { label: 'Away', value: item.away ? 'You will be away' : undefined },
            ]}
          />
        </DetailPane>
      );
    }

    if (selectedInterview) {
      const interview = selectedInterview;
      const step = interview.nextStep;
      const landedOn = (landedOnDrafts[interview.interviewId] ?? '').trim();
      return (
        <DetailPane
          title="Gift interview"
          meta={occasionTitleFor(interview.occasionId)}
          onClose={() => setSelection(null)}
          closeLabel="Close interview"
        >
          {interview.complete ? (
            <form
              className="dates-interview"
              onSubmit={(event) => {
                event.preventDefault();
                if (landedOn) recordInterview.mutate({ interviewId: interview.interviewId, landedOn });
              }}
            >
              <Field label="What did you land on?">
                <Input
                  value={landedOnDrafts[interview.interviewId] ?? ''}
                  onChange={(event) => setLandedOnDrafts((current) => ({ ...current, [interview.interviewId]: event.target.value }))}
                />
              </Field>
              <div>
                <Button variant="primary" type="submit" disabled={recordInterview.isPending || !landedOn}>Record</Button>
              </div>
            </form>
          ) : step ? (
            <form
              className="dates-interview"
              onSubmit={(event) => {
                event.preventDefault();
                const text = (interviewDrafts[step.id] ?? '').trim();
                if (text) answerInterview.mutate({ interviewId: interview.interviewId, stepId: step.id, text });
              }}
            >
              <Field label={step.prompt}>
                <Input
                  value={interviewDrafts[step.id] ?? ''}
                  onChange={(event) => setInterviewDrafts((current) => ({ ...current, [step.id]: event.target.value }))}
                />
              </Field>
              <div>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={answerInterview.isPending || !(interviewDrafts[step.id] ?? '').trim()}
                >
                  Answer
                </Button>
              </div>
            </form>
          ) : (
            <p className="dates-interview__done">Waiting on the next step.</p>
          )}
        </DetailPane>
      );
    }

    return null;
  }

  // ── List pane ────────────────────────────────────────────────────
  const hasOpenItems = Boolean(nudge) || conflictCount > 0 || interviews.length > 0;
  const nothingAtAll = occasionEntries.length === 0 && planEntries.length === 0 && !hasOpenItems && !plans.error && !pending.error;

  const listBody = (
    <>
      {plans.data?.awayNow ? (
        <div className="dv-notice dates-note" role="status">
          <Plane aria-hidden="true" />
          <span>
            Away now: {plans.data.awayNow.title}
            {plans.data.awayNow.destination ? `, ${plans.data.awayNow.destination}` : ''} (through {formatDateOnly(plans.data.awayNow.to)})
          </span>
        </div>
      ) : null}

      {pending.error ? <LoadNote label="Open items" error={pending.error} onRetry={() => void pending.refetch()} /> : null}

      {nudge ? (
        <div className="dates-nudge" data-testid="dates-nudge">
          <p className="dates-nudge__message">{nudge.message}</p>
          <RowGroup label="Asking about" count={nudge.subjects.length}>
            {nudge.subjects.map((subject) => (
              <Row
                key={subject.occasionId}
                title={subject.title}
                meta={joinMeta([subject.person, kindLabel(subject.kind)])}
                trailing={<Chip size="sm">{subject.proximity}</Chip>}
                onSelect={occasionEntries.some((entry) => entry.occasion.id === subject.occasionId)
                  ? () => openOccasion(subject.occasionId)
                  : undefined}
              />
            ))}
          </RowGroup>
        </div>
      ) : null}

      {conflictCount > 0 ? (
        <div data-testid="dates-conflicts" role="alert">
          <RowGroup label="Conflicting dates" count={conflictCount}>
            {listConflicts.map((conflict) => (
              <Row
                key={`list-${conflict.occasionId}`}
                title={conflict.title}
                meta={conflict.dates.join(' vs. ')}
                trailing={(
                  <Button variant="outline" size="sm" disabled={resolveConflict.isPending} onClick={() => resolveConflict.mutate(conflict.occasionId)}>
                    Resolved
                  </Button>
                )}
              />
            ))}
            {pendingConflicts.map((conflict) => (
              <Row
                key={`pending-${conflict.occasionId}`}
                title={conflict.message}
                trailing={(
                  <Button variant="outline" size="sm" disabled={resolveConflict.isPending} onClick={() => resolveConflict.mutate(conflict.occasionId)}>
                    Resolved
                  </Button>
                )}
              />
            ))}
          </RowGroup>
        </div>
      ) : null}

      {interviews.length > 0 ? (
        <div data-testid="dates-interview-list">
          <RowGroup label="Gift interviews" count={interviews.length}>
            {interviews.map((interview) => (
              <Row
                key={interview.interviewId}
                title={occasionTitleFor(interview.occasionId)}
                meta={interview.complete ? 'What did you land on?' : (interview.nextStep?.prompt ?? 'Waiting on the next step')}
                selected={selection?.kind === 'interview' && selection.id === interview.interviewId}
                onSelect={() => setSelection({ kind: 'interview', id: interview.interviewId })}
              />
            ))}
          </RowGroup>
        </div>
      ) : null}

      {occasionEntries.length > 0 ? (
        <div data-testid="dates-occasion-list">
          <RowGroup label="Upcoming" count={occasionEntries.length}>
            {occasionEntries.map((entry) => (
              <Row
                key={entry.occasion.id}
                className="dates-occasion-row"
                leading={<StatusDot tone={answerTone(entry.answer)} srLabel={answerLabel(entry.answer)} />}
                title={entry.occasion.title}
                meta={joinMeta([
                  formatDateOnly(entry.nextOccurrence),
                  entry.occasion.person,
                  kindLabel(entry.occasion.kind),
                  entry.inLeadWindow && 'In lead window',
                ])}
                trailing={<span className="dv-value">{daysUntilLabel(entry.daysUntil)}</span>}
                selected={selection?.kind === 'occasion' && selection.id === entry.occasion.id}
                onSelect={() => setSelection({ kind: 'occasion', id: entry.occasion.id })}
              />
            ))}
          </RowGroup>
        </div>
      ) : null}
      <UnparsedLinesNote items={list.data?.unparsed ?? []} />

      {plans.error ? (
        <LoadNote label="Plans" error={plans.error} onRetry={() => void plans.refetch()} />
      ) : planEntries.length > 0 ? (
        <div data-testid="dates-plan-list">
          <RowGroup label="Plans" count={planEntries.length}>
            {planEntries.map((item) => (
              <Row
                key={item.id}
                className="dates-plan-row"
                title={item.title}
                meta={joinMeta([`${formatDateOnly(item.from)} to ${formatDateOnly(item.to)}`, item.destination])}
                trailing={item.away ? <Chip size="sm" tone="warn">Away</Chip> : undefined}
                selected={selection?.kind === 'plan' && selection.id === item.id}
                onSelect={() => setSelection({ kind: 'plan', id: item.id })}
              />
            ))}
          </RowGroup>
        </div>
      ) : null}
      <UnparsedLinesNote items={plans.data?.unparsed ?? []} />

      {nothingAtAll ? (
        <EmptyState
          icon={<Cake />}
          title="No occasions yet"
          action={<Button variant="outline" onClick={() => setOccasionOpen(true)}>Add occasion</Button>}
        >
          Add a birthday or anniversary, or tell the agent about one.
        </EmptyState>
      ) : null}

      <div className="dates-store" data-testid="dates-state-section">
        {state.error ? (
          <LoadNote label="Stored records" error={state.error} onRetry={() => void state.refetch()} />
        ) : state.data ? (
          <Disclosure summary="Stored records">
            <div className="dates-state" data-testid="dates-state">
              {state.data.corruption ? (
                <div className="dv-notice dv-notice--bad dates-note" role="alert">
                  <AlertCircle aria-hidden="true" />
                  <span>{state.data.corruption}</span>
                </div>
              ) : null}
              <Facts
                items={[
                  { label: 'Acknowledgements', value: state.data.acknowledgements ?? 0 },
                  { label: 'Gift records', value: state.data.giftRecords ?? 0 },
                  { label: 'Open items', value: state.data.openItems ?? 0 },
                  { label: 'Interviews', value: state.data.interviews ?? 0 },
                  { label: 'Calendar mirrors', value: state.data.mirrors ?? 0 },
                ]}
              />
              {state.data.lastSweep ? (
                <p className="dates-state__text">
                  Last swept {formatRelative(state.data.lastSweep.sweptAt)}, expired {state.data.lastSweep.expiredAcknowledgements} acknowledgement(s),
                  reaped {state.data.lastSweep.orphanedRecords} orphaned record(s), expired {state.data.lastSweep.expiredOpenItems} open item(s),
                  aged out {state.data.lastSweep.agedGiftRecords} gift record(s), dropped {state.data.lastSweep.droppedInterviews} interview(s),
                  cleared {state.data.lastSweep.staleMirrors} stale mirror(s).
                </p>
              ) : (
                <p className="dates-state__text">No sweep has run yet.</p>
              )}
              <div>
                <Button variant="outline" size="sm" disabled={runSweep.isPending} onClick={() => runSweep.mutate()}>
                  {runSweep.isPending ? 'Sweeping…' : 'Run sweep now'}
                </Button>
              </div>
              {sweepResult ? (
                <p className="dates-state__text" role="status">
                  {sweepResult.hold ? `Held: ${sweepResult.hold}.` : sweepResult.delivered ? `Delivered via ${sweepResult.deliveryChannel}.` : 'Ran with nothing to deliver.'}
                  {' '}Mirrored {sweepResult.mirrored} occasion(s).
                </p>
              ) : null}
            </div>
          </Disclosure>
        ) : null}
      </div>
    </>
  );

  // ── Page ─────────────────────────────────────────────────────────
  const filters = listUnavailable ? undefined : (
    <div className="dv-filters__end">
      <IconButton label="Refresh occasions" icon={<RefreshCw />} onClick={refreshAll} />
    </div>
  );

  const action = listUnavailable || list.isPending ? undefined : (
    <>
      <Button variant="outline" onClick={() => setPlanOpen(true)}>Add plan</Button>
      <Button variant="primary" icon={<Plus />} onClick={() => setOccasionOpen(true)}>Add occasion</Button>
    </>
  );

  let content: ReactNode;
  if (list.isPending) {
    content = <SkeletonRows count={6} label="Loading occasions" />;
  } else if (listUnavailable) {
    content = (
      <EmptyState
        icon={<Cake />}
        title="Occasions aren’t available on this daemon yet"
        role="status"
        action={<Button variant="outline" onClick={() => openSettingsSection('about')}>Update daemon</Button>}
      >
        This daemon build has no occasions handler wired up. Updating the daemon adds occasions and plans here.
      </EmptyState>
    );
  } else if (list.error) {
    content = (
      <EmptyState
        icon={<AlertCircle />}
        title="Occasions failed to load"
        role="status"
        action={<Button variant="outline" onClick={() => void list.refetch()}>Try again</Button>}
      >
        {formatError(list.error)}
      </EmptyState>
    );
  } else {
    content = (
      <ListDetail
        mode="peek"
        list={listBody}
        detail={renderDetail()}
        detailOpen={detailOpen}
        onCloseDetail={() => setSelection(null)}
        listLabel="Occasions and plans"
        detailLabel="Details"
        backLabel="All occasions"
      />
    );
  }

  const occasionPreviewReady = Boolean(occasionProposal?.ok);

  return (
    <ErrorBoundary
      fallback={(err, reset) => (
        <EmptyState icon={<AlertCircle />} title="Occasions view failed" action={<Button variant="outline" onClick={reset}>Try again</Button>}>
          {formatError(err)}
        </EmptyState>
      )}
    >
      <PersonalPage tabs={tabs} filters={filters} action={action}>
        {content}
      </PersonalPage>

      <Dialog
        open={occasionOpen}
        onClose={() => setOccasionOpen(false)}
        title="Add occasion"
        description="Preview shows what will be saved. Nothing is added until you confirm."
        footer={(
          <>
            <Button variant="secondary" onClick={() => setOccasionOpen(false)}>Cancel</Button>
            <Button
              variant="outline"
              type="submit"
              form="dates-add-occasion"
              disabled={proposeOccasion.isPending || !occasion.title.trim() || !occasion.date}
            >
              {proposeOccasion.isPending ? 'Previewing…' : 'Preview'}
            </Button>
            <Button
              variant="primary"
              disabled={confirmOccasion.isPending || !occasionPreviewReady || !occasion.kind}
              onClick={() => confirmOccasion.mutate()}
            >
              {confirmOccasion.isPending ? 'Saving…' : 'Confirm'}
            </Button>
          </>
        )}
      >
        <form id="dates-add-occasion" className="personal-form" onSubmit={submitOccasionProposal}>
          <Field label="Title">
            <Input value={occasion.title} onChange={(event) => editOccasion({ title: event.target.value })} required />
          </Field>
          <div className="personal-form__split">
            <Field label="Date">
              <DateField value={occasion.date} onChange={(value) => editOccasion({ date: value })} required />
            </Field>
            <Field label="Repeats">
              <Select<Recurrence>
                value={occasion.recurrence}
                onChange={(value) => editOccasion({ recurrence: value })}
                options={RECURRENCE_OPTIONS}
              />
            </Field>
          </div>
          <div className="personal-form__split">
            <Field label="Person">
              <Input value={occasion.person} onChange={(event) => editOccasion({ person: event.target.value })} />
            </Field>
            <Field label="Lead days (optional)">
              <Input inputMode="numeric" pattern="[0-9]*" value={occasion.leadDays} onChange={(event) => editOccasion({ leadDays: event.target.value.replace(/[^0-9]/g, '') })} />
            </Field>
          </div>
          <Field label="Kind">
            <Select<OccasionKind>
              value={occasion.kind}
              onChange={(value) => editOccasion({ kind: value })}
              options={KIND_OPTIONS}
              placeholder="Choose before confirming"
            />
          </Field>
          {occasionProposal ? (
            occasionProposal.ok ? (
              <div className="dv-notice dates-proposal" role="status">
                <div>
                  <p>{occasionProposal.confirmation}</p>
                  {occasionProposal.conflictsWith.length > 0 ? <p>Conflicts with: {occasionProposal.conflictsWith.join(', ')}</p> : null}
                  {occasionProposal.needsKind && !occasion.kind ? <p>Pick a kind above before confirming.</p> : null}
                </div>
              </div>
            ) : (
              <div className="dv-notice dv-notice--bad dates-proposal" role="alert">
                <AlertCircle aria-hidden="true" />
                <span>{occasionProposal.reason ?? 'Could not preview this occasion.'}</span>
              </div>
            )
          ) : null}
        </form>
      </Dialog>

      <Dialog
        open={planOpen}
        onClose={() => setPlanOpen(false)}
        title="Add plan"
        description="Preview shows what will be saved. Nothing is added until you confirm."
        footer={(
          <>
            <Button variant="secondary" onClick={() => setPlanOpen(false)}>Cancel</Button>
            <Button
              variant="outline"
              type="submit"
              form="dates-add-plan"
              disabled={proposePlan.isPending || !plan.title.trim() || !plan.from || !plan.to}
            >
              {proposePlan.isPending ? 'Previewing…' : 'Preview'}
            </Button>
            <Button
              variant="primary"
              disabled={confirmPlan.isPending || !planProposal?.ok}
              onClick={() => confirmPlan.mutate()}
            >
              {confirmPlan.isPending ? 'Saving…' : 'Confirm'}
            </Button>
          </>
        )}
      >
        <form id="dates-add-plan" className="personal-form" onSubmit={submitPlanProposal}>
          <Field label="Title">
            <Input value={plan.title} onChange={(event) => editPlan({ title: event.target.value })} required />
          </Field>
          <div className="personal-form__split">
            <Field label="From">
              <DateField value={plan.from} onChange={(value) => editPlan({ from: value })} required />
            </Field>
            <Field label="To">
              <DateField value={plan.to} onChange={(value) => editPlan({ to: value })} required />
            </Field>
          </div>
          <Field label="Destination">
            <Input value={plan.destination} onChange={(event) => editPlan({ destination: event.target.value })} />
          </Field>
          <Checkbox checked={plan.away} onChange={(checked) => editPlan({ away: checked })}>
            I’ll be away during this plan
          </Checkbox>
          {planProposal ? (
            planProposal.ok ? (
              <div className="dv-notice dates-proposal" role="status">
                <div>
                  <p>{planProposal.confirmation}</p>
                  {planProposal.conflictsWith.length > 0 ? <p>Conflicts with: {planProposal.conflictsWith.join(', ')}</p> : null}
                </div>
              </div>
            ) : (
              <div className="dv-notice dv-notice--bad dates-proposal" role="alert">
                <AlertCircle aria-hidden="true" />
                <span>{planProposal.reason ?? 'Could not preview this plan.'}</span>
              </div>
            )
          ) : null}
        </form>
      </Dialog>

      {confirm.element}
    </ErrorBoundary>
  );
}
