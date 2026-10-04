import { nativeWorkExecutionLines, type NativeWorkExecutionAction } from '../../runtime/native-work-execution.ts';
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
  const controlWork = (row: ConfigModalRow | null, tabId: string): string | undefined => {
    model.synchronize();
    if (!model.executionAvailable || tabId !== 'work' || !row) return undefined;
    return model.snapshot?.works.find(view => row.id === key('control', view.work.id, model.identity))?.work.id;
  };
  return {
    name: 'native-work-ledger-modal', title: 'Native Work',
    get actions() { return model.executionAvailable ? ([['s', 'start'], ['i', 'status'], ['c', 'cancel'], ['r', 'resume']] as const).map(([key, id]) => ({
      key, id, label: id, enabledFor: (row: ConfigModalRow | null, tabId: string) => controlWork(row, tabId) !== undefined,
    })) : []; },
    onAction(actionId, ctx) {
      if (!['start', 'status', 'cancel', 'resume'].includes(actionId)) return;
      const workId = controlWork(ctx.row, ctx.tabId);
      if (!workId) return;
      void model.execute(actionId as NativeWorkExecutionAction, workId);
    },
    onOpen: changed => model.open(changed), onClose: () => model.close(),
    buildView(): ConfigModalView {
      model.synchronize();
      const snapshot = model.snapshot;
      const work: ConfigModalRow[] = []; const intent: ConfigModalRow[] = [];
      const attention: ConfigModalRow[] = []; const evidence: ConfigModalRow[] = []; const imports: ConfigModalRow[] = [];
      for (const view of snapshot?.works ?? []) {
        const w = view.work; const a = view.attempt;
        work.push(row(key('work', w.id, 'summary'), `${w.id} · ${w.title} · work revision ${w.revision} · criteria revision ${w.criteriaRevision}`));
        work.push(row(key('work', w.id, 'states'), `reportedState ${w.reportedState} · verificationState ${view.verification.state}: ${view.verification.reason}`));
        if (model.executionAvailable) work.push({ id: key('control', w.id, model.identity), label: safe(`Control ${w.id}: s start · i status · c cancel · r explicit resume/reconcile · status/cancel attempt ${model.observedExecutionAttempt(w.id) ?? a?.id ?? 'none'}`), selectable: true });
        work.push(row(key('work', w.id, 'attempt'), a ? `attempt ${a.id} · revision ${a.revision} · owner ${a.ownerId} · state ${a.state}${a.report ? ` · ${a.report}` : ''}` : 'No current attempt.'));
        intent.push(row(key('intent', w.id, 'goal'), `${w.id} · goal: ${w.goal} · criteria revision ${w.criteriaRevision}`));
        w.criteria.forEach((criterion, index) => intent.push(row(key('intent', w.id, 'criterion', index), `${index + 1}. ${criterion}`)));
        view.attention.forEach((item, index) => attention.push(row(key('attention', w.id, 'item', index), `${w.id} · attempt ${a?.id ?? 'none'} · ${item.kind}: ${item.reason}`)));
      }
      if (model.executionAvailable) {
        const lines = nativeWorkExecutionLines(model.execution);
        // Reserve progress structure before the first action so asynchronous
        // state/recovery updates paint without another key or scroll reset.
        for (let index = 0; index < 11; index++) work.push(row(key('execution', 'selected', 'progress', index), lines[index] ?? (index === 0 ? 'Execution: select a control row. Status/cancel retain the last observed attempt.' : '')));
      }
      // Retain durable historical references without calling old evidence current success.
      const proofs = new Map(model.history.flatMap(event => event.type !== 'import_legacy' && event.evidence ? [[event.evidence.id, event.evidence] as const] : []));
      for (const view of snapshot?.works ?? []) if (view.verification.evidence) proofs.set(view.verification.evidence.id, view.verification.evidence);
      for (const e of proofs.values()) {
        const t = e.target;
        evidence.push(row(key('evidence', e.id, 'summary'), `${e.id} · historical outcome ${e.outcome} · work ${t.workId}@${t.workRevision} · criteria revision ${t.criteriaRevision} · attempt ${t.attemptId}@${t.attemptRevision} · ${e.reason}`));
        e.references.forEach((ref, i) => evidence.push(row(key('evidence', e.id, 'reference', i), `${ref.kind}: ${ref.ref}${ref.digest ? ` · digest ${ref.digest}` : ''}`)));
      }
      for (const event of model.history) {
        if (event.type !== 'import_legacy') continue;
        const eventId = String(event.sequence);
        imports.push(row(key('imports', eventId, 'summary'), `Import #${event.sequence} · ${event.works.length} work records · actor ${event.actorId} · request ${event.requestId}`));
        imports.push(row(key('imports', eventId, 'authority'), 'Historical approval and completion are source claims, not execution authority or verified evidence.'));
        event.works.forEach((work, index) => imports.push(row(key('imports', eventId, 'work', index), `${work.id} · ${work.title} · reported ${work.reportedState} · imported unverified`)));
        if (!event.manifest) { imports.push(row(key('imports', eventId, 'protected'), 'Protected legacy provenance requires read:knowledge authorization.')); continue; }
        imports.push(row(key('imports', eventId, 'digest'), `Preparation ${event.manifest.digest}`));
        event.manifest.sources.forEach((source, index) => imports.push(row(key('imports', eventId, 'source', index), `Preserved source ${String(source.source.id)} · generation ${source.generation} · ${JSON.stringify(source.source)}`)));
        event.manifest.links.forEach((link, index) => imports.push(row(key('imports', eventId, 'link', index), `Link ${link.from} · ${link.relation} · ${link.to} · source ${link.sourceId} ${link.pointer}`)));
      }
      return { title: model.executionAvailable ? 'Native Work' : 'Native Work (read-only)', bindingIdentity: model.identity, scrollInformationalLines: true,
        deferredStructureMessage: 'Native rows changed; press an arrow key to show the current layout.',
        ...(model.reason ? { degraded: safe(model.reason) } : {}),
        tabs: [['work', 'Work', work], ['intent', 'Intent', intent], ['attention', 'Attention', attention], ['evidence', 'Evidence', evidence], ['imports', 'Legacy imports', imports]].map(([id, label, rows]) => ({
          id: id as string, label: label as string, rows: rows as ConfigModalRow[],
          header: [snapshot ? safe(`project ${snapshot.projectId} · durable cursor ${snapshot.cursor}`) : 'No native host data.', model.executionAvailable ? 'Select a control row for explicit execution. Ledger criteria and verification remain authoritative.' : 'Read-only. Planning approvals do not authorize native execution.'],
          emptyText: safe(model.reason) || 'No native records in this view.',
        })), hints: ['Esc detaches local requests; c explicitly cancels the selected attempt. Reopen to reconnect.'],
      };
    },
  };
}
