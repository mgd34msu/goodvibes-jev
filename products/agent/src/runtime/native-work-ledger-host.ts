import { NativeConversationIntakePreflight } from './native-conversation-intake-preflight.ts';
import { NativeConversationIntakeControls, type NativeConversationIntakeState } from './native-conversation-intake.ts';
import { NativeConversationIntakeJournal } from './native-conversation-intake-journal.ts';
import { createNativeConversationIntakeBinding } from './native-conversation-intake-host.ts';
import { NativeWorkSubmissionPreflight } from './native-work-submission-preflight.ts';
import { realpathSync } from 'node:fs';
import { NativeWorkSubmissionJournal } from './native-work-submission-journal.ts';
import { NativeWorkSubmissionControls, type NativeWorkSubmissionState, type NativeWorkSubmissionBinding } from './native-work-submission.ts';
import { createNativeWorkSubmissionBinding, nativeSubmissionIdentity } from './native-work-submission-host.ts';
import { NativeWorkSourceError, readNativeWorkSourceFile } from './native-work-submission-source.ts';
import { createOperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/operator-read-client';
import { createOperatorNativeWorkExecutionClient, getOperatorWorkLedgerProject } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import { NativeWorkLedgerModel, type NativeWorkLedgerView, type NativeWorkLedgerBinding } from './native-work-ledger.ts';

export type NativeLedgerHost = { readonly baseUrl: string; readonly token: string; readonly workspace: string; readonly journalPath?: string } | { readonly reason: string };
export type NativeLedgerBindingFactory = (host: Exclude<NativeLedgerHost, { reason: string }>, project: string, unavailable: (error: Error) => void) => NativeWorkLedgerBinding;
export const createNativeLedgerBinding: NativeLedgerBindingFactory = (host, project, onUnavailable) => {
  const operator = createOperatorSdk({ baseUrl: host.baseUrl, authToken: host.token });
  const reader = createOperatorWorkLedgerReadClient(operator, project, { onUnavailable });
  return { available: true, execution: createOperatorNativeWorkExecutionClient(operator, project), client: {
    projectId: reader.projectId,
    readSnapshot: () => reader.readSnapshot(), history: cursor => reader.history(cursor),
    subscribe: listener => reader.subscribe(listener),
    dispose: () => { try { reader.dispose(); } finally { operator.dispose(); } },
  } };
};

export async function discoverNativeLedgerProject(host: Exclude<NativeLedgerHost, { reason: string }>, signal: AbortSignal): Promise<string> {
  const operator = createOperatorSdk({ baseUrl: host.baseUrl, authToken: host.token });
  try {
    return await getOperatorWorkLedgerProject(operator, { signal });
  } finally { operator.dispose(); }
}

/** Explicit project selection belongs to exactly one authenticated host/workspace. */
export function createNativeWorkLedgerView(
  resolve: () => NativeLedgerHost,
  changed: () => void,
  bind: NativeLedgerBindingFactory = createNativeLedgerBinding,
  discover: typeof discoverNativeLedgerProject = discoverNativeLedgerProject,
  bindSubmission: (host: Exclude<NativeLedgerHost, { reason: string }>, project: string) => NativeWorkSubmissionBinding = createNativeWorkSubmissionBinding,
): NativeWorkLedgerView {
  const model = new NativeWorkLedgerModel(changed, () => { sync(); return active; });
  let opening: Promise<void> = Promise.resolve();
  let selected: { host: Exclude<NativeLedgerHost, { reason: string }>; project: string } | undefined;
  let discovery: AbortController | undefined;
  let discoveryHost: Exclude<NativeLedgerHost, { reason: string }> | undefined;
  let selectionEpoch = 0;
  let active = false; let epoch = 0; let timer: ReturnType<typeof setInterval> | undefined;
  const same = (a: Exclude<NativeLedgerHost, { reason: string }>, b: Exclude<NativeLedgerHost, { reason: string }>) => a.baseUrl === b.baseUrl && a.token === b.token && a.workspace === b.workspace && a.journalPath === b.journalPath;
  const submission = new NativeWorkSubmissionControls(() => {
    const host = resolve();
    if ('reason' in host) return { available: false, identity: 'unavailable', reason: host.reason };
    const identity = nativeSubmissionIdentity(host, selected?.project ?? '');
    if (!host.journalPath) return { available: false, identity, reason: 'Native submission journal location is unavailable in this shell.' };
    if (!selected || !same(host, selected.host)) return { available: false, identity, reason: 'Select the native daemon project before submitting source.' };
    const projectId = selected.project;
    return { available: true, identity, endpoint: host.baseUrl, projectId, workspace: realpathSync(host.workspace), journal: new NativeWorkSubmissionJournal(host.journalPath), bind: () => bindSubmission(host, projectId) };
  });
  const intake = new NativeConversationIntakeControls(() => {
    const host = resolve();
    if ('reason' in host) return { available: false, identity: 'unavailable', reason: host.reason };
    const identity = nativeSubmissionIdentity(host, selected?.project ?? '');
    if (!host.journalPath || !selected || !same(host, selected.host)) return { available: false, identity, reason: 'Native conversation intake requires its durable journal and selected daemon project.' };
    const projectId = selected.project;
    return { available: true, identity, endpoint: host.baseUrl, projectId, workspace: realpathSync(host.workspace), journal: new NativeConversationIntakeJournal(`${host.journalPath}.intake`), bind: () => createNativeConversationIntakeBinding(host, projectId, () => { const now = resolve(); return !('reason' in now) && nativeSubmissionIdentity(now, projectId) === identity && selected?.project === projectId; }) };
  });
  const preflight = new NativeWorkSubmissionPreflight(() => {
    const host = resolve();
    return 'reason' in host ? JSON.stringify(host) : nativeSubmissionIdentity(host, '');
  }, () => { submission.close(); intake.close(); discovery?.abort(); });
  const intakePreflight = new NativeConversationIntakePreflight(() => {
    const host = resolve(); return 'reason' in host ? JSON.stringify(host) : nativeSubmissionIdentity(host, '');
  }, () => { intake.close(); discovery?.abort(); });
  const stop = () => { ++epoch; opening = Promise.resolve(); discovery?.abort(); discovery = undefined; discoveryHost = undefined; if (timer) clearInterval(timer); timer = undefined; };
  const sync = () => {
    if (!active) return;
    const host = resolve();
    if ('reason' in host || (selected && !same(host, selected.host)) || (discoveryHost && !same(host, discoveryHost))) {
      submission.close(); intake.close(); selectionEpoch++; selected = undefined; active = false; stop();
      model.unavailable('reason' in host ? host.reason : 'Selected host, credentials, or workspace changed. Select the daemon project again with /work <project-id>.');
    }
  };
  const open = (fromDiscovery = false) => {
    if (!fromDiscovery) selectionEpoch++;
    stop(); active = true; const host = resolve();
    if ('reason' in host) { selected = undefined; model.unavailable(host.reason); return; }
    if (selected && !same(host, selected.host)) selected = undefined;
    if (!selected) {
      const generation = epoch;
      const controller = new AbortController();
      discovery = controller; discoveryHost = host;
      model.loading(`Discovering daemon project on ${host.baseUrl}…`);
      // Loading can synchronously render and sync, revoking the host or closing
      // the view. Keep local ownership and recheck before admitting any request.
      if (generation !== epoch || !active || controller.signal.aborted) return;
      timer = setInterval(sync, 1000); timer.unref?.();
      opening = discover(host, AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])).then(project => {
        if (generation !== epoch || !active) return;
        const current = resolve();
        if ('reason' in current || !same(current, host)) { active = false; stop(); model.unavailable('Host changed during discovery. Reopen /work.'); return; }
        selected = { host, project }; open(true);
      }, error => {
        if (generation !== epoch || !active) return;
        active = false; stop();
        const reason = error instanceof Error ? error.message : String(error);
        model.unavailable(`Project discovery unavailable on ${host.baseUrl}: ${reason.split(host.token).join('[redacted]')}. Select explicitly with /work <project-id>; discovery requires read:work-ledger.`);
      });
      return;
    }
    const generation = epoch;
    try {
      const binding = bind(host, selected.project, error => { if (generation === epoch && active) { active = false; stop(); model.unavailable(error.message.split(host.token).join('[redacted]')); } });
      const current = resolve();
      if (generation !== epoch || !active || 'reason' in current || !same(current, host)) {
        try { binding.execution?.dispose(); } catch {}
        if (binding.available) { try { binding.client.dispose(); } catch {} }
        sync(); return;
      }
      model.open(binding);
      if (generation === epoch) { timer = setInterval(sync, 1000); timer.unref?.(); }
    } catch (error) { model.unavailable(error instanceof Error ? error.message : String(error)); }
  };
  const submitAction = async (action: () => Promise<NativeWorkSubmissionState | undefined>, current: () => boolean): Promise<NativeWorkSubmissionState | undefined> => {
    if (!active) open();
    const generation = selectionEpoch; await opening; sync();
    if (!active || generation !== selectionEpoch || !current()) return;
    const result = await action(); sync();
    return active && generation === selectionEpoch ? result : undefined;
  };
  const intakeAction = (action: () => Promise<NativeConversationIntakeState | undefined>): Promise<NativeConversationIntakeState | undefined> => intakePreflight.run(async (_signal, current) => {
    const host = resolve();
    if ('reason' in host) return { status: 'unavailable', message: host.reason };
    if (!active) open();
    const generation = selectionEpoch; await opening; sync();
    if (generation !== selectionEpoch || !current()) return;
    if (!active) return model.state.status === 'unavailable' ? { status: 'unavailable', message: model.state.reason } : undefined;
    const result = await action(); sync();
    return active && generation === selectionEpoch ? result : undefined;
  });
  return {
    get state() { return model.state; },
    intake: {
      submit: source => { const captured = structuredClone(source); return intakeAction(() => intake.submit(captured)); },
      status: () => intakeAction(() => intake.status()), retry: () => intakeAction(() => intake.retry()),
      resume: () => intakeAction(() => intake.resume()), cancel: () => { intakePreflight.close(); return intakeAction(() => intake.cancel()); }, close: () => intakePreflight.close(),
    },
    submitFile: path => preflight.run(async (signal, isCurrent) => {
      const host = resolve(); const generation = selectionEpoch;
      if ('reason' in host) return { status: 'unavailable', message: host.reason };
      try {
        const source = await readNativeWorkSourceFile(path, realpathSync(host.workspace), signal);
        const current = resolve();
        if (!isCurrent() || generation !== selectionEpoch || 'reason' in current || !same(host, current)) return;
        return submitAction(() => submission.submitSource(source), isCurrent);
      } catch (error) {
        const current = resolve();
        if (!isCurrent() || generation !== selectionEpoch || 'reason' in current || !same(host, current)) return;
        return { status: 'invalid', message: error instanceof NativeWorkSourceError ? error.message : 'Could not read a regular UTF-8 source JSON file.' };
      }
    }),
    submissionStatus: () => preflight.run((_signal, current) => submitAction(() => submission.status(), current)),
    retrySubmission: () => preflight.run((_signal, current) => submitAction(() => submission.retry(), current)),
    selectProject(project) {
      preflight.close(); intakePreflight.close(); selectionEpoch++; stop(); model.close();
      const host = resolve();
      if (!project.trim() || project.length > 200 || /[\u0000-\u001f\u007f]/.test(project)) { selected = undefined; model.unavailable('A nonempty daemon project ID of at most 200 characters is required.'); return; }
      if ('reason' in host) { selected = undefined; model.unavailable(host.reason); return; }
      selected = { host, project };
      if (active) open();
    },
    open, sync,
    async execute(action, workId) {
      if (!active) open();
      const generation = selectionEpoch;
      await opening;
      sync();
      if (!active || generation !== selectionEpoch) return;
      const result = await model.execute(action, workId);
      sync();
      return active && generation === selectionEpoch ? result : undefined;
    },
    close() { preflight.close(); intakePreflight.close(); selectionEpoch++; active = false; stop(); model.close(); },
  };
}
