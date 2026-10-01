/**
 * One approval in the Work view's detail pane (design doc "Data views", the
 * Work mockup's "Waiting for approval" pane): the command in a code frame, who
 * asked and the risk as facts, a kit Select for "Remember", Approve as the one
 * primary button and Deny as the secondary, the deny reason and the "why" as
 * disclosures.
 *
 * Everything the old approval card did is here: per-hunk edit selection (an
 * index array only; the daemon computes the modified edit), remember tiers
 * rendered verbatim from the ask, the exec-prompt answer path, claim and cancel
 * for a pending ask, the decision trail and the fix session an accepted CI
 * offer started. A claimed ask is not actionable here (two surfaces must never
 * both resolve one approval); a resolved one is history.
 */
import { useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { ApprovalRecord } from '../../lib/goodvibes';
import {
  attributionLabel,
  auditEntryLabel,
  auditTrail,
  hunkSummary,
  isActionableApproval,
  isDurableRememberTier,
  isTerminalApprovalStatus,
  judgmentLabel,
  judgmentVerdict,
  partialApprovalLabel,
  readApprovalEditHunks,
  readExecPromptAsk,
  readRememberOptions,
  statusLabel,
} from '../../lib/approvals';
import { compactJson } from '../../lib/object';
import { CodeFrame, DetailPane, DetailSection, Disclosure, Facts } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { Field, Input } from '../../components/ui/Field';
import { Select } from '../../components/ui/Select';
import { StatusDot } from '../../components/ui/StatusDot';
import type { ApprovalActions } from './useApprovalActions';
import { approvalRequester, approvalTitle, sentenceCase, whenLabel } from './work-items';

/** The command-like text an ask is about, for the code frame. */
export function approvalCommandText(record: ApprovalRecord): { label: string; text: string } {
  const args = record.request.args;
  const pick = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
  const command = pick('command') || pick('cmd') || pick('script');
  if (command) return { label: 'Command', text: command };
  const hunks = readApprovalEditHunks(record);
  if (hunks) {
    const files = [...new Set(hunks.map((h) => h.path))];
    return { label: files.length === 1 ? 'File' : 'Files', text: files.join('\n') };
  }
  const list = args.commands;
  if (Array.isArray(list) && list.length > 0 && list.every((c) => typeof c === 'string')) {
    return { label: list.length === 1 ? 'Command' : 'Commands', text: (list as string[]).join('\n') };
  }
  const path = pick('path') || pick('file_path') || pick('filePath') || pick('url');
  if (path) return { label: record.request.tool, text: path };
  const json = compactJson(args);
  return { label: 'Arguments', text: json === '{}' ? record.request.tool : json };
}

const RISK_WORDS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

export interface ApprovalDetailProps {
  record: ApprovalRecord;
  actions: ApprovalActions;
  onClose?: () => void;
  onOpenSession?: (sessionId: string) => void;
}

export function ApprovalDetail({ record, actions, onClose, onOpenSession }: ApprovalDetailProps) {
  const hunks = useMemo(() => readApprovalEditHunks(record), [record]);
  const actionable = isActionableApproval(record);
  const terminal = isTerminalApprovalStatus(record.status);
  const partialLabel = useMemo(() => partialApprovalLabel(record), [record]);
  const auditEntries = useMemo(() => auditTrail(record), [record]);
  const attribution = useMemo(() => attributionLabel(record.request.attribution), [record]);
  const verdict = useMemo(() => judgmentVerdict(record), [record]);
  const rememberOptions = useMemo(() => readRememberOptions(record), [record]);
  const execPrompt = useMemo(() => readExecPromptAsk(record), [record]);
  const command = useMemo(() => approvalCommandText(record), [record]);

  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const [rememberTier, setRememberTier] = useState('');
  const [denyReason, setDenyReason] = useState('');
  const [execAnswer, setExecAnswer] = useState('');

  const approving = actions.approve.isPending && actions.approve.variables?.id === record.id;
  const denying = actions.deny.isPending && actions.deny.variables?.id === record.id;
  const claiming = actions.claim.isPending && actions.claim.variables === record.id;
  const cancelling = actions.cancel.isPending && actions.cancel.variables === record.id;
  const busy = approving || denying || claiming || cancelling;

  const tool = record.request.tool;
  const risk = record.request.analysis.riskLevel;
  const approveExtras = rememberTier ? { rememberTier } : {};
  const approve = (extra?: { selectedHunks?: readonly number[]; answer?: string }) => actions.approve.mutate({
    id: record.id,
    ...approveExtras,
    ...extra,
    ...(hunks ? { totalHunks: hunks.length } : {}),
  });
  const deny = () => actions.deny.mutate({ id: record.id, ...(denyReason.trim() ? { reason: denyReason.trim() } : {}) });

  const toggleHunk = (index: number) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    return next;
  });

  const fixSessionId = record.status === 'approved' ? record.fixSessionId : undefined;
  const fixSessionError = record.status === 'approved' ? record.fixSessionError : undefined;

  const statusWord = terminal ? sentenceCase(statusLabel(record.status)) : record.status === 'claimed' ? 'Claimed' : execPrompt ? 'Waiting for your answer' : 'Waiting for approval';

  const footer = actionable ? (
    execPrompt ? (
      <>
        <Button variant="primary" disabled={busy || execAnswer.length === 0} onClick={() => approve({ answer: execAnswer })}>
          {approving ? 'Sending…' : 'Send answer'}
        </Button>
        <Button disabled={busy} onClick={deny}>{denying ? 'Stopping…' : 'Stop command'}</Button>
        <span className="work-footer__spacer" />
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => actions.claim.mutate(record.id)} title="Lock this approval to your surface">
          {claiming ? 'Claiming…' : 'Claim'}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => actions.cancel.mutate(record.id)} title="Withdraw without a decision">
          {cancelling ? 'Cancelling…' : 'Withdraw'}
        </Button>
      </>
    ) : (
      <>
        <Button variant="primary" disabled={busy} onClick={() => approve()}>
          {approving ? 'Approving…' : hunks ? 'Approve all' : 'Approve'}
        </Button>
        {hunks && (
          <Button
            disabled={selected.size === 0 || busy}
            onClick={() => approve({ selectedHunks: [...selected].sort((a, b) => a - b) })}
            title="Approve only the checked hunks: the daemon computes the modified edit"
          >
            Approve selected ({selected.size})
          </Button>
        )}
        <Button disabled={busy} onClick={deny}>{denying ? 'Denying…' : 'Deny'}</Button>
        <span className="work-footer__spacer" />
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => actions.claim.mutate(record.id)} title="Lock this approval to your surface">
          {claiming ? 'Claiming…' : 'Claim'}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => actions.cancel.mutate(record.id)} title="Withdraw without a decision">
          {cancelling ? 'Cancelling…' : 'Withdraw'}
        </Button>
      </>
    )
  ) : undefined;

  return (
    <DetailPane
      title={approvalTitle(record)}
      status={(
        <span className="work-status">
          <StatusDot tone={terminal ? (record.status === 'approved' ? 'ok' : record.status === 'denied' ? 'bad' : 'idle') : record.status === 'claimed' ? 'info' : 'warn'} />
          {statusWord}
        </span>
      )}
      meta={whenLabel(record.createdAt)}
      onClose={onClose}
      closeLabel="Close approval"
      footer={footer}
    >
      {execPrompt ? (
        <>
          <CodeFrame label="Command">{execPrompt.command || '(command unknown)'}</CodeFrame>
          <DetailSection title="Waiting on">
            <p className="work-prose">{execPrompt.prompt || '(prompt text unavailable)'}</p>
          </DetailSection>
          {execPrompt.recentOutput && <CodeFrame label="Recent output">{execPrompt.recentOutput}</CodeFrame>}
          {actionable && (
            <Field label="Your answer" help="It feeds the waiting command.">
              <Input
                aria-label={`Answer for ${execPrompt.command || tool}`}
                placeholder="Type the reply the command is waiting for"
                value={execAnswer}
                disabled={busy}
                onChange={(e) => setExecAnswer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && execAnswer.length > 0) approve({ answer: execAnswer });
                }}
              />
            </Field>
          )}
        </>
      ) : (
        <CodeFrame label={command.label}>{command.text}</CodeFrame>
      )}

      {record.request.analysis.summary && !execPrompt && (
        <p className="work-prose">{record.request.analysis.summary}</p>
      )}

      <Facts
        items={[
          { label: 'Requested by', value: attribution ?? approvalRequester(record) },
          { label: 'Risk', value: risk ? (RISK_WORDS[risk] ?? risk) : '' },
          { label: 'Category', value: record.request.category },
          { label: 'Working directory', value: record.request.workingDirectory ?? '' },
          {
            label: 'Model judgment',
            value: verdict ? <span title="Proposed by the sandbox model-judgment tier: annotate-only, you still decide">{judgmentLabel(verdict)}</span> : '',
          },
          { label: 'Session', value: record.sessionId ?? '' },
        ]}
      />

      {record.status === 'claimed' && (
        <p className="dv-notice" role="note">Claimed by {record.claimedBy ?? 'another surface'}, not actionable here.</p>
      )}

      {terminal && (
        <p className="dv-notice" role="note">
          {sentenceCase(statusLabel(record.status))}
          {whenLabel(record.resolvedAt) ? ` ${whenLabel(record.resolvedAt)}` : ''}
          {record.resolvedBy ? ` by ${record.resolvedBy}` : ''}
          {partialLabel ? `, ${partialLabel}` : ''}
          {record.decision?.reason ? `, reason: ${record.decision.reason}` : ''}
        </p>
      )}

      {fixSessionId && onOpenSession && (
        <div>
          <Button icon={<ExternalLink aria-hidden="true" />} onClick={() => onOpenSession(fixSessionId)} title="Open the fix session this acceptance started">
            Open fix session
          </Button>
        </div>
      )}
      {fixSessionError && (
        <p className="dv-notice dv-notice--bad" role="note">The fix session could not start; {fixSessionError}</p>
      )}

      {actionable && !execPrompt && hunks && (
        <DetailSection title={`Edits (${hunks.length})`}>
          <ul className="work-hunks" aria-label="Edit hunks">
            {hunks.map((hunk, index) => (
              <li key={hunk.id ?? index} className="work-hunks__row">
                <Checkbox checked={selected.has(index)} onChange={() => toggleHunk(index)}>
                  <span className="work-hunks__summary">{hunkSummary(hunk)}</span>
                </Checkbox>
              </li>
            ))}
          </ul>
        </DetailSection>
      )}

      {actionable && !execPrompt && rememberOptions.length > 0 && (
        <Field
          label="Remember"
          help={rememberTier ? rememberOptions.find((o) => o.tier === rememberTier)?.detail : 'Ask again next time.'}
        >
          <Select
            aria-label={`Remember scope for ${tool}`}
            value={rememberTier}
            disabled={busy}
            onChange={setRememberTier}
            options={[
              { value: '', label: 'Just this once' },
              ...rememberOptions.map((option) => ({
                value: option.tier,
                label: `${option.label}${isDurableRememberTier(option.tier) ? ' (saved as a rule)' : ''}`,
              })),
            ]}
          />
        </Field>
      )}

      {actionable && (
        <Disclosure summary="Add a reason for denying">
          <Input
            aria-label={`Deny reason for ${tool}`}
            placeholder="Fed back to the model with the denial"
            value={denyReason}
            disabled={busy}
            onChange={(e) => setDenyReason(e.target.value)}
          />
        </Disclosure>
      )}

      {record.request.analysis.reasons.length > 0 && (
        <Disclosure summary="Why is this asked?">
          <ul className="work-list">
            {record.request.analysis.reasons.map((reason, i) => <li key={i}>{reason}</li>)}
          </ul>
        </Disclosure>
      )}

      {terminal && (
        <Disclosure summary="Decision trail">
          {auditEntries.length > 0 ? (
            <ul className="work-list">
              {auditEntries.map((entry) => (
                <li key={entry.id}>{auditEntryLabel(entry)}: {whenLabel(entry.createdAt)}</li>
              ))}
            </ul>
          ) : (
            <p className="work-prose">No decision trail recorded.</p>
          )}
        </Disclosure>
      )}
    </DetailPane>
  );
}
