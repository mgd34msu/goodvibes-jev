import { createOperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/operator-read-client';
import type { WorkLedgerReadBinding } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import { NativeWorkLedgerModel, type NativeWorkLedgerView } from './native-work-ledger.ts';

export type NativeLedgerHost = { readonly baseUrl: string; readonly token: string; readonly workspace: string } | { readonly reason: string };
export type NativeLedgerBindingFactory = (host: Exclude<NativeLedgerHost, { reason: string }>, project: string, unavailable: (error: Error) => void) => WorkLedgerReadBinding;
export const createNativeLedgerBinding: NativeLedgerBindingFactory = (host, project, onUnavailable) => {
  const operator = createOperatorSdk({ baseUrl: host.baseUrl, authToken: host.token });
  const reader = createOperatorWorkLedgerReadClient(operator, project, { onUnavailable });
  return { available: true, client: {
    projectId: reader.projectId,
    readSnapshot: () => reader.readSnapshot(), history: cursor => reader.history(cursor),
    subscribe: listener => reader.subscribe(listener),
    dispose: () => { try { reader.dispose(); } finally { operator.dispose(); } },
  } };
};

export async function discoverNativeLedgerProject(host: Exclude<NativeLedgerHost, { reason: string }>, signal: AbortSignal): Promise<string> {
  const operator = createOperatorSdk({ baseUrl: host.baseUrl, authToken: host.token });
  try {
    // Empty input asks the authenticated host for its default project. Never
    // send the Agent's path-derived legacy project or broaden token scopes.
    const status = await operator.invoke<{ projectId: string }>('projectPlanning.status', {}, { signal });
    if (typeof status.projectId !== 'string' || !status.projectId || status.projectId.length > 200) throw new Error('Host did not return a valid project identity.');
    return status.projectId;
  } finally { operator.dispose(); }
}

/** Explicit project selection belongs to exactly one authenticated host/workspace. */
export function createNativeWorkLedgerView(
  resolve: () => NativeLedgerHost,
  changed: () => void,
  bind: NativeLedgerBindingFactory = createNativeLedgerBinding,
  discover: typeof discoverNativeLedgerProject = discoverNativeLedgerProject,
): NativeWorkLedgerView {
  const model = new NativeWorkLedgerModel(changed);
  let selected: { host: Exclude<NativeLedgerHost, { reason: string }>; project: string } | undefined;
  let discovery: AbortController | undefined;
  let active = false; let epoch = 0; let timer: ReturnType<typeof setInterval> | undefined;
  const same = (a: Exclude<NativeLedgerHost, { reason: string }>, b: Exclude<NativeLedgerHost, { reason: string }>) => a.baseUrl === b.baseUrl && a.token === b.token && a.workspace === b.workspace;
  const stop = () => { ++epoch; discovery?.abort(); discovery = undefined; if (timer) clearInterval(timer); timer = undefined; };
  const sync = () => {
    if (!active) return;
    const host = resolve();
    if ('reason' in host || (selected && !same(host, selected.host))) {
      selected = undefined; active = false; stop();
      model.unavailable('reason' in host ? host.reason : 'Selected host, credentials, or workspace changed. Select the daemon project again with /work <project-id>.');
    }
  };
  const open = () => {
    stop(); active = true; const host = resolve();
    if ('reason' in host) { selected = undefined; model.unavailable(host.reason); return; }
    if (selected && !same(host, selected.host)) selected = undefined;
    if (!selected) {
      const generation = epoch;
      const controller = new AbortController();
      discovery = controller;
      model.loading(`Discovering daemon project on ${host.baseUrl}…`);
      // Loading can synchronously render and sync, revoking the host or closing
      // the view. Keep local ownership and recheck before admitting any request.
      if (generation !== epoch || !active || controller.signal.aborted) return;
      void discover(host, AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])).then(project => {
        if (generation !== epoch || !active) return;
        const current = resolve();
        if ('reason' in current || !same(current, host)) { active = false; stop(); model.unavailable('Host changed during discovery. Reopen /work.'); return; }
        selected = { host, project }; open();
      }, error => {
        if (generation !== epoch || !active) return;
        active = false; stop();
        const reason = error instanceof Error ? error.message : String(error);
        model.unavailable(`Project discovery unavailable on ${host.baseUrl}: ${reason.split(host.token).join('[redacted]')}. Select explicitly with /work <project-id>; discovery requires read:knowledge.`);
      });
      return;
    }
    const generation = epoch;
    try {
      const binding = bind(host, selected.project, error => { if (generation === epoch && active) { active = false; stop(); model.unavailable(error.message.split(host.token).join('[redacted]')); } });
      model.open(binding);
      if (generation === epoch) { timer = setInterval(sync, 1000); timer.unref?.(); }
    } catch (error) { model.unavailable(error instanceof Error ? error.message : String(error)); }
  };
  return {
    get state() { return model.state; },
    selectProject(project) {
      stop(); model.close();
      const host = resolve();
      if (!project.trim() || project.length > 200 || /[\u0000-\u001f\u007f]/.test(project)) { selected = undefined; model.unavailable('A nonempty daemon project ID of at most 200 characters is required.'); return; }
      if ('reason' in host) { selected = undefined; model.unavailable(host.reason); return; }
      selected = { host, project };
      if (active) open();
    },
    open, sync,
    close() { active = false; stop(); model.close(); },
  };
}
