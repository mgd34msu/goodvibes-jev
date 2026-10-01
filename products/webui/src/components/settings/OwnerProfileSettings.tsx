/**
 * OwnerProfileSettings, the owner-profile surface for this webui
 * (profile.* verbs, docs/owner-profile.md). Mounted in AdminView beside PowerSettings and
 * MemoryDiagnostics, and built the same non-schema-driven way they are: these verbs carry
 * no CONFIG_SCHEMA entry, so they get a bespoke panel rather than a SettingsModal row.
 * (The `profile.*` CONFIG keys, enabled, autonomousWrites, discloseWrites and the rest of
 * §12, do go through the schema-driven modal, under the "Owner Profile" group label added
 * in config-redaction.ts.)
 *
 * The panel answers §8.3's three questions on this surface:
 *
 *   "what do you know about me?" , profile.read, rendered by section. Mechanical fields
 *      (§4.3) render as labelled values; everything else renders as the prose it is. His
 *      prose is NOT restyled into a table, the file is a document he wrote, and the writer
 *      never normalises it (§4.5), so neither does this reader.
 *   "where did you get that?"    , profile.provenance, per field, from that field's own
 *      button. Every learned line already shows its compact suffix (§4.2: surface, date,
 *      his verbatim words); the button adds the `<!-- was: … -->` predecessors. Per line,
 *      never one bulk dump.
 *   "forget that"                , profile.forget, behind a confirm, then a report of what
 *      actually went. Deleting is permanent (§9.2 and
 *      docs/decisions/2026-07-06-delete-means-delete.md): no tombstone, no retention
 *      window, and the history that would have made it undoable goes with it. A forget of
 *      something that was not there comes back `ok: false` with the store's own sentence,
 *      which this panel relays verbatim, it never renders as a success.
 *
 * WHERE UNDO LIVES, AND WHY. profile.read carries no superseded count, so the only honest
 * source for "does an earlier value exist" is profile.provenance. Undo therefore sits
 * INSIDE the provenance disclosure, directly under the earlier values it would restore,
 * so the button appears exactly where a superseded value has been shown to exist, rather
 * than on every field as a mostly-dead affordance.
 *
 * WHY PROSE LINES HAVE NO LOOKUP AND NO UNDO. profile.provenance and profile.undo take a
 * fieldId; profile.forget also takes a raw lineIndex, which is what prose gets. That is
 * not a gap: a bullet's whole provenance is the suffix already on the line, and §9.1 says
 * prose bullets are never superseded, so there is no predecessor list to fetch and nothing
 * to restore. The panel states that rather than offering a button that cannot work.
 *
 * HONEST STATES. profile.status's three answers render as three different things: loaded,
 * turned off, and could-not-be-read-with-a-reason. An unavailable profile never renders as
 * an empty one, because "I could not open the file" and "I know nothing about you" are
 * different sentences (§4.4). A daemon build that does not serve these verbs at all
 * (404/501) gets its own honest state, the same way MemoryDiagnostics does.
 *
 * THIRD-PARTY PERSONAL DATA (§10). The People section holds facts about people who never
 * agreed to be in a database. This repo has no existing marker convention for such
 * material to reuse, its nearest analogues are config-redaction.ts (secret-shaped config
 * values are masked, and SettingsField renders them write-only) and MemoryRecordDetail (a
 * sensitive-looking ref renders as plain inert text, never a link, never fetched). Neither
 * is a containment marker for third-party data, so this panel uses the most conservative
 * rendering available: the section is marked in the DOM (`data-third-party="true"`),
 * carries a visible containment note, renders as plain inert text with no link/copy/export
 * affordance, and never reaches DataBlock, compactJson or any diagnostic block. Nothing in
 * this file logs a profile value.
 */
import { useState, type SyntheticEvent } from 'react';
import { UserRound } from 'lucide-react';
import {
  useAppendOwnerProfileLine,
  useForgetOwnerProfile,
  useOwnerProfileDocument,
  useOwnerProfileProvenance,
  useOwnerProfileStatus,
  useSetOwnerProfileField,
  useUndoOwnerProfile,
} from '../../hooks/useOwnerProfile';
import {
  forgetReportLine,
  profileDisabledLine,
  profileStateBadgeClass,
  profileStateLabel,
  profileUnavailableLine,
  provenanceSummary,
  sectionHoldsThirdPartyData,
  tierNote,
  writeReportLine,
  type ProfileField,
  type ProfileProseLine,
  type ProfileSection,
  type ProfileTarget,
} from '../../lib/owner-profile';
import { formatError, isMethodNotInvokableError, isMethodUnavailableError } from '../../lib/errors';
import { EmptyState } from '../feedback/EmptyState';
import { ErrorState } from '../feedback/ErrorState';
import { SkeletonBlock } from '../feedback/SkeletonBlock';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { useConfirm } from '../ui/ConfirmDialog';
import { Input } from '../ui/Field';
import { SettingsBlock } from './dialog/parts';
import '../../styles/components/owner-profile.css';

const STATE_TONE = { ok: 'ok', neutral: 'idle', bad: 'bad' } as const;

interface ActionReport {
  readonly tone: 'ok' | 'info' | 'warning';
  readonly text: string;
}

/** What the panel's row components need from their parent. Passed explicitly rather than
 *  through context: one panel, one level of nesting, no indirection worth the cost. */
interface RowActions {
  readonly onSave: (field: ProfileField, value: string) => void;
  readonly onForget: (target: ProfileTarget, label: string) => void;
  readonly onUndo: (fieldId: string, label: string) => void;
  readonly busy: boolean;
}

// ---------------------------------------------------------------------------
// Provenance disclosure, "where did you get that?", per field
// ---------------------------------------------------------------------------

function FieldProvenance({ field, actions }: { field: ProfileField; actions: RowActions }) {
  const query = useOwnerProfileProvenance(field.fieldId);

  if (query.isPending) {
    return (
      <p className="owner-profile__note owner-profile__provenance-detail" aria-busy="true">
        Looking up where this came from…
      </p>
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        className="owner-profile__provenance-detail"
        error={query.error}
        title="Provenance unavailable"
        onRetry={() => void query.refetch()}
      />
    );
  }

  const answer = query.data;
  return (
    <div className="owner-profile__provenance-detail" data-testid={`profile-provenance-${field.fieldId}`}>
      {!answer.present && <p>This is not in your profile.</p>}
      {answer.present && answer.provenance && <p>{provenanceSummary(answer.provenance)}</p>}
      {answer.present && !answer.provenance && (
        <p>No provenance recorded, you wrote or edited this line by hand.</p>
      )}

      {answer.superseded.length > 0 ? (
        <>
          <p className="owner-profile__note">Earlier values, still kept in the file:</p>
          <ol className="owner-profile__superseded">
            {answer.superseded.map((entry, index) => (
              <li key={`${entry.value}-${String(index)}`}>
                <span className="owner-profile__value">{entry.value}</span>
                {entry.provenance && (
                  <span className="owner-profile__provenance">, {provenanceSummary(entry.provenance)}</span>
                )}
                {entry.supersededOn.length > 0 && (
                  <span className="owner-profile__note"> (superseded {entry.supersededOn})</span>
                )}
              </li>
            ))}
          </ol>
          <Button
            size="sm"
            disabled={actions.busy}
            onClick={() => { actions.onUndo(field.fieldId, field.label); }}
          >
            Undo: put the most recent earlier value back
          </Button>
        </>
      ) : (
        <p className="owner-profile__note">No earlier values kept, so there is nothing to undo.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A mechanical field (§4.3), labelled value, editable, forgettable
// ---------------------------------------------------------------------------

function FieldRow({ field, actions }: { field: ProfileField; actions: RowActions }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(field.value);
  const [provenanceOpen, setProvenanceOpen] = useState(false);
  const target: ProfileTarget = { kind: 'field', fieldId: field.fieldId };

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setEditing(false);
    actions.onSave(field, draft);
  }

  return (
    <div className="owner-profile__field" data-testid={`profile-field-${field.fieldId}`}>
      <dt className="owner-profile__field-label">{field.label}</dt>
      <dd className="owner-profile__field-body">
        {editing ? (
          <form className="owner-profile__edit-form" onSubmit={submit}>
            <Input
              className="owner-profile__edit-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label={`New value for ${field.label}`}
              autoComplete="off"
            />
            <Button type="submit" variant="primary" size="sm" disabled={actions.busy}>Save</Button>
            <Button
              size="sm"
              onClick={() => { setDraft(field.value); setEditing(false); }}
            >
              Cancel
            </Button>
            <p className="owner-profile__note">
              Saving keeps the current value in the file as an earlier value, so Undo can put it
              back. Nothing is overwritten silently.
            </p>
          </form>
        ) : (
          <>
            <span className="owner-profile__value">{field.value}</span>
            {field.provenance && (
              <span className="owner-profile__provenance">, {provenanceSummary(field.provenance)}</span>
            )}
            {!field.valid && (
              <p className="owner-profile__invalid" role="note">
                Kept exactly as written, but not a valid value
                {field.invalidReason !== undefined ? `: ${field.invalidReason}` : ' (no reason given)'}.
                Anything reading this falls back as if it were unset.
              </p>
            )}
            <div className="owner-profile__row-actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setDraft(field.value); setEditing(true); }}
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={provenanceOpen}
                onClick={() => setProvenanceOpen((open) => !open)}
              >
                Where did you get that?
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="owner-profile__danger"
                disabled={actions.busy}
                onClick={() => { actions.onForget(target, field.label); }}
              >
                Forget
              </Button>
            </div>
          </>
        )}
        {provenanceOpen && <FieldProvenance field={field} actions={actions} />}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A prose line (§4.4), rendered as the prose it is
// ---------------------------------------------------------------------------

function ProseRow({
  section,
  line,
  actions,
}: {
  section: ProfileSection;
  line: ProfileProseLine;
  actions: RowActions;
}) {
  const [provenanceOpen, setProvenanceOpen] = useState(false);
  // Addressed by content, never by position (§9.2). The section comes from the heading
  // this row is rendered under rather than the line's own `section` field: the heading is
  // what the file actually reads and what profile.append matches on, and it is guaranteed
  // non-empty by the parser.
  const target: ProfileTarget = { kind: 'line', section: section.heading, text: line.text };

  return (
    <li className="owner-profile__line" data-testid={`profile-line-${String(line.lineIndex)}`}>
      <p className="owner-profile__prose">
        {line.text}
        {line.provenance && (
          <span className="owner-profile__provenance">, {provenanceSummary(line.provenance)}</span>
        )}
      </p>
      <div className="owner-profile__row-actions">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={provenanceOpen}
          onClick={() => setProvenanceOpen((open) => !open)}
        >
          Where did you get that?
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="owner-profile__danger"
          disabled={actions.busy}
          onClick={() => { actions.onForget(target, line.text); }}
        >
          Forget
        </Button>
      </div>
      {provenanceOpen && (
        <div className="owner-profile__provenance-detail">
          {line.provenance
            ? <p>{provenanceSummary(line.provenance)}</p>
            : <p>No provenance recorded, you wrote or edited this line by hand.</p>}
          <p className="owner-profile__note">
            That is the whole answer for a note: notes keep no earlier versions, so there is
            nothing further to look up and nothing to undo.
          </p>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// A section
// ---------------------------------------------------------------------------

function SectionBlock({
  section,
  actions,
  onAppend,
}: {
  section: ProfileSection;
  actions: RowActions;
  onAppend: (section: ProfileSection, text: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const thirdParty = sectionHoldsThirdPartyData(section);
  const empty = section.fields.length === 0 && section.prose.length === 0;

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setAdding(false);
    setDraft('');
    onAppend(section, text);
  }

  return (
    <section
      className="owner-profile__section"
      data-testid={`profile-section-${section.heading}`}
      data-tier={section.tier}
      data-third-party={thirdParty ? 'true' : undefined}
      aria-label={section.heading}
    >
      <div className="owner-profile__section-head">
        <h4 className="owner-profile__section-title">{section.heading}</h4>
        <Chip size="sm">{section.tier === 'open' ? 'Open' : 'Closed'}</Chip>
      </div>
      <p className="owner-profile__note">{tierNote(section.tier)}</p>

      {thirdParty && (
        <p className="owner-profile__containment" role="note">
          These are facts about other people, who never agreed to be in a database. This surface
          keeps them out of logs, exports and diagnostics, and never copies them into anything it
          sends. They are shown here as plain text, for you.
        </p>
      )}

      {section.fields.length > 0 && (
        <dl className="owner-profile__fields">
          {section.fields.map((field) => (
            <FieldRow key={field.fieldId} field={field} actions={actions} />
          ))}
        </dl>
      )}

      {section.prose.length > 0 && (
        <ul className="owner-profile__lines">
          {section.prose.map((line) => (
            <ProseRow key={line.lineIndex} section={section} line={line} actions={actions} />
          ))}
        </ul>
      )}

      {empty && <p className="owner-profile__empty">Nothing recorded in this section.</p>}

      {adding ? (
        <form className="owner-profile__edit-form" onSubmit={submit}>
          <Input
            className="owner-profile__edit-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label={`New line in ${section.heading}`}
            autoComplete="off"
          />
          <Button type="submit" variant="primary" size="sm" disabled={actions.busy || draft.trim().length === 0}>
            Add
          </Button>
          <Button size="sm" onClick={() => { setDraft(''); setAdding(false); }}>
            Cancel
          </Button>
        </form>
      ) : (
        <Button size="sm" className="owner-profile__add" onClick={() => setAdding(true)}>
          Add a line to {section.heading}
        </Button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

const MALFORMED_WRITE =
  'The daemon answered, but did not say whether anything changed. Check the profile below before assuming it did.';

export function OwnerProfileSettings() {
  const profile = useOwnerProfileDocument();
  const status = useOwnerProfileStatus();
  const setField = useSetOwnerProfileField();
  const appendLine = useAppendOwnerProfileLine();
  const forget = useForgetOwnerProfile();
  const undo = useUndoOwnerProfile();
  const confirm = useConfirm();
  const [report, setReport] = useState<ActionReport | null>(null);

  const busy = setField.isPending || appendLine.isPending || forget.isPending || undo.isPending;

  const verbUnavailable =
    profile.isError && (isMethodUnavailableError(profile.error) || isMethodNotInvokableError(profile.error));

  function onSave(field: ProfileField, value: string) {
    setField.mutate(
      { fieldId: field.fieldId, value },
      {
        onSuccess: (outcome) => {
          setReport(writeReportLine(
            outcome,
            `Saved ${field.label}. The previous value is kept in the file, and Undo puts it back.`,
            MALFORMED_WRITE,
          ));
        },
        onError: (error) => { setReport({ tone: 'warning', text: formatError(error) }); },
      },
    );
  }

  function onAppend(section: ProfileSection, text: string) {
    appendLine.mutate(
      { section: section.heading, text },
      {
        onSuccess: (outcome) => {
          setReport(writeReportLine(outcome, `Added a line to ${section.heading}.`, MALFORMED_WRITE));
        },
        onError: (error) => { setReport({ tone: 'warning', text: formatError(error) }); },
      },
    );
  }

  function onUndo(fieldId: string, label: string) {
    undo.mutate(fieldId, {
      onSuccess: (outcome) => {
        setReport(writeReportLine(outcome, `Restored the previous value of ${label}.`, MALFORMED_WRITE));
      },
      onError: (error) => { setReport({ tone: 'warning', text: formatError(error) }); },
    });
  }

  async function onForget(target: ProfileTarget, label: string) {
    const confirmed = await confirm.ask({
      title: 'Forget this for good?',
      target: label,
      description: 'The line and its earlier values are deleted from your profile, and no copy is kept.',
      confirmLabel: 'Forget it',
      tone: 'danger',
    });
    if (!confirmed) return;
    forget.mutate(target, {
      onSuccess: (outcome) => { setReport(forgetReportLine(outcome, label)); },
      onError: (error) => { setReport({ tone: 'warning', text: formatError(error) }); },
    });
  }

  const actions: RowActions = {
    onSave,
    onForget: (target, label) => { void onForget(target, label); },
    onUndo,
    busy,
  };

  return (
    <SettingsBlock
      className="owner-profile"
      testId="owner-profile-settings"
      title="Owner profile"
      description="One Markdown file the daemon keeps, holding what the platform knows about you. Edit it here or by hand; your hand edits win and are never rewritten. Lines it learned from you carry a short note saying where it heard them."
    >

      <div className="owner-profile__report" role="status" aria-live="polite" aria-atomic="true">
        {report && (
          <span className={report.tone === 'warning' ? 'banner warning' : 'banner info'}>{report.text}</span>
        )}
      </div>

      {status.isSuccess && (
        <div className="owner-profile__status" data-testid="profile-status">
          <Chip tone={STATE_TONE[profileStateBadgeClass(status.data.state)]}>
            {profileStateLabel(status.data.state)}
          </Chip>
          {/* Inert text, never a link and never fetched. The same stance MemoryRecordDetail
              takes with a path-shaped provenance ref. */}
          <span className="owner-profile__path">{status.data.path}</span>
          {status.data.lineCount !== undefined && (
            <span className="owner-profile__note">{status.data.lineCount} lines</span>
          )}
          {status.data.fieldCount !== undefined && (
            <span className="owner-profile__note">{status.data.fieldCount} fields</span>
          )}
          {status.data.proseLineCount !== undefined && (
            <span className="owner-profile__note">{status.data.proseLineCount} notes</span>
          )}
        </div>
      )}

      {status.isSuccess && status.data.invalidFields.length > 0 && (
        <div className="owner-profile__invalid-list" role="note">
          <p className="owner-profile__subtitle">Values kept as written but not valid</p>
          <ul>
            {status.data.invalidFields.map((entry) => (
              <li key={entry.fieldId}>{entry.fieldId}: {entry.reason}</li>
            ))}
          </ul>
        </div>
      )}

      {profile.isPending && (
        <div aria-label="Loading owner profile" aria-busy="true">
          <SkeletonBlock variant="text" lines={4} />
        </div>
      )}

      {verbUnavailable && (
        <EmptyState
          icon={<UserRound size={24} />}
          title="This daemon does not serve an owner profile"
          description="The connected daemon build has no owner-profile verbs. Upgrade it to keep your profile here."
        />
      )}

      {profile.isError && !verbUnavailable && (
        <ErrorState
          error={profile.error}
          title="Owner profile unavailable"
          onRetry={() => void profile.refetch()}
        />
      )}

      {profile.isSuccess && profile.data.state === 'disabled' && (
        <p className="banner info" role="status" data-testid="profile-disabled">
          {profileDisabledLine()}
        </p>
      )}

      {profile.isSuccess && profile.data.state === 'unavailable' && (
        <div className="banner warning" role="alert" data-testid="profile-unavailable">
          <p>{profileUnavailableLine(profile.data.reason, profile.data.path)}</p>
          <p className="owner-profile__note">
            Nothing is shown below because the file could not be read, not because your profile is
            empty.
          </p>
        </div>
      )}

      {profile.isSuccess && profile.data.state === 'loaded' && profile.data.sections.length === 0 && (
        <EmptyState
          icon={<UserRound size={24} />}
          title="Your profile is loaded and empty"
          description="Nothing has been recorded yet. Tell the agent something about yourself, or add a line by hand in the file."
        />
      )}

      {profile.isSuccess && profile.data.state === 'loaded' && profile.data.sections.length > 0 && (
        <div className="owner-profile__sections">
          {profile.data.sections.map((section) => (
            <SectionBlock key={section.heading} section={section} actions={actions} onAppend={onAppend} />
          ))}
        </div>
      )}

      {confirm.element}
    </SettingsBlock>
  );
}
