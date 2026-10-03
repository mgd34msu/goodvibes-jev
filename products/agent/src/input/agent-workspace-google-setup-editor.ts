/**
 * Google connection cards for the Agent workspace.
 *
 * `/google` shipped first and, for a release, was the only way in. A headline
 * capability reachable only by typing a slash command is not wired up as far as
 * a person clicking through the workspace is concerned, the same reasoning
 * that produced the command in the first place, applied one layer out. These
 * cards cover every route the command exposes: the console walkthrough, the
 * app-password fast lane, the two OAuth client intakes, adoption of credentials
 * already on this machine, and the connection state.
 *
 * Neither surface owns the logic. Both call `google-connection-actions.ts`, so
 * a fix to adoption or to the flow lands in both at once; there is no second
 * implementation to drift.
 *
 * Security: these are DIRECT host actions, not slash commands. The client
 * secret and the client-JSON path never travel through
 * AgentWorkspace.dispatchWorkspaceCommand, which echoes its command argument
 * back into the rendered result, a command string carrying a client secret
 * would render it in the UI. Same rule as the email connect wizard and the
 * calendar OAuth card.
 */
import type { CommandContext } from './command-registry.ts';
import { isAffirmative } from './agent-workspace-editors.ts';
import { renderGoogleSetupReport } from '@goodvibes-jev/engine/sdk/platform/google';
import {
  adoptGoogleCredentials,
  connectGoogle,
  forgetGoogleCredentials,
  reauthorizeGoogle,
  describeGoogleConnection,
  runGoogleSetup,
} from './commands/google-connection-actions.ts';
import type { GoogleClientIntakeChoice } from '@goodvibes-jev/engine/sdk/platform/google';
import type { GoogleProgressPort, GoogleSetupPath, GoogleSetupStepSpec, GoogleStepResult } from '@goodvibes-jev/engine/sdk/platform/google';
import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';

type FieldReader = (id: string) => string;

export interface AgentWorkspaceGoogleSetupEditorHost {
  localEditor: AgentWorkspaceLocalEditor | null;
  status: string;
  lastActionResult: AgentWorkspaceActionResult | null;
}

/**
 * Google blocks automated sign-in, so any flow that opens the browser stops and
 * waits for a person. Every card that can reach that point says so before it is
 * run rather than after, an unattended run that silently parks is the failure
 * this warning exists to prevent.
 */
const SIGN_IN_PAUSE =
  'A browser window opens during this run. Google refuses automated sign-in, so the flow will pause '
  + 'and ask you to sign in by hand, complete any 2-Step prompt, and re-run. Completed steps are '
  + 'detected and skipped on the next run.';

function confirmField(hint: string) {
  return { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint };
}

// ---------------------------------------------------------------------------
// Editors
// ---------------------------------------------------------------------------

export function createGoogleStatusEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'google-status',
    mode: 'create',
    title: 'Google connection status',
    selectedFieldIndex: 0,
    message:
      'Report what Gmail and Calendar have configured, and, separately, whether Google credentials '
      + 'already exist on this machine that nothing is using yet. Reads only; nothing is changed and no '
      + 'credential is shown.',
    fields: [confirmField('Type yes to read the current connection state.')],
  };
}

/**
 * The card people should reach for, and the reason the others are still here.
 *
 * `/google connect` works out the route by itself, a stored credential, a
 * stored client that only needs consent, or an authenticated gcloud, and asks
 * for at most one thing. The path-specific cards below remain for someone who
 * knows they want a particular one; nobody should have to choose first.
 */
export function createGoogleConnectEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'google-connect',
    mode: 'create',
    title: 'Connect Google',
    selectedFieldIndex: 0,
    message:
      'Connect Gmail and Calendar. This works out the shortest route on its own: it uses a credential '
      + 'already stored, goes straight to consent when an OAuth client exists, and uses the gcloud CLI '
      + 'for the project and APIs when it is signed in. Mail and calendar are requested together, so one '
      + 'approval covers both. At the end it reads your mailbox and your calendar to prove the connection '
      + 'actually works rather than reporting that something was stored.',
    fields: [confirmField('Type yes to connect Google.')],
  };
}

/**
 * A fresh consent, for when a credential is alive but not permitted enough.
 *
 * This is the card the old error text pointed at and which did not exist. It
 * deletes nothing: Google issues a new refresh token when consent is granted
 * again, and approving on the consent screen IS the confirmation.
 */
export function createGoogleReauthorizeEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'google-reauthorize',
    mode: 'create',
    title: 'Re-authorize Google',
    selectedFieldIndex: 0,
    message:
      'Ask for a fresh Google consent covering mail and calendar together. Use this when something '
      + 'reports a missing scope, or when a credential has stopped working. The existing OAuth client is '
      + 'reused, so there is no project or console work, just one consent link to approve. Check the '
      + 'account shown on the consent screen: approving as a personal account by reflex is the most '
      + 'common way this goes wrong.',
    fields: [confirmField('Type yes to start a fresh Google consent.')],
  };
}

/**
 * Removal, behind a confirm field.
 *
 * A stored refresh token is the product of a person completing a consent
 * screen, and it was once deleted mid-flow with nothing asked and nothing said.
 * The card states what would go before anything goes.
 */
export function createGoogleForgetEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'google-forget',
    mode: 'create',
    title: 'Remove stored Google credentials',
    selectedFieldIndex: 0,
    message:
      'Remove the Google credentials held in the encrypted store, the refresh token, the OAuth client '
      + 'secret, the Gmail app password and the private calendar address, whichever of them are there. '
      + 'This cannot be undone: getting the refresh token back means approving a consent screen again. '
      + 'Nothing is removed until you confirm, and the reply names exactly what was removed.',
    fields: [confirmField('Type yes to remove the stored Google credentials.')],
  };
}

export function createGoogleWalkthroughEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'google-setup-walkthrough',
    mode: 'create',
    title: 'Connect Google (guided OAuth)',
    selectedFieldIndex: 0,
    message:
      'Run the full OAuth walkthrough: project, consent screen, client, and authorization, driving the '
      + `Google console for you. This is the path that enables calendar writes. ${SIGN_IN_PAUSE}`,
    fields: [confirmField('Type yes to start the guided OAuth walkthrough.')],
  };
}

export function createGoogleAppPasswordEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'google-setup-app-password',
    mode: 'create',
    title: 'Connect Google (app password)',
    selectedFieldIndex: 0,
    message:
      'The fast lane: an app password for mail over IMAP/SMTP, plus the private iCal address for '
      + 'read-only calendar. No Cloud project, no consent screen, and nothing that expires. Google '
      + 'refuses Basic authentication on CalDAV, so calendar writes need the guided OAuth card instead. '
      + SIGN_IN_PAUSE,
    fields: [confirmField('Type yes to start the app-password flow.')],
  };
}

export function createGoogleAdoptEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'google-adopt',
    mode: 'create',
    title: 'Adopt existing Google credentials',
    selectedFieldIndex: 0,
    message:
      'Take up a Google OAuth client and refresh token another tool already put on this machine '
      + '(~/.gmail-mcp), instead of setting one up again. The files are read, never modified, and the '
      + 'values go straight into the encrypted secret store.',
    fields: [confirmField('Type yes to adopt credentials already on this machine.')],
  };
}

export function createGoogleClientFileEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'google-client-file',
    mode: 'create',
    title: 'Use a downloaded client JSON',
    selectedFieldIndex: 0,
    message:
      'Point at an OAuth client JSON you already downloaded from the Google console. The rest of the '
      + `OAuth flow runs from it. ${SIGN_IN_PAUSE}`,
    fields: [
      { id: 'path', label: 'Client JSON path', value: '', required: true, multiline: false, hint: 'Full path to the file you downloaded, for example ~/Downloads/client_secret_....json.' },
      confirmField('Type yes to read that file and run the OAuth flow.'),
    ],
  };
}

export function createGoogleClientManualEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'google-client-manual',
    mode: 'create',
    title: 'Paste a client id and secret',
    selectedFieldIndex: 0,
    message:
      'Enter an OAuth client id and secret copied from the Google console. The secret is stored through '
      + `the Agent secret manager, masked here, and never rendered back. ${SIGN_IN_PAUSE}`,
    fields: [
      { id: 'clientId', label: 'Client ID', value: '', required: true, multiline: false, hint: 'The OAuth client id from the Google console.' },
      { id: 'clientSecret', label: 'Client secret', value: '', required: true, multiline: false, hint: 'Stored through the Agent secret manager. Masked here and never rendered in results.', redact: true },
      confirmField('Type yes to store these and run the OAuth flow.'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

function notConfirmed(host: AgentWorkspaceGoogleSetupEditorHost, editor: AgentWorkspaceLocalEditor): void {
  host.localEditor = { ...editor, message: 'Not confirmed. Type yes, then press Enter.' };
  host.status = 'Google setup not confirmed.';
}

function noContext(host: AgentWorkspaceGoogleSetupEditorHost, editor: AgentWorkspaceLocalEditor): void {
  host.localEditor = { ...editor, message: 'This runtime has no command context; cannot reach the Google connector.' };
  host.status = 'Google setup unavailable.';
  host.lastActionResult = { kind: 'error', title: 'Google setup unavailable', detail: 'No command context is available in this runtime.', safety: 'safe' };
}

function failed(host: AgentWorkspaceGoogleSetupEditorHost, editor: AgentWorkspaceLocalEditor, title: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  host.localEditor = { ...editor, message: detail };
  host.status = detail;
  host.lastActionResult = { kind: 'error', title, detail, safety: 'safe' };
}

/**
 * Ordering, because the result pane cannot show everything.
 *
 * The context column compacts a result to its first sentence, and the actions
 * column renders wrapped lines until the viewport ends, there is no scroll and
 * no "more below" marker on the result block, so a thirty-line setup report
 * loses its tail. Printing to the conversation instead is not available here:
 * the workspace's command context does not surface `print` into the transcript
 * (verified against a built binary, the same text typed as `/google status`
 * appears, the same call from a card does not).
 *
 * What is in our gift is the order. Every result therefore leads with the
 * outcome and the one thing outstanding, so that what survives the cut is the
 * part the person needs, and the verbose step-by-step is the tail that is lost
 * rather than the headline. The remaining clipping is a workspace renderer
 * limitation, not something this card can decide away.
 */

/**
 * Progress is collected as it happens.
 *
 * The console surface streams each step; a card cannot, so the steps are
 * gathered and printed with the report. Dropping them would make a run that
 * paused for sign-in look like a run that did nothing.
 */
function collectingProgress(lines: string[]): GoogleProgressPort {
  return {
    stepStarted: (spec: GoogleSetupStepSpec, index: number, total: number) => {
      lines.push(`[${index}/${total}] ${spec.title}...`);
    },
    stepFinished: (spec: GoogleSetupStepSpec, result: GoogleStepResult) => {
      lines.push(`      ${result.outcome}: ${result.detail}`);
    },
    humanActionNeeded: (_spec: GoogleSetupStepSpec, instruction: string) => {
      lines.push(`      needs you: ${instruction}`);
    },
    note: (message: string) => { lines.push(`      ${message}`); },
  };
}

async function runFlowCard(
  host: AgentWorkspaceGoogleSetupEditorHost,
  editor: AgentWorkspaceLocalEditor,
  context: CommandContext,
  path: GoogleSetupPath,
  title: string,
  intake?: GoogleClientIntakeChoice,
): Promise<void> {
  const transcript: string[] = [];
  try {
    host.status = 'Google setup running, the browser may ask you to sign in.';
    const report = await runGoogleSetup(path, context, collectingProgress(transcript), intake);

    const outstanding = report.steps.find((step) => step.outcome !== 'done');
    // Headline first, then what needs you, then the full record. The pane cuts
    // from the bottom, so this order decides what survives.
    const head = report.ok
      ? ['Every step completed.']
      : [
          `Stopped at "${outstanding?.id ?? 'an early step'}": ${outstanding?.detail ?? 'a step did not complete.'}`,
          ...(outstanding?.problem ? [outstanding.problem] : []),
          ...(outstanding?.fix ? [`Do this: ${outstanding.fix}`] : []),
          'Re-run this card afterwards; completed steps are detected and skipped.',
        ];

    host.localEditor = null;
    host.status = report.ok ? 'Google connected.' : 'Google setup paused, one thing needs you.';
    host.lastActionResult = {
      kind: report.ok ? 'refreshed' : 'error',
      title: report.ok ? `${title} complete` : `${title} paused`,
      detail: [...head, '', ...transcript, '', renderGoogleSetupReport(report)].join('\n'),
      safety: 'safe',
    };
  } catch (error) {
    failed(host, editor, `${title} failed`, error);
  }
}

/** One entry point for every Google card. Returns nothing; it writes to the host. */
export async function submitAgentWorkspaceGoogleSetupEditor(
  host: AgentWorkspaceGoogleSetupEditorHost,
  editor: AgentWorkspaceLocalEditor,
  context: CommandContext | null,
  readField: FieldReader,
): Promise<void> {
  if (!isAffirmative(readField('confirm'))) {
    notConfirmed(host, editor);
    return;
  }
  if (!context) {
    noContext(host, editor);
    return;
  }

  if (editor.kind === 'google-status') {
    try {
      const text = await describeGoogleConnection(context);
      host.localEditor = null;
      host.status = 'Google connection state read.';
      // Not a 'recap' result: that kind renders every line behind a green check,
      // which would put a tick against "Gmail: not connected."
      host.lastActionResult = {
        kind: 'refreshed',
        title: 'Google connection',
        detail: text,
        safety: 'read-only',
      };
    } catch (error) {
      failed(host, editor, 'Google status unavailable', error);
    }
    return;
  }

  if (editor.kind === 'google-adopt') {
    try {
      const outcome = await adoptGoogleCredentials(context, {
        setup: 'the "Connect Google (app password)" or "Connect Google (guided OAuth)" card',
        status: 'the "Google connection status" card',
      });
      host.localEditor = null;
      host.status = outcome.adopted ? 'Google credentials adopted.' : 'No adoptable Google credentials found.';
      host.lastActionResult = {
        kind: outcome.adopted ? 'refreshed' : 'error',
        title: outcome.adopted ? 'Google credentials adopted' : 'Nothing to adopt',
        detail: outcome.text,
        safety: 'safe',
      };
    } catch (error) {
      failed(host, editor, 'Google adoption failed', error);
    }
    return;
  }

  if (editor.kind === 'google-connect' || editor.kind === 'google-reauthorize') {
    const reauthorizing = editor.kind === 'google-reauthorize';
    const transcript: string[] = [];
    try {
      host.status = reauthorizing ? 'Asking Google for a fresh consent...' : 'Connecting Google...';
      // The consent link goes into the transcript the pane renders. A card has
      // no console to print to, and the link is the ONE thing the person has to
      // act on, so it is announced rather than opened: Google blocks automated
      // browsers at its sign-in wall, and a link they click always works.
      const announce = (url: string): void => {
        transcript.push('Open this link and approve it:');
        transcript.push(url);
      };
      const outcome = reauthorizing
        ? await reauthorizeGoogle(context, collectingProgress(transcript), announce)
        : await connectGoogle(context, collectingProgress(transcript), announce);

      host.localEditor = null;
      host.status = outcome.connected
        ? 'Google connected and proven.'
        : 'Google is not connected yet.';
      host.lastActionResult = {
        kind: outcome.connected ? 'refreshed' : 'error',
        title: reauthorizing ? 'Google re-authorization' : 'Connect Google',
        detail: [outcome.text, '', ...transcript].join('\n'),
        safety: 'safe',
      };
    } catch (error) {
      failed(host, editor, reauthorizing ? 'Google re-authorization failed' : 'Connecting Google failed', error);
    }
    return;
  }

  if (editor.kind === 'google-forget') {
    try {
      // The confirm field at the top of this card IS the explicit yes. Reaching
      // this line already required typing it, which is why `true` is passed
      // here and never defaulted anywhere below.
      const detail = await forgetGoogleCredentials(
        context,
        ['refresh-token', 'client-secret', 'app-password', 'calendar-address'],
        true,
      );
      host.localEditor = null;
      host.status = 'Stored Google credentials removed.';
      host.lastActionResult = {
        kind: 'refreshed',
        title: 'Stored Google credentials removed',
        detail,
        safety: 'safe',
      };
    } catch (error) {
      failed(host, editor, 'Removing the Google credentials failed', error);
    }
    return;
  }

  if (editor.kind === 'google-setup-walkthrough') {
    await runFlowCard(host, editor, context, 'oauth', 'Guided OAuth setup');
    return;
  }

  if (editor.kind === 'google-setup-app-password') {
    await runFlowCard(host, editor, context, 'app-password', 'App-password setup');
    return;
  }

  if (editor.kind === 'google-client-file') {
    const path = readField('path').trim();
    if (path.length === 0) {
      host.localEditor = { ...editor, message: 'Give the path to the client JSON you downloaded.' };
      host.status = 'A client JSON path is required.';
      return;
    }
    await runFlowCard(host, editor, context, 'oauth', 'Client JSON setup', { kind: 'client-json-file', path });
    return;
  }

  if (editor.kind === 'google-client-manual') {
    const clientId = readField('clientId').trim();
    const clientSecret = readField('clientSecret').trim();
    if (clientId.length === 0 || clientSecret.length === 0) {
      host.localEditor = { ...editor, message: 'Both the client id and the client secret are required.' };
      host.status = 'Client id and secret are required.';
      return;
    }
    await runFlowCard(host, editor, context, 'oauth', 'Client credentials setup', { kind: 'manual-entry', clientId, clientSecret });
  }
}
