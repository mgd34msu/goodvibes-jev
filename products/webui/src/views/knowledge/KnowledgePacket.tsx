/**
 * KnowledgePacketPanel, build a compact structured knowledge packet for a task
 * and write scope (knowledge.packet), a never-called-before verb this brief
 * adopts. A packet is the packed, budget-aware context an agent would carry into
 * a task, surfacing it here lets an operator preview exactly what an agent
 * would receive before actually running anything.
 */
import { SyntheticEvent, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { PackageSearch } from 'lucide-react';
import { invokeMethod } from '../../lib/goodvibes';
import type { OperatorMethodInput } from '../../lib/goodvibes';
import { asRecord, firstArray, firstString, countFrom } from '../../lib/object';
import { EmptyState } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Field';
import { Row, RowList } from '../../components/ui/Row';
import { Select } from '../../components/ui/Select';
import { ErrorState } from '../../components/feedback/ErrorState';

type PacketDetail = NonNullable<OperatorMethodInput<'knowledge.packet'>['detail']>;

/**
 * Hand-authored: the installed `@pellux/goodvibes-sdk` contracts package (1.1.0) predates
 * these fields, the SDK added them post-1.2.0 (packet.ts's `truncated` / `totalCandidates` /
 * `droppedCount`, "a partial packet must never read as complete"). All three are OPTIONAL
 * here because they are additive on the wire: an older daemon simply omits them, and this
 * view must keep rendering that daemon's response exactly as it always has, no fabricated
 * claim. Once the webui pins a contracts package whose `OperatorMethodOutput<'knowledge.packet'>`
 * carries these, this local type can be dropped for the generated one.
 */
interface KnowledgePacketTruncation {
  readonly totalCandidates: number;
  readonly droppedCount: number;
}

/** Only a genuinely truncated, post-1.2.0-daemon response yields a disclosure, a daemon
 * that never sends `truncated`/`totalCandidates`/`droppedCount` renders exactly as it did
 * before these fields existed, matching FleetView.tsx's `snapshot.data.truncated` cap-note. */
function truncationInfo(data: unknown): KnowledgePacketTruncation | null {
  const record = asRecord(data);
  if (record.truncated !== true) return null;
  const totalCandidates = record.totalCandidates;
  const droppedCount = record.droppedCount;
  if (typeof totalCandidates !== 'number' || typeof droppedCount !== 'number') return null;
  return { totalCandidates, droppedCount };
}

function splitScope(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function KnowledgePacketPanel() {
  const [task, setTask] = useState('');
  const [writeScope, setWriteScope] = useState('');
  const [detail, setDetail] = useState<PacketDetail>('standard');
  const [budgetLimit, setBudgetLimit] = useState('');

  const packet = useMutation({
    mutationFn: () => {
      const scope = splitScope(writeScope);
      const budget = Number(budgetLimit);
      return invokeMethod('knowledge.packet', {
        task: task.trim(),
        detail,
        ...(scope.length ? { writeScope: scope } : {}),
        ...(budgetLimit.trim() && Number.isFinite(budget) && budget > 0 ? { budgetLimit: budget } : {}),
      });
    },
  });

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (task.trim()) packet.mutate();
  }

  const items = firstArray(packet.data, ['items']);
  const estimatedTokens = countFrom(packet.data, ['estimatedTokens']);
  const truncation = truncationInfo(packet.data);

  return (
    <div className="knowledge-packet">
      <form className="lib-form" onSubmit={submit}>
        <Field label="Task" help="The packet is the compact context an agent would carry into this task.">
          <Input
            value={task}
            onChange={(event) => setTask(event.target.value)}
            placeholder="Describe the task this packet is for"
            aria-label="Task description"
          />
        </Field>
        <div className="lib-form__split">
          <Field label="Detail">
            <Select<PacketDetail>
              value={detail}
              onChange={setDetail}
              aria-label="Packet detail level"
              options={[
                { value: 'compact', label: 'Compact' },
                { value: 'standard', label: 'Standard' },
                { value: 'detailed', label: 'Detailed' },
              ]}
            />
          </Field>
          <Field label="Budget (tokens)">
            <Input
              value={budgetLimit}
              onChange={(event) => setBudgetLimit(event.target.value)}
              placeholder="Optional"
              inputMode="numeric"
              aria-label="Token budget limit"
            />
          </Field>
        </div>
        <Field label="Write scope">
          <Input
            value={writeScope}
            onChange={(event) => setWriteScope(event.target.value)}
            placeholder="Comma-separated paths, optional"
            aria-label="Write scope, comma separated"
          />
        </Field>
        <div>
          <Button type="submit" variant="secondary" disabled={packet.isPending || !task.trim()} aria-busy={packet.isPending}>
            {packet.isPending ? 'Building…' : 'Build packet'}
          </Button>
        </div>
      </form>

      {packet.error ? (
        <ErrorState error={packet.error} onRetry={() => { if (task.trim()) packet.mutate(); }} title="Packet build failed" />
      ) : packet.data ? (
        items.length === 0 ? (
          <EmptyState icon={<PackageSearch />} title="Packet has no items">
            Nothing in the knowledge base matched this task within the given budget.
          </EmptyState>
        ) : (
          <div className="knowledge-packet__result">
            <p className="lib-quiet knowledge-packet__summary">
              {items.length} item{items.length === 1 ? '' : 's'} · ~{estimatedTokens} estimated tokens
            </p>
            {truncation && (
              <p className="dv-notice knowledge-packet__truncation-note" role="note">
                Showing {items.length} of {truncation.totalCandidates} candidates ({truncation.droppedCount} dropped).
              </p>
            )}
            <RowList aria-label="Packet items">
              {items.map((item, index) => {
                const kind = firstString(item, ['kind']) || 'item';
                const title = firstString(item, ['title']) || firstString(item, ['id']) || `Item ${index + 1}`;
                const reason = firstString(item, ['reason']);
                const score = countFrom(item, ['score']);
                return (
                  <Row
                    key={firstString(item, ['id']) || index}
                    title={title}
                    meta={[kind, reason].filter(Boolean).join(' · ')}
                    trailing={<span className="dv-value">{score.toFixed(2)}</span>}
                  />
                );
              })}
            </RowList>
          </div>
        )
      ) : null}
    </div>
  );
}
