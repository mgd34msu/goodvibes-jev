/** Native records are informational receipts, never executable instructions or permission. */
import type { ReactNode } from 'react';
import { DetailSection, Disclosure, Facts } from '../../components/data-view/DataView';
import type { ContractRecord } from './ContractTree';

type Source = NonNullable<ContractRecord['nativeSource']>;
type Decisions = NonNullable<ContractRecord['nativeDecisions']>;
type DecisionRecord = Decisions['history'][number];
type Decision = DecisionRecord['decision'];
type Binding = Decision['binding'];
type VersionRef = Decision['evidence'][number];
type Waiting = NonNullable<ContractRecord['nativeWaiting']>;
type Admission = NonNullable<ContractRecord['durableAdmission']>;
type Snapshot = NonNullable<ContractRecord['inputSnapshot']>;

function Text({ children }: { children: string }) {
  return <p className="contract-tree__text">{children}</p>;
}
function Empty({ children }: { children: ReactNode }) {
  return <p className="contract-tree__empty">{children}</p>;
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
function Reference({ reference }: { reference: VersionRef }) {
  return <Facts items={[{ label: 'Reference id', value: reference.id }, { label: 'Revision', value: reference.revision }]} />;
}
function BindingDetails({ binding }: { binding: Binding }) {
  return <Facts items={[
    { label: 'Source id', value: binding.sourceId }, { label: 'Input revision', value: binding.inputRevision },
    { label: 'Action id', value: binding.actionId }, { label: 'Action revision', value: binding.actionRevision },
    { label: 'Authority id', value: binding.authorityId }, { label: 'Authority revision', value: binding.authorityRevision },
    { label: 'Scope id', value: binding.scopeId }, { label: 'Scope revision', value: binding.scopeRevision },
  ]} />;
}
function SourceDetails({ source }: { source: Source }) {
  return <>
    <DetailSection title="Original native goal"><Text>{source.goal}</Text></DetailSection>
    <DetailSection title={`Original native criteria (${source.criteria.length})`}>
      <ol className="contract-tree__list contract-tree__ordered" aria-label="Original native criteria">
        {source.criteria.map((criterion, i) => <li key={i}><Text>{criterion}</Text></li>)}
      </ol>
    </DetailSection>
    <Facts items={[
      { label: 'Source id', value: source.sourceId }, { label: 'Source revision', value: source.sourceRevision },
      { label: 'Input revision', value: source.inputRevision }, { label: 'Criteria id', value: source.criteriaId },
      { label: 'Criteria revision', value: source.criteriaRevision },
    ]} />
  </>;
}
function TransportWaiting({ waiting }: { waiting: Waiting }) {
  return <DetailSection title="Transport waiting">
    <Empty>Shared-port retry progress describes transport attempts. It does not record a semantic outcome.</Empty>
    {waiting.requests.length === 0 ? <Empty>No waiting requests recorded.</Empty> : <ul className="contract-tree__list" aria-label="Transport waiting requests">
      {waiting.requests.map((request, i) => <li key={`${request.logicalRequestId}-${i}`}>
        <Disclosure defaultOpen summary={`Waiting request: ${request.logicalRequestId}`}>
          <Facts items={[
            { label: 'Logical request id', value: request.logicalRequestId },
            { label: 'Attempt', value: request.attempt.attempt }, { label: 'Transport outcome', value: request.attempt.outcome },
            { label: 'Endpoint index', value: request.attempt.endpointIndex }, { label: 'Endpoint kind', value: request.attempt.endpointKind },
            { label: 'Requested model', value: request.attempt.requestedModel }, { label: 'Request id', value: request.attempt.requestId },
            { label: 'HTTP status', value: request.attempt.status }, { label: 'Latency (ms)', value: request.attempt.latencyMs },
            { label: 'Elapsed (ms)', value: request.elapsedMs }, { label: 'Next retry delay (ms)', value: request.nextDelayMs },
          ]} />
        </Disclosure>
      </li>)}
    </ul>}
  </DetailSection>;
}
function SemanticDecision({ record }: { record: DecisionRecord }) {
  const { decision } = record;
  return <Disclosure summary={<span className="contract-tree__summary"><span>{record.stage}: {record.targetId}</span><span className="contract-tree__status">Recorded outcome: {decision.outcome}</span></span>}>
    <Facts items={[
      { label: 'Recorded outcome', value: decision.outcome }, { label: 'Decision id', value: decision.decisionId },
      { label: 'Stage', value: record.stage }, { label: 'Target id', value: record.targetId },
      { label: 'Operation revision', value: record.operationRevision },
      { label: 'Supporting judgment decision ids', value: <Ids values={decision.judgmentDecisionIds} /> },
    ]} />
    <DetailSection title="Recorded decision summary"><Text>{decision.summary}</Text></DetailSection>
    {decision.outcome === 'revise' && <DetailSection title="Recorded continuation">
      <Facts items={[{ label: 'Kind', value: decision.next.kind }]} /><Reference reference={decision.next} />
    </DetailSection>}
    {decision.outcome === 'defer' && <DetailSection title="Recorded resume condition"><Reference reference={decision.until} /></DetailSection>}
    <Disclosure summary="Decision binding"><BindingDetails binding={decision.binding} /></Disclosure>
    <Disclosure summary={`Evidence references (${decision.evidence.length})`}>
      {decision.evidence.length === 0 ? <Empty>No evidence references recorded.</Empty> : <ol className="contract-tree__list" aria-label={`Evidence for ${decision.decisionId}`}>
        {decision.evidence.map((reference, i) => <li key={`${reference.id}-${i}`}><Reference reference={reference} /></li>)}
      </ol>}
    </Disclosure>
  </Disclosure>;
}
function SemanticDecisions({ decisions }: { decisions: Decisions }) {
  const pending = Object.entries(decisions.pending);
  const spent = Object.entries(decisions.spent);
  const outputs = Object.entries(decisions.plannerOutputs);
  const choices = Object.entries(decisions.attemptChoices);
  const attempted = Object.entries(decisions.attemptedChoices);
  return <DetailSection title="Native semantic decisions">
    <Empty>Recorded native outcomes are separate from criterion readings and runner decision history. Receipts and references grant no permission to execute.</Empty>
    <Disclosure summary={`Native decision history (${decisions.history.length})`} defaultOpen>
      {decisions.history.length === 0 ? <Empty>No native semantic decisions recorded.</Empty> : <ol className="contract-tree__list" aria-label="Native decision history">
        {decisions.history.map((record, i) => <li key={`${record.decision.decisionId}-${i}`}><SemanticDecision record={record} /></li>)}
      </ol>}
    </Disclosure>
    <Disclosure summary={`Pending native records (${pending.length})`} defaultOpen>
      {pending.length === 0 ? <Empty>No pending native records.</Empty> : <ul className="contract-tree__list" aria-label="Pending native records">
        {pending.map(([key, record]) => <li key={key}>
          <Facts items={[{ label: 'Pending record key', value: key }]} /><SemanticDecision record={record} />
        </li>)}
      </ul>}
    </Disclosure>
    {(spent.length > 0 || outputs.length > 0 || choices.length > 0 || attempted.length > 0) && <Disclosure summary="Native execution records">
      {spent.length > 0 && <DetailSection title="Spent correction budgets"><Facts items={spent.map(([key, value]) => ({ label: key, value }))} /></DetailSection>}
      {outputs.length > 0 && <DetailSection title="Recorded planner outputs">
        <ul className="contract-tree__list" aria-label="Recorded planner outputs">{outputs.map(([key, value]) => <li key={key}><Disclosure summary={key}><Text>{value}</Text></Disclosure></li>)}</ul>
      </DetailSection>}
      {choices.length > 0 && <DetailSection title="Recorded attempt choices"><Facts items={choices.map(([key, value]) => ({ label: key, value }))} /></DetailSection>}
      {attempted.length > 0 && <DetailSection title="Recorded attempted choices"><Facts items={attempted.map(([key, values]) => ({ label: key, value: <Ids values={values} /> }))} /></DetailSection>}
    </Disclosure>}
  </DetailSection>;
}
function DurableAdmission({ admission }: { admission: Admission }) {
  const { input } = admission;
  const execution = admission.schemaVersion === 2 ? admission.execution : undefined;
  return <Disclosure summary="Durable admission provenance">
    <Empty>This admission receipt records an input and execution placement. It is not permission to run work.</Empty>
    <Facts items={[
      { label: 'Admission schema version', value: admission.schemaVersion }, { label: 'Contract id', value: admission.contractId },
      { label: 'Owner agent id', value: admission.ownerAgentId }, { label: 'Payload revision', value: admission.payloadRevision },
      { label: 'Work id', value: admission.key.workId }, { label: 'Criteria id', value: admission.key.criteriaId },
      { label: 'Criteria revision', value: admission.key.criteriaRevision }, { label: 'Attempt id', value: admission.key.attemptId },
    ]} />
    <Disclosure summary="Admission binding"><BindingDetails binding={admission.binding} /></Disclosure>
    <DetailSection title="Recorded execution placement">{execution ? <>
      <Facts items={[{ label: 'Isolation', value: execution.isolation }]} />
      {execution.isolation === 'worktree' && <Facts items={[
        { label: 'Branch', value: execution.branch }, { label: 'Worktree path', value: execution.worktreePath }, { label: 'Base branch', value: execution.baseBranch },
      ]} />}
    </> : <Empty>No execution placement recorded.</Empty>}</DetailSection>
    <Disclosure summary="Admission input">
      <DetailSection title="Admission ask"><Text>{input.ask}</Text></DetailSection>
      <Facts items={[
        { label: 'Session id', value: input.sessionId }, { label: 'Origin', value: input.origin }, { label: 'Project root', value: input.projectRoot },
        { label: 'Parent agent id', value: input.parentAgentId }, { label: 'Requested isolation', value: input.isolation },
        { label: 'Token ceiling', value: input.budget?.maxTokens }, { label: 'Cost ceiling (USD)', value: input.budget?.maxCostUsd },
      ]} />
      {input.nativeSource && <Disclosure summary="Admission native source"><SourceDetails source={input.nativeSource} /></Disclosure>}
      {input.proposedUnits !== undefined && <DetailSection title={`Proposed units (${input.proposedUnits.length})`}>
        {input.proposedUnits.length === 0 ? <Empty>No proposed units recorded.</Empty> : <ol className="contract-tree__list" aria-label="Admission proposed units">{input.proposedUnits.map((unit, i) => <li key={i}>
          <Text>{unit.task}</Text><Facts items={[{ label: 'Template', value: unit.template }]} />
        </li>)}</ol>}
      </DetailSection>}
    </Disclosure>
  </Disclosure>;
}
function InputSnapshot({ snapshot }: { snapshot: Snapshot }) {
  return <Disclosure summary="Captured input provenance">
    <Empty>Captured paths, digests, and object ids identify recorded input. They grant no read or transmission permission.</Empty>
    <Facts items={[
      { label: 'Snapshot version', value: snapshot.version }, { label: 'Snapshot id', value: snapshot.id },
      { label: 'Captured at', value: <RecordedTime at={snapshot.capturedAt} /> }, { label: 'Source root', value: snapshot.sourceRoot },
      { label: 'Source identity', value: snapshot.sourceIdentity }, { label: 'Git identity', value: snapshot.gitIdentity },
      { label: 'Owner HEAD', value: snapshot.ownerHead }, { label: 'Owner ref', value: snapshot.ownerRef },
      { label: 'Index fingerprint', value: snapshot.indexFingerprint }, { label: 'Input tree', value: snapshot.inputTree },
      { label: 'Input commit', value: snapshot.inputCommit }, { label: 'Dirty at capture', value: String(snapshot.dirty) },
      { label: 'Exclusions', value: <Ids values={snapshot.exclusions} /> },
    ]} />
    <Disclosure summary={`Captured files (${snapshot.files.length})`}>
      {snapshot.files.length === 0 ? <Empty>No captured files recorded.</Empty> : <ul className="contract-tree__list" aria-label="Captured files">
        {snapshot.files.map((file, i) => <li key={`${file.path}-${i}`}><Facts items={[
          { label: 'Path', value: file.path }, { label: 'Kind', value: file.kind }, { label: 'Mode', value: file.mode },
          { label: 'Object id', value: file.oid }, { label: 'Digest', value: file.digest }, { label: 'Identity', value: file.identity },
        ]} /></li>)}
      </ul>}
    </Disclosure>
  </Disclosure>;
}

export function NativeContractDetails({ contract }: { contract: ContractRecord }) {
  const { nativeSource, nativeProgress, nativeWaiting, nativeDecisions, durableAdmission, durableLaunchState, inputSnapshot } = contract;
  return <>
    {nativeSource && <DetailSection title="Native source"><SourceDetails source={nativeSource} /></DetailSection>}
    {nativeProgress && <DetailSection title="Native progress">
      <Facts items={[
        { label: 'State', value: nativeProgress.state }, { label: 'Stage', value: nativeProgress.stage }, { label: 'Target id', value: nativeProgress.targetId },
      ]} />
      {nativeProgress.until && <DetailSection title="Progress condition reference"><Reference reference={nativeProgress.until} /></DetailSection>}
    </DetailSection>}
    {nativeWaiting && <TransportWaiting waiting={nativeWaiting} />}
    {nativeDecisions && <SemanticDecisions decisions={nativeDecisions} />}
    {durableLaunchState !== undefined && <DetailSection title="Durable launch record">
      <Facts items={[{ label: 'Launch state', value: durableLaunchState }]} />
      {durableLaunchState === 'launch-claimed' && <Empty>A persisted launch claim does not establish whether execution began.</Empty>}
    </DetailSection>}
    {durableAdmission && <DurableAdmission admission={durableAdmission} />}
    {inputSnapshot && <InputSnapshot snapshot={inputSnapshot} />}
  </>;
}
