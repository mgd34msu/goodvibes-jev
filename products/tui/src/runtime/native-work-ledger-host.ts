import { createNativeHostFetch } from './client/native-host-fetch.ts';
import { NativeConversationIntakePreflight } from './native-conversation-intake-preflight.ts';
import { NativeConversationIntakeControls, nativeConversationIntakeLines, type NativeConversationIntakeActions, type NativeConversationIntakeState } from './native-conversation-intake.ts';
import { NativeConversationIntakeJournal } from './native-conversation-intake-journal.ts';
import { createNativeConversationIntakeBinding } from './native-conversation-intake-host.ts';
import { NativeWorkSubmissionPreflight } from './native-work-submission-preflight.ts';
import { realpathSync } from 'node:fs';
import { NativeWorkSubmissionJournal } from './native-work-submission-journal.ts';
import { NativeWorkSubmissionControls, nativeWorkSubmissionLines, type NativeWorkSubmissionActions, type NativeWorkSubmissionState } from './native-work-submission.ts';
import { createNativeWorkSubmissionBinding, nativeSubmissionIdentity } from './native-work-submission-host.ts';
import { NativeWorkSourceError, readNativeWorkSourceFile } from './native-work-submission-source.ts';
import { createOperatorSdk, type OperatorRemoteClient } from '@goodvibes-jev/engine/operator-sdk';
import { createOperatorNativeWorkExecutionClient, getOperatorWorkLedgerProject } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { resolveNativeHostCredential } from './client/native-host-credential.ts';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/operator-read-client';
import type { NativeWorkLedgerSelectionReader } from './native-work-ledger.ts';
import type { CommandRegistry } from '../input/command-registry.ts';

/** Explicit project selection on the configured authenticated daemon. No legacy ID inference. */
export function createNativeWorkLedgerHost(deps: {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
  readonly daemonHomeDirectory?: string;
  readonly journalPath?: string;
  readonly workspace: () => string;
}) {
  let discovery: { controller: AbortController; identity: string } | undefined;
  let projectId = ''; let generation = 0; let selectedLocation = ''; let discoveryReason = '';
  // Capture endpoint, home, store generation and token together. Never combine
  // a selection from one credential with a second independent token read.
  const captureConnection = () => {
    const homeDirectory = typeof deps.homeDirectory === 'function' ? deps.homeDirectory() : deps.homeDirectory;
    const credential = resolveNativeHostCredential({ configManager: deps.configManager, homeDirectory });
    const workspace = deps.workspace();
    const location = JSON.stringify([credential.available ? credential.baseUrl : credential.identity, homeDirectory, workspace]);
    return { credential, workspace, location };
  };
  const selectProject = (id: string, fromDiscovery = false): void => {
    if (!id.trim() || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) throw new Error('Use the exact daemon project ID (1–200 characters).');
    if (!fromDiscovery) { preflight.close(); intakePreflight.close(); }
    submission.close(); intake.close(); discovery?.controller.abort();
    projectId = id; discoveryReason = ''; selectedLocation = captureConnection().location; generation++;
  };
  const captureSelection = () => {
    const connection = captureConnection();
    if (projectId && selectedLocation !== connection.location) { projectId = ''; generation++; }
    const identity = JSON.stringify([generation, connection.credential.identity, connection.workspace, projectId]);
    if (discovery && identity !== discovery.identity) discovery.controller.abort();
    return { ...connection, identity, projectId };
  };
  const unavailable = (capture: ReturnType<typeof captureSelection>) => !capture.credential.available
    ? { available: false as const, identity: capture.identity, reason: capture.credential.reason }
    : !capture.projectId ? { available: false as const, identity: capture.identity, reason: discoveryReason || 'Select an exact daemon project with /work <project-id>.' } : undefined;
  const readSelection: NativeWorkLedgerSelectionReader = () => {
    const capture = captureSelection(); const missing = unavailable(capture);
    if (missing) return missing;
    const { credential, projectId: selectedProject, identity } = capture;
    if (!credential.available) return { available: false, identity, reason: credential.reason };
    return { available: true, identity, projectId: selectedProject, bind: onUnavailable => {
      const current = () => captureSelection().identity === identity;
      if (!current()) return { available: false, reason: 'Native host selection changed.' };
      let disposed = false;
      const operator = createOperatorSdk({ baseUrl: credential.baseUrl, authToken: credential.token, fetchImpl: createNativeHostFetch({ current: () => !disposed && current() }) });
      const invoke = (async (...args: Parameters<OperatorRemoteClient['invoke']>) => {
        if (disposed || !current()) throw new Error('Native host selection changed.');
        try {
          const value = await operator.invoke(...args);
          if (disposed || !current()) throw new Error('Native host selection changed.');
          return value;
        } catch (error) {
          // Remote failures are visible in the ledger view. Preserve the typed
          // status/code while preventing a hostile host from reflecting its bearer.
          if (error instanceof Error) {
            error.message = error.message.split(credential.token).join('[redacted]');
            if (error.stack) error.stack = error.stack.split(credential.token).join('[redacted]');
          }
          throw error;
        }
      }) as OperatorRemoteClient['invoke'];
      const reader = createOperatorWorkLedgerReadClient({ invoke }, selectedProject, { onUnavailable });
      return { available: true, execution: createOperatorNativeWorkExecutionClient({ invoke }, selectedProject), client: {
        projectId: reader.projectId, readSnapshot: () => reader.readSnapshot(), history: cursor => reader.history(cursor),
        subscribe: listener => reader.subscribe(listener), dispose: () => { disposed = true; try { reader.dispose(); } finally { operator.dispose(); } },
      } };
    } };
  };
  const submission = new NativeWorkSubmissionControls(() => {
    const capture = captureSelection(); const missing = unavailable(capture);
    if (missing) return missing;
    const { credential, workspace, projectId: project } = capture;
    if (!credential.available) return { available: false, identity: capture.identity, reason: credential.reason };
    if (!deps.journalPath) return { available: false, identity: capture.identity, reason: 'Native submission journal location is unavailable in this shell.' };
    const host = { baseUrl: credential.baseUrl, token: credential.token, credentialIdentity: credential.identity, workspace, journalPath: deps.journalPath };
    const identity = nativeSubmissionIdentity(host, project);
    return { available: true, identity: JSON.stringify([capture.identity, identity]), endpoint: host.baseUrl, projectId: project, workspace: realpathSync(workspace), journal: new NativeWorkSubmissionJournal(deps.journalPath), bind: () => createNativeWorkSubmissionBinding(host, project, () => captureSelection().identity === capture.identity && nativeSubmissionIdentity(host, project) === identity) };
  });
  const intake = new NativeConversationIntakeControls(() => {
    const capture = captureSelection(); const missing = unavailable(capture);
    if (missing) return missing;
    const { credential, workspace, projectId: project } = capture;
    if (!credential.available) return { available: false, identity: capture.identity, reason: credential.reason };
    if (!deps.journalPath) return { available: false, identity: capture.identity, reason: 'Native intake requires an authenticated host and durable journal.' };
    const host = { baseUrl: credential.baseUrl, token: credential.token, credentialIdentity: credential.identity, workspace, journalPath: deps.journalPath };
    const identity = nativeSubmissionIdentity(host, project);
    return { available: true, identity: JSON.stringify([capture.identity, identity]), endpoint: host.baseUrl, projectId: project, workspace: realpathSync(workspace), journal: new NativeConversationIntakeJournal(`${deps.journalPath}.intake`), bind: () => createNativeConversationIntakeBinding(host, project, () => captureSelection().identity === capture.identity && nativeSubmissionIdentity(host, project) === identity) };
  });
  const preflightIdentity = () => {
    const { credential, workspace } = captureConnection();
    return JSON.stringify([credential.identity, realpathSync(workspace), deps.journalPath]);
  };
  const preflight = new NativeWorkSubmissionPreflight(preflightIdentity, () => { submission.close(); intake.close(); discovery?.controller.abort(); });
  const intakePreflight = new NativeConversationIntakePreflight(preflightIdentity, () => { intake.close(); discovery?.controller.abort(); });
  const discoverProject = async (capture?: (identity: string) => void): Promise<boolean> => {
    const ready = (): boolean => { capture?.(readSelection().identity); return true; };
    const before = captureSelection();
    if (before.projectId || !before.credential.available) return ready();
    const controller = new AbortController();
    const operator = createOperatorSdk({ baseUrl: before.credential.baseUrl, authToken: before.credential.token, fetchImpl: createNativeHostFetch({ current: () => !controller.signal.aborted && captureSelection().identity === before.identity }) });
    discovery?.controller.abort(); discovery = { controller, identity: before.identity };
    const timer = setInterval(() => { readSelection(); }, 100);
    timer.unref?.();
    try {
      if (readSelection().identity !== before.identity || controller.signal.aborted) return false;
      const id = await getOperatorWorkLedgerProject(operator, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
      if (readSelection().identity !== before.identity || controller.signal.aborted) return false;
      selectProject(id, true);
      return ready();
    } catch {
      if (readSelection().identity !== before.identity || controller.signal.aborted) return false;
      discoveryReason = 'Host project discovery unavailable or not permitted. Select an exact daemon project with /work <project-id>.';
      return ready();
    } finally {
      clearInterval(timer); operator.dispose();
      if (discovery?.controller === controller) discovery = undefined;
    }
  };
  const submissionAction = async (action: () => Promise<NativeWorkSubmissionState | undefined>, current: () => boolean): Promise<NativeWorkSubmissionState | undefined> => {
    let identity: string | undefined;
    if (!await discoverProject(value => { identity = value; }) || !identity || readSelection().identity !== identity || !current()) return;
    const result = await action();
    return readSelection().identity === identity ? result : undefined;
  };
  const submissionActions: NativeWorkSubmissionActions = {
    submitFile: path => preflight.run(async (signal, isCurrent) => {
      const before = readSelection().identity; const workspace = realpathSync(deps.workspace());
      try {
        const source = await readNativeWorkSourceFile(path, workspace, signal);
        if (!isCurrent() || readSelection().identity !== before) return;
        return submissionAction(() => submission.submitSource(source), isCurrent);
      } catch (error) {
        if (!isCurrent() || readSelection().identity !== before) return;
        return { status: 'invalid', message: error instanceof NativeWorkSourceError ? error.message : 'Could not read a regular UTF-8 source JSON file.' };
      }
    }),
    status: () => preflight.run((_signal, current) => submissionAction(() => submission.status(), current)),
    retry: () => preflight.run((_signal, current) => submissionAction(() => submission.retry(), current)),
    close: () => preflight.close(),
  };
  const intakeAction = (action: () => Promise<NativeConversationIntakeState | undefined>): Promise<NativeConversationIntakeState | undefined> => intakePreflight.run(async (_signal, current) => {
    let identity: string | undefined;
    if (!await discoverProject(value => { identity = value; }) || !identity || readSelection().identity !== identity || !current()) return;
    const result = await action(); return readSelection().identity === identity ? result : undefined;
  });
  const intakeActions: NativeConversationIntakeActions = {
    submit: source => { const captured = structuredClone(source); return intakeAction(() => intake.submit(captured)); },
    status: () => intakeAction(() => intake.status()), retry: () => intakeAction(() => intake.retry()),
    resume: () => intakeAction(() => intake.resume()), cancel: () => { intakePreflight.close(); return intakeAction(() => intake.cancel()); }, close: () => intakePreflight.close(),
  };
  return { readSelection, selectProject, discoverProject, submission: submissionActions, intake: intakeActions };
}

export function registerNativeWorkLedgerCommand(registry: CommandRegistry, selectProject: (id: string) => void, discoverProject: () => Promise<boolean>, submission?: NativeWorkSubmissionActions): void {
  registry.register({ name: 'work', description: 'Inspect native work and recover ordinary input with intake-status/intake-retry/intake-resume/intake-cancel; /work <daemon-project-id> selects a project.',
    handler: async (args, ctx) => {
      const action = args[0];
      if (action === 'intake-status' || action === 'intake-retry' || action === 'intake-resume' || action === 'intake-cancel') {
        if (args.length !== 1) { ctx.print('Usage: /work intake-status | intake-retry | intake-resume | intake-cancel'); return; }
        const intake = ctx.nativeConversationIntake;
        if (!intake) { ctx.print('Native conversation intake is unavailable in this shell.'); return; }
        const result = await (action === 'intake-status' ? intake.status() : action === 'intake-retry' ? intake.retry() : action === 'intake-resume' ? intake.resume() : intake.cancel());
        ctx.print(nativeConversationIntakeLines(result).join('\n'));
        if (result?.turnReady) await ctx.dispatchNativeIntakeTurn?.(result);
        return;
      }
      if (action === 'submit-file' || action === 'submission-status' || action === 'submission-retry') {
        if (args.length !== (action === 'submit-file' ? 2 : 1)) { ctx.print('Usage: /work submit-file <JSON-path> | submission-status | submission-retry'); return; }
        if (!submission) { ctx.print('Native source submission is unavailable in this shell.'); return; }
        const result = action === 'submit-file' ? await submission.submitFile(args[1]!) : action === 'submission-status' ? await submission.status() : await submission.retry();
        ctx.print(nativeWorkSubmissionLines(result).map(line => line.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')).join('\n'));
        return;
      }
      if (args.length > 1) { ctx.print('Usage: /work [exact-daemon-project-id]'); return; }
      if (args[0]) { try { selectProject(args[0]); } catch (error) { ctx.print(String(error)); return; } }
      else if (!await discoverProject()) return;
      if (!ctx.openModal) { ctx.print('Native work view is unavailable in this shell.'); return; }
      ctx.openModal('native-work-ledger-modal');
    },
  });
}
