import { NativeWorkLedgerModel, type NativeWorkLedgerSelectionReader } from '../../runtime/native-work-ledger.ts';
import type { ConfigModalSurface, ConfigModalView, ConfigModalRow } from '../../input/config-modal-types.ts';

/** Native facts only. Legacy planning and contract approvals remain separate surfaces. */
export function createNativeWorkLedgerModalSurface(select: NativeWorkLedgerSelectionReader): ConfigModalSurface {
  const model = new NativeWorkLedgerModel(select);
  const safe = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
  // Encode structure instead of concatenating user/host IDs with field suffixes.
  // The tuple remains injective across sections, items, roles and child indexes.
  const key = (section: string, itemId: string, role: string, index?: number): string =>
    JSON.stringify(index === undefined ? [section, itemId, role] : [section, itemId, role, index]);
  const row = (id: string, label: string): ConfigModalRow => ({ id, label: safe(label), selectable: false });
  return {
    name: 'native-work-ledger-modal', title: 'Native Work', actions: [],
    onOpen: changed => model.open(changed), onClose: () => model.close(),
    buildView(): ConfigModalView {
      model.synchronize();
      const snapshot = model.snapshot;
      const work: ConfigModalRow[] = []; const intent: ConfigModalRow[] = [];
      const attention: ConfigModalRow[] = []; const evidence: ConfigModalRow[] = [];
      for (const view of snapshot?.works ?? []) {
        const w = view.work; const a = view.attempt;
        work.push(row(key('work', w.id, 'summary'), `${w.id} · ${w.title} · work revision ${w.revision} · criteria revision ${w.criteriaRevision}`));
        work.push(row(key('work', w.id, 'states'), `reportedState ${w.reportedState} · verificationState ${view.verification.state}: ${view.verification.reason}`));
        work.push(row(key('work', w.id, 'attempt'), a ? `attempt ${a.id} · revision ${a.revision} · owner ${a.ownerId} · state ${a.state}${a.report ? ` · ${a.report}` : ''}` : 'No current attempt.'));
        intent.push(row(key('intent', w.id, 'goal'), `${w.id} · goal: ${w.goal} · criteria revision ${w.criteriaRevision}`));
        w.criteria.forEach((criterion, index) => intent.push(row(key('intent', w.id, 'criterion', index), `${index + 1}. ${criterion}`)));
        view.attention.forEach((item, index) => attention.push(row(key('attention', w.id, 'item', index), `${w.id} · attempt ${a?.id ?? 'none'} · ${item.kind}: ${item.reason}`)));
      }
      // Retain durable historical references without calling old evidence current success.
      const proofs = new Map(model.history.flatMap(event => event.evidence ? [[event.evidence.id, event.evidence] as const] : []));
      for (const view of snapshot?.works ?? []) if (view.verification.evidence) proofs.set(view.verification.evidence.id, view.verification.evidence);
      for (const e of proofs.values()) {
        const t = e.target;
        evidence.push(row(key('evidence', e.id, 'summary'), `${e.id} · historical outcome ${e.outcome} · work ${t.workId}@${t.workRevision} · criteria revision ${t.criteriaRevision} · attempt ${t.attemptId}@${t.attemptRevision} · ${e.reason}`));
        e.references.forEach((ref, i) => evidence.push(row(key('evidence', e.id, 'reference', i), `${ref.kind}: ${ref.ref}${ref.digest ? ` · digest ${ref.digest}` : ''}`)));
      }
      return { title: 'Native Work (read-only)', bindingIdentity: model.identity, scrollInformationalLines: true,
        deferredStructureMessage: 'Native rows changed; press an arrow key to show the current layout.',
        ...(model.reason ? { degraded: safe(model.reason) } : {}),
        tabs: [['work', 'Work', work], ['intent', 'Intent', intent], ['attention', 'Attention', attention], ['evidence', 'Evidence', evidence]].map(([id, label, rows]) => ({
          id: id as string, label: label as string, rows: rows as ConfigModalRow[],
          header: [snapshot ? safe(`project ${snapshot.projectId} · durable cursor ${snapshot.cursor}`) : 'No native host data.', 'Read-only. Planning approvals do not authorize native execution.'],
          emptyText: safe(model.reason) || 'No native records in this view.',
        })), hints: ['Esc close; reopen to reconnect'],
      };
    },
  };
}
