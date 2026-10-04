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
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createOperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import { createOperatorNativeWorkExecutionClient, getOperatorWorkLedgerProject } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { resolveDaemonEnabled } from '@goodvibes-jev/engine/sdk/platform/config';
import { resolveDaemonStateDirectory, resolveControlPlaneBaseUrl } from './client/operator-endpoint.ts';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/operator-read-client';
import type { NativeWorkLedgerSelectionReader } from './native-work-ledger.ts';
import type { CommandRegistry } from '../input/command-registry.ts';

/** Explicit project selection on the configured authenticated daemon. No legacy ID inference. */
export function createNativeWorkLedgerHost(deps: {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string;
  readonly daemonHomeDirectory?: string;
  readonly journalPath?: string;
  readonly workspace: () => string;
}) {
  let discovery: { controller: AbortController; identity: string } | undefined;
  let projectId = ''; let generation = 0; let selectedLocation = ''; let discoveryReason = '';
  const readToken = (): string | undefined => {
    try {
      const record: unknown = JSON.parse(readFileSync(join(deps.daemonHomeDirectory ?? resolveDaemonStateDirectory(deps.homeDirectory), 'operator-tokens.json'), 'utf8'));
      if (record && typeof record === 'object' && 'token' in record && typeof record.token === 'string' && record.token) return record.token;
    } catch { /* A read-only view never mints or repairs credentials. */ }
    return undefined;
  };
  const location = () => JSON.stringify([resolveControlPlaneBaseUrl(deps.configManager), deps.workspace()]);
  const selectProject = (id: string, fromDiscovery = false): void => {
    if (!id.trim() || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) throw new Error('Use the exact daemon project ID (1–200 characters).');
    if (!fromDiscovery) { preflight.close(); intakePreflight.close(); }
    submission.close(); intake.close(); discovery?.controller.abort();
    projectId = id; discoveryReason = ''; selectedLocation = location(); generation++;
  };
  const readSelection: NativeWorkLedgerSelectionReader = () => {
    if (projectId && selectedLocation !== location()) { projectId = ''; generation++; }
    const url = resolveControlPlaneBaseUrl(deps.configManager);
    const enabled = resolveDaemonEnabled(deps.configManager);
    const token = readToken();
    const authEpoch = token ? createHash('sha256').update(token).digest('hex') : 'no-auth';
    const identity = JSON.stringify([generation, url, enabled, deps.workspace(), projectId, authEpoch]);
    if (discovery && identity !== discovery.identity) discovery.controller.abort();
    if (!projectId) return { available: false, identity, reason: discoveryReason || 'Select an exact daemon project with /work <project-id>.' };
    if (!enabled || !url) return { available: false, identity, reason: 'Selected daemon is disabled or has no endpoint.' };
    if (!token) return { available: false, identity, reason: 'Selected daemon has no existing authentication. Connect to the daemon first.' };
    const selectedProject = projectId;
    return { available: true, identity, projectId: selectedProject, bind: onUnavailable => {
      const operator = createOperatorSdk({ baseUrl: url, authToken: token });
      const reader = createOperatorWorkLedgerReadClient(operator, selectedProject, { onUnavailable });
      return { available: true, execution: createOperatorNativeWorkExecutionClient(operator, selectedProject), client: {
        projectId: reader.projectId, readSnapshot: () => reader.readSnapshot(), history: cursor => reader.history(cursor),
        subscribe: listener => reader.subscribe(listener), dispose: () => { try { reader.dispose(); } finally { operator.dispose(); } },
      } };
    } };
  };
  const submission = new NativeWorkSubmissionControls(() => {
    const selection = readSelection();
    if (!selection.available) return selection;
    const baseUrl = resolveControlPlaneBaseUrl(deps.configManager); const token = readToken(); const workspace = deps.workspace();
    if (!baseUrl || !token || !resolveDaemonEnabled(deps.configManager)) return { available: false, identity: 'unavailable', reason: 'Selected daemon has no existing native submission authentication.' };
    if (!deps.journalPath) return { available: false, identity: selection.identity, reason: 'Native submission journal location is unavailable in this shell.' };
    const host = { baseUrl, token, workspace, journalPath: deps.journalPath }; const project = selection.projectId;
    return { available: true, identity: nativeSubmissionIdentity(host, project), endpoint: baseUrl, projectId: project, workspace: realpathSync(workspace), journal: new NativeWorkSubmissionJournal(deps.journalPath), bind: () => createNativeWorkSubmissionBinding(host, project) };
  });
  const intake = new NativeConversationIntakeControls(() => {
    const selection = readSelection(); if (!selection.available) return selection;
    const baseUrl = resolveControlPlaneBaseUrl(deps.configManager); const token = readToken(); const workspace = deps.workspace();
    if (!baseUrl || !token || !deps.journalPath) return { available: false, identity: selection.identity, reason: 'Native intake requires an authenticated host and durable journal.' };
    const host = { baseUrl, token, workspace, journalPath: deps.journalPath }; const project = selection.projectId;
    const identity = nativeSubmissionIdentity(host, project);
    return { available: true, identity, endpoint: baseUrl, projectId: project, workspace: realpathSync(workspace), journal: new NativeConversationIntakeJournal(`${deps.journalPath}.intake`), bind: () => createNativeConversationIntakeBinding(host, project, () => readSelection().identity === selection.identity && nativeSubmissionIdentity(host, project) === identity) };
  });
  const preflight = new NativeWorkSubmissionPreflight(() => JSON.stringify([
    resolveDaemonEnabled(deps.configManager), resolveControlPlaneBaseUrl(deps.configManager),
    readToken(), realpathSync(deps.workspace()), deps.journalPath,
  ]), () => { submission.close(); intake.close(); discovery?.controller.abort(); });
  const intakePreflight = new NativeConversationIntakePreflight(() => JSON.stringify([
    resolveDaemonEnabled(deps.configManager), resolveControlPlaneBaseUrl(deps.configManager), readToken(), realpathSync(deps.workspace()), deps.journalPath,
  ]), () => { intake.close(); discovery?.controller.abort(); });
  const discoverProject = async (capture?: (identity: string) => void): Promise<boolean> => {
    const ready = (): boolean => { capture?.(readSelection().identity); return true; };
    const before = readSelection();
    if (projectId) return ready();
    const url = resolveControlPlaneBaseUrl(deps.configManager); const token = readToken();
    if (!url || !token || !resolveDaemonEnabled(deps.configManager)) return ready();
    const operator = createOperatorSdk({ baseUrl: url, authToken: token });
    const controller = new AbortController();
    discovery?.controller.abort(); discovery = { controller, identity: before.identity };
    const timer = setInterval(() => { readSelection(); }, 100);
    timer.unref?.();
    try {
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
