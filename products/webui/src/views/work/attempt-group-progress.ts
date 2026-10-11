import type { FleetAttemptGroup } from '../../lib/goodvibes';

/** Additive wire fields; older daemons expose only terminal candidates. */
type GroupProgressSource = FleetAttemptGroup & {
  readonly attemptCount?: number | undefined;
  readonly selectableCandidateCount?: number | undefined;
  readonly unresolved?: readonly { readonly itemId: string; readonly attemptIndex: number; readonly title: string; readonly state: string; readonly reason: string | null }[] | undefined;
};

/** The Work list and detail use the same actual size and unresolved-state accounting. */
export function attemptGroupProgress(group: GroupProgressSource) {
  const unresolved = group.unresolved ?? [];
  const count = group.attemptCount ?? group.candidates.length + unresolved.length;
  const selectable = group.selectableCandidateCount ?? group.candidates.filter(candidate => candidate.state === 'held-merge').length;
  const bookkeepingHeld = unresolved.filter(item => item.state === 'blocked-bookkeeping');
  const held = bookkeepingHeld.length > 0;
  const ready = group.ready && unresolved.length === 0;
  const reason = [...new Set(bookkeepingHeld.map(item => item.reason).filter((value): value is string => !!value))].join('; ');
  const meta = [`${selectable} of ${count} selectable`,
    ...(held ? [`${bookkeepingHeld.length} held: repository condition unresolved`, ...(reason ? [reason] : [])] : []),
    ...(!held && unresolved.length ? [`${unresolved.length} unresolved`] : []),
    ...(ready && group.judgment ? ['judge ready'] : []),
  ].join(' · ');
  return { count, selectable, unresolved, held, ready, meta,
    status: held ? 'Held: repository condition unresolved' : ready ? 'Needs your pick' : 'Waiting for attempts',
    tone: held || ready ? 'warn' as const : 'live' as const,
  };
}
