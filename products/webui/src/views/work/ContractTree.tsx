/** Read-only projection of recorded contract evidence. No local judgments or actions. */
import { useId } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/contracts';
import { CodeFrame, DetailSection, Disclosure, Facts } from '../../components/data-view/DataView';
import { NativeContractDetails } from './NativeContractDetails';
import '../../styles/components/contract-tree.css';

export type ContractRecord = OperatorMethodOutput<'contracts.get'>;
type Criterion = ContractRecord['criteria'][number];
type Check = ContractRecord['checks'][number];
type Unit = ContractRecord['units'][number];
type CheckIndex = ReadonlyMap<string, readonly string[]>;

function Empty({ children }: { children: ReactNode }) {
  return <p className="contract-tree__empty">{children}</p>;
}
function Text({ children }: { children: string }) {
  return <p className="contract-tree__text">{children}</p>;
}
function Ids({ values }: { values: readonly string[] }) {
  return values.length ? <span className="contract-tree__ids">{values.map((value, i) => <span key={`${value}-${i}`}>{value}</span>)}</span> : <span>None recorded</span>;
}
function RecordedTime({ at }: { at: number }) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return <span>{String(at)}</span>;
  const iso = date.toISOString();
  return <time dateTime={iso} title={`Recorded timestamp: ${at}`}>{iso}</time>;
}
function Summary({ title, status }: { title: string; status: string }) {
  return <span className="contract-tree__summary"><span>{title}</span><span className="contract-tree__status">{status}</span></span>;
}
/** Reveal a recorded check even when its group, unit, or attempt is collapsed. */
function revealCheck(event: MouseEvent<HTMLAnchorElement>, targetId: string) {
  const target = document.getElementById(targetId);
  if (!target) return;
  event.preventDefault();
  for (let current: HTMLElement | null = target; current; current = current.parentElement) {
    if (current instanceof HTMLDetailsElement) current.open = true;
  }
  const disclosure = target.querySelector('details');
  if (disclosure) disclosure.open = true;
  target.querySelector<HTMLElement>('summary')?.focus();
  target.scrollIntoView({ block: 'nearest' });
}
function CheckReference({ checkId, index }: { checkId: string; index: CheckIndex }) {
  const targets = index.get(checkId);
  if (!targets?.length) return <span className="contract-tree__missing">{checkId} · Check not present in this record</span>;
  return <span className="contract-tree__ids">{targets.map((target, i) => <a key={target} className="work-link" href={`#${target}`} onClick={(event) => revealCheck(event, target)}>
    {checkId}{targets.length > 1 ? ` (${i + 1})` : ''}
  </a>)}</span>;
}
function Criteria({ criteria, index }: { criteria: readonly Criterion[]; index: CheckIndex }) {
  return <DetailSection title={`Criteria (${criteria.length})`}>
    {criteria.length === 0 ? <Empty>No criteria recorded.</Empty> : <ul className="contract-tree__list" aria-label="Criteria">
      {criteria.map((criterion, position) => <li key={`${criterion.id}-${position}`}>
        <Disclosure defaultOpen summary={<Summary title={criterion.text || criterion.id} status={criterion.status} />}>
          <Facts items={[
            { label: 'Criterion id', value: criterion.id }, { label: 'Origin', value: criterion.origin },
            { label: 'Disposition', value: criterion.disposition }, { label: 'Disposition reason', value: criterion.dispositionReason },
            { label: 'Serves', value: <Ids values={criterion.serves} /> },
          ]} />
          <DetailSection title="Source quote">{criterion.quote ? <blockquote className="contract-tree__quote">{criterion.quote}</blockquote> : <Empty>No source quote recorded.</Empty>}</DetailSection>
          <Disclosure summary={`Recorded readings (${criterion.readings.length})`} defaultOpen>
            {criterion.readings.length === 0 ? <Empty>No readings recorded.</Empty> : <ol className="contract-tree__list" aria-label={`Readings for ${criterion.id}`}>
              {criterion.readings.map((reading, i) => <li key={`${reading.checkId}-${i}`}><Facts items={[
                { label: 'Check', value: <CheckReference checkId={reading.checkId} index={index} /> },
                { label: 'Recorded at', value: <RecordedTime at={reading.at} /> }, { label: 'Verdict', value: reading.verdict },
                { label: 'Probability unmet', value: String(reading.probabilityUnmet) }, { label: 'Outcome', value: reading.outcome },
                { label: 'Severity', value: reading.severity }, { label: 'Decision id', value: reading.decisionId },
                { label: 'Severity decision id', value: reading.severityDecisionId },
              ]} /></li>)}
            </ol>}
          </Disclosure>
        </Disclosure>
      </li>)}
    </ul>}
  </DetailSection>;
}
function CheckEvidence({ check }: { check: Check }) {
  const quality = Object.entries(check.quality);
  return <>
    <Facts items={[
      { label: 'Check id', value: check.id }, { label: 'Recorded at', value: <RecordedTime at={check.at} /> },
      { label: 'Trigger', value: check.trigger }, { label: 'Result', value: check.result },
      { label: 'Decision ids', value: <Ids values={check.decisionIds} /> },
      { label: 'Problems', value: <Ids values={check.problems ?? []} /> }, { label: 'Quality problems', value: <Ids values={check.qualityProblems ?? []} /> },
    ]} />
    <DetailSection title="Evidence digest">{check.evidenceDigest ? <Text>{check.evidenceDigest}</Text> : <Empty>No evidence digest recorded.</Empty>}</DetailSection>
    <DetailSection title="Goal reading"><Facts items={[
      { label: 'Verdict', value: check.goal.verdict }, { label: 'Probability unmet', value: String(check.goal.probabilityUnmet) }, { label: 'Outcome', value: check.goal.outcome },
    ]} /></DetailSection>
    <DetailSection title="Quality readings">
      {quality.length === 0 ? <Empty>No quality readings recorded.</Empty> : <ul className="contract-tree__list" aria-label="Quality readings">
        {quality.map(([item, reading]) => <li key={item}><Facts items={[
          { label: 'Quality item', value: item }, { label: 'Verdict', value: reading.verdict }, { label: 'Outcome', value: reading.outcome },
        ]} /></li>)}
      </ul>}
    </DetailSection>
    <DetailSection title="Claim verification">
      {check.claims ? <><Facts items={[{ label: 'Kind', value: check.claims.kind }]} /><Text>{check.claims.summary}</Text></> : <Empty>No claim verification recorded.</Empty>}
    </DetailSection>
    <DetailSection title={`Gates (${check.gates?.length ?? 0})`}>
      {!check.gates?.length ? <Empty>No gates recorded.</Empty> : <ul className="contract-tree__list" aria-label="Gates">
        {check.gates.map((gate, i) => <li key={`${gate.gate}-${i}`}>
          <Disclosure summary={<Summary title={gate.gate} status={gate.skipped === true ? 'skipped' : `passed: ${gate.passed}`} />}>
            <Facts items={[
              { label: 'Passed', value: String(gate.passed) }, { label: 'Skipped', value: gate.skipped === undefined ? 'Not recorded' : String(gate.skipped) },
              { label: 'Duration (ms)', value: String(gate.durationMs) },
            ]} />
            {gate.output ? <CodeFrame label="Recorded output">{gate.output}</CodeFrame> : <Empty>No gate output recorded.</Empty>}
          </Disclosure>
        </li>)}
      </ul>}
    </DetailSection>
  </>;
}
function Checks({ checks, scope }: { checks: readonly Check[]; scope: string }) {
  return <DetailSection title={`Checks (${checks.length})`}>
    {checks.length === 0 ? <Empty>No checks recorded.</Empty> : <ul className="contract-tree__list" aria-label="Checks">
      {checks.map((check, i) => <li id={`${scope}-check-${i}`} key={`${check.id}-${i}`}>
        <Disclosure summary={<Summary title={check.id} status={check.result} />}><CheckEvidence check={check} /></Disclosure>
      </li>)}
    </ul>}
  </DetailSection>;
}
function UnitTree({ unit, scope, index, attempt = false }: { unit: Unit; scope: string; index: CheckIndex; attempt?: boolean }) {
  return <Disclosure summary={<Summary title={`${attempt ? 'Attempt' : 'Unit'}: ${unit.title || unit.id}`} status={unit.status} />} defaultOpen={!attempt}>
    <Facts items={[
      { label: 'Unit id', value: unit.id }, { label: 'Group id', value: unit.groupId }, { label: 'Role', value: unit.role },
      { label: 'Depends on', value: <Ids values={unit.dependsOn} /> }, { label: 'Attempts', value: unit.attempts },
      { label: 'Attempt of', value: unit.attemptOf }, { label: 'Attempt index', value: unit.attemptIndex },
      { label: 'Agent ids', value: <Ids values={unit.agentIds} /> }, { label: 'Active agent', value: unit.activeAgentId },
      { label: 'Files', value: <Ids values={unit.files} /> }, { label: 'Touched paths', value: <Ids values={unit.touchedPaths} /> },
      { label: 'Fix rounds', value: unit.fixRounds }, { label: 'Fresh agents', value: unit.freshAgents }, { label: 'Transport retries', value: unit.transportRetries },
    ]} />
    <DetailSection title="Unit goal">{unit.goal ? <Text>{unit.goal}</Text> : <Empty>No unit goal recorded.</Empty>}</DetailSection>
    <Disclosure summary="Unit brief">{unit.brief ? <Text>{unit.brief}</Text> : <Empty>No unit brief recorded.</Empty>}</Disclosure>
    <Criteria criteria={unit.criteria} index={index} /><Checks checks={unit.checks} scope={scope} />
    {unit.nudges.length > 0 && <Disclosure summary={`Nudges (${unit.nudges.length})`}>
      <ol className="contract-tree__list" aria-label="Nudges">{unit.nudges.map((nudge, i) => <li key={`${nudge.id}-${i}`}>
        <Text>{nudge.text}</Text><Facts items={[
          { label: 'Nudge id', value: nudge.id }, { label: 'Check', value: <CheckReference checkId={nudge.checkId} index={index} /> },
          { label: 'Recorded at', value: <RecordedTime at={nudge.at} /> }, { label: 'Kinds', value: <Ids values={nudge.kinds} /> },
          { label: 'Criterion ids', value: <Ids values={nudge.criterionIds} /> }, { label: 'Delivery', value: nudge.delivery },
          { label: 'Agent id', value: nudge.agentId }, { label: 'Consumed at', value: nudge.consumedAt === undefined ? undefined : <RecordedTime at={nudge.consumedAt} /> },
        ]} />
      </li>)}</ol>
    </Disclosure>}
    {unit.attemptSelection && <DetailSection title="Recorded attempt selection">
      <Text>{unit.attemptSelection.reasons}</Text><Facts items={[
        { label: 'Engine group id', value: unit.attemptSelection.engineGroupId }, { label: 'Candidate ids', value: <Ids values={unit.attemptSelection.candidateIds} /> },
        { label: 'Proposed id', value: unit.attemptSelection.proposedId }, { label: 'Outcome', value: unit.attemptSelection.outcome },
        { label: 'Decision id', value: unit.attemptSelection.decisionId }, { label: 'Picked id', value: unit.attemptSelection.pickedId ?? 'No selection recorded' },
      ]} />
    </DetailSection>}
    {unit.attemptUnits !== undefined && <DetailSection title={`Attempt units (${unit.attemptUnits.length})`}>
      {unit.attemptUnits.length === 0 ? <Empty>No attempt units recorded.</Empty> : <ul className="contract-tree__list contract-tree__branch" aria-label={`Attempts for ${unit.id}`}>
        {unit.attemptUnits.map((candidate, i) => <li key={`${candidate.id}-${i}`}><UnitTree unit={candidate} scope={`${scope}-attempt-${i}`} index={index} attempt /></li>)}
      </ul>}
    </DetailSection>}
    {unit.answer !== undefined && <DetailSection title="Unit answer">{unit.answer ? <Text>{unit.answer}</Text> : <Empty>No unit answer recorded.</Empty>}</DetailSection>}
    {unit.lastOutput !== undefined && <Disclosure summary="Last output"><Text>{unit.lastOutput}</Text></Disclosure>}
    {unit.failureReason !== undefined && <DetailSection title="Failure reason"><Text>{unit.failureReason}</Text></DetailSection>}
  </Disclosure>;
}
function Escalations({ escalations }: { escalations: ContractRecord['escalations'] }) {
  return <DetailSection title={`Escalation history (${escalations.length})`}>
    {escalations.length === 0 ? <Empty>No escalations recorded.</Empty> : <ol className="contract-tree__list" aria-label="Escalation history">
      {escalations.map((escalation, i) => <li key={`${escalation.id}-${i}`}>
        <Disclosure summary={<Summary title={escalation.question || escalation.id} status={escalation.resolvedAt === undefined ? 'No resolution recorded' : 'Resolution recorded'} />} defaultOpen>
          <Facts items={[
            { label: 'Escalation id', value: escalation.id }, { label: 'Recorded at', value: <RecordedTime at={escalation.at} /> },
            { label: 'Scope', value: escalation.scope }, { label: 'Target id', value: escalation.targetId }, { label: 'Reason', value: escalation.reason },
            { label: 'Unmet criterion ids', value: <Ids values={escalation.unmetCriterionIds} /> }, { label: 'Decision ids', value: <Ids values={escalation.decisionIds ?? []} /> },
            { label: 'Resolved at', value: escalation.resolvedAt === undefined ? undefined : <RecordedTime at={escalation.resolvedAt} /> },
          ]} />
          {escalation.reply ? <DetailSection title="Recorded owner reply"><Text>{escalation.reply.text}</Text><Facts items={[
            { label: 'Reading', value: escalation.reply.reading }, { label: 'Outcome', value: escalation.reply.outcome }, { label: 'Decision id', value: escalation.reply.decisionId },
          ]} /></DetailSection> : <Empty>No owner reply recorded.</Empty>}
        </Disclosure>
      </li>)}
    </ol>}
  </DetailSection>;
}
export function ContractTree({ contract }: { contract: ContractRecord }) {
  const prefix = useId();
  const index = new Map<string, string[]>();
  const referencedUnits = new Set(contract.groups.flatMap((group) => group.unitIds));
  const ungroupedUnits = contract.units.filter((unit) => !referencedUnits.has(unit.id));
  function indexChecks(checks: readonly Check[], scope: string) {
    checks.forEach((check, i) => index.set(check.id, [...(index.get(check.id) ?? []), `${scope}-check-${i}`]));
  }
  function indexUnit(unit: Unit, scope: string) {
    indexChecks(unit.checks, scope);
    unit.attemptUnits?.forEach((attempt, i) => indexUnit(attempt, `${scope}-attempt-${i}`));
  }
  indexChecks(contract.checks, prefix);
  contract.groups.forEach((group, i) => {
    indexChecks(group.checks, `${prefix}-group-${i}`);
    group.unitIds.forEach((id, j) => {
      const unit = contract.units.find((candidate) => candidate.id === id);
      if (unit) indexUnit(unit, `${prefix}-group-${i}-unit-${j}`);
    });
  });
  ungroupedUnits.forEach((unit, i) => indexUnit(unit, `${prefix}-ungrouped-${i}`));
  return <div className="contract-tree">
    <NativeContractDetails contract={contract} />
    <DetailSection title="Goal">{contract.goal ? <Text>{contract.goal}</Text> : <Empty>No goal recorded.</Empty>}</DetailSection>
    <Disclosure summary="Original ask" defaultOpen>{contract.ask ? <Text>{contract.ask}</Text> : <Empty>No original ask recorded.</Empty>}</Disclosure>
    <Criteria criteria={contract.criteria} index={index} /><Checks checks={contract.checks} scope={prefix} />
    <DetailSection title={`Groups (${contract.groups.length})`}>
      {contract.groups.length === 0 ? <Empty>No groups recorded.</Empty> : <ul className="contract-tree__list contract-tree__branch" aria-label="Groups">
        {contract.groups.map((group, i) => <li key={`${group.id}-${i}`}>
          <Disclosure summary={<Summary title={`Group: ${group.title || group.id}`} status={group.status} />} defaultOpen>
            <Facts items={[
              { label: 'Group id', value: group.id }, { label: 'Kind', value: group.kind },
              { label: 'Depends on', value: <Ids values={group.dependsOn} /> }, { label: 'Fix rounds', value: group.fixRounds },
            ]} />
            <DetailSection title="Group goal">{group.goal ? <Text>{group.goal}</Text> : <Empty>No group goal recorded.</Empty>}</DetailSection>
            {group.repairs && <DetailSection title="Repairs"><Facts items={[
              { label: 'Scope', value: group.repairs.scope }, { label: 'Target id', value: group.repairs.targetId }, { label: 'Criterion ids', value: <Ids values={group.repairs.criterionIds} /> },
            ]} /></DetailSection>}
            <Criteria criteria={group.criteria} index={index} /><Checks checks={group.checks} scope={`${prefix}-group-${i}`} />
            <DetailSection title={`Units (${group.unitIds.length})`}>
              {group.unitIds.length === 0 ? <Empty>No units referenced by this group.</Empty> : <ul className="contract-tree__list contract-tree__branch" aria-label={`Units for ${group.id}`}>
                {group.unitIds.map((id, j) => {
                  const unit = contract.units.find((candidate) => candidate.id === id);
                  return <li key={`${id}-${j}`}>{unit ? <UnitTree unit={unit} scope={`${prefix}-group-${i}-unit-${j}`} index={index} /> : <Empty>Unit {id} is referenced by this group but is not present in this record.</Empty>}</li>;
                })}
              </ul>}
            </DetailSection>
          </Disclosure>
        </li>)}
      </ul>}
    </DetailSection>
    {ungroupedUnits.length > 0 && <DetailSection title={`Units outside recorded groups (${ungroupedUnits.length})`}>
      <ul className="contract-tree__list contract-tree__branch" aria-label="Units outside recorded groups">
        {ungroupedUnits.map((unit, i) => <li key={`${unit.id}-${i}`}><UnitTree unit={unit} scope={`${prefix}-ungrouped-${i}`} index={index} /></li>)}
      </ul>
    </DetailSection>}
    {contract.units.length === 0 && <Empty>No units recorded.</Empty>}
    <Escalations escalations={contract.escalations} />
    <Disclosure summary={`Decision history (${contract.decisions.length})`}>
      {contract.decisions.length === 0 ? <Empty>No decisions recorded.</Empty> : <ol className="contract-tree__list" aria-label="Decision history">
        {contract.decisions.map((decision, i) => <li key={`${decision.id}-${i}`}><Facts items={[
          { label: 'Decision id', value: decision.id }, { label: 'Recorded at', value: <RecordedTime at={decision.at} /> },
          { label: 'Action', value: decision.action }, { label: 'Target id', value: decision.targetId },
          { label: 'Reason', value: decision.reason }, { label: 'Decision ids', value: <Ids values={decision.decisionIds} /> },
        ]} /></li>)}
      </ol>}
    </Disclosure>
    <DetailSection title="Recorded result">
      <Facts items={[
        { label: 'Status', value: contract.status }, { label: 'Status line', value: contract.statusLine },
        { label: 'Completed at', value: contract.completedAt === undefined ? undefined : <RecordedTime at={contract.completedAt} /> },
        { label: 'Failure kind', value: contract.failureKind }, { label: 'Error', value: contract.error },
      ]} />
      <DetailSection title="Answer">{contract.answer ? <Text>{contract.answer}</Text> : <Empty>No answer recorded.</Empty>}</DetailSection>
      <DetailSection title="Commit">{contract.commit ? <Facts items={[
        { label: 'Commit status', value: contract.commit.status }, { label: 'Hash', value: contract.commit.hash }, { label: 'Note', value: contract.commit.note },
      ]} /> : <Empty>No commit result recorded.</Empty>}</DetailSection>
    </DetailSection>
  </div>;
}
