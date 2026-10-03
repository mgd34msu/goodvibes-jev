/**
 * `/google`, the entry point for connecting Gmail and Google Calendar.
 *
 * Why this command exists at all: every module of the Google connector was
 * written, unit-tested and shipped with no importer outside its own tests. The
 * flow executor, the console walkthrough, the three credential intake routes,
 * the app-password fast lane and the credential adoption were all reachable
 * only from a test file, so the shipped agent honestly reported that email and
 * calendar were not wired up, they were not. Tests passing said nothing about
 * whether a person could get to the feature.
 *
 * So the surface is deliberately one command rather than subcommands under
 * `/email` and `/calendar`. One Google account, one OAuth client and one
 * credential serve both mail and calendar; splitting the setup across two
 * commands would have meant two half-flows sharing hidden state, and would
 * have left whichever one the user did not run looking broken.
 *
 * The same reasoning is why this file holds no logic of its own any more. The
 * workspace UI offers these routes as cards, and both surfaces call
 * `google-connection-actions.ts`. This file is the console renderer over those
 * actions: it parses arguments and prints. Anything it decided for itself would
 * be a decision the UI could get differently.
 *
 * Nothing here ever prints a credential.
 */

import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireSecretsManager } from './runtime-services.ts';
import { renderGoogleSetupReport } from '@goodvibes-jev/engine/sdk/platform/google';
import type { GoogleClientIntakeChoice } from '@goodvibes-jev/engine/sdk/platform/google';
import { renderGoogleSetupRunbook } from '@goodvibes-jev/engine/sdk/platform/google';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from '@goodvibes-jev/engine/sdk/platform/google';
import {
  adoptGoogleCredentials,
  connectGoogle,
  describeGoogleConnection,
  forgetGoogleCredentials,
  googleConfigPort,
  googleSecretPort,
  reauthorizeGoogle,
  runGoogleSetup,
} from './google-connection-actions.ts';
import type { GoogleProgressPort, GoogleSetupPath, GoogleSetupStepSpec, GoogleStepResult } from '@goodvibes-jev/engine/sdk/platform/google';
import { getOutwardApprovalStore, takeRefusedOutwardAction } from '../../trust/outward-approvals.ts';

const USAGE = [
  'Usage: /google <subcommand>',
  '',
  '  connect                         Connect Gmail and Calendar. Works out the shortest route by itself',
  '                                  and asks you for at most one thing: approving a consent link.',
  '  status                          What is connected, proven by reading mail and calendar.',
  '  reauthorize                     Fresh consent covering mail and calendar together. Use this when',
  '                                  something reports a missing scope or a dead credential.',
  '  forget [--yes]                  Remove stored Google credentials. Says what would go and waits.',
  '  adopt [--yes]                   Take up Google credentials from files on this machine (~/.gmail-mcp).',
  '  client-file <path>              Use an OAuth client JSON you already have.',
  '  client <client-id> <client-secret>',
  '                                  Use an OAuth client id and secret you copied from the console.',
  '  account <address>               Set the Gmail address to connect as.',
  '  calendar-address <url>          Store the private iCal address for read-only calendar access.',
  '  setup [--path app-password|oauth|existing-client]',
  '                                  Run one specific path. /google connect picks for you.',
  '  runbook                         Print the written step-by-step instructions.',
  '  approve                         Approve the outward action that was just refused. Type it yourself;',
  '                                  it is ignored when the model runs it.',
  '',
  'The same routes are cards in the Agent workspace, under Personal Ops.',
].join('\n');

/** Live progress. A setup run is never a silent grind. */
function progressPort(ctx: CommandContext): GoogleProgressPort {
  return {
    stepStarted: (spec: GoogleSetupStepSpec, index: number, total: number) => {
      ctx.print(`[${index}/${total}] ${spec.title}...`);
    },
    stepFinished: (spec: GoogleSetupStepSpec, result: GoogleStepResult) => {
      ctx.print(`      ${result.outcome}: ${result.detail}`);
    },
    humanActionNeeded: (_spec: GoogleSetupStepSpec, instruction: string) => {
      ctx.print(`      needs you: ${instruction}`);
    },
    note: (message: string) => { ctx.print(`      ${message}`); },
  };
}

function parsePath(args: readonly string[]): GoogleSetupPath {
  const index = args.indexOf('--path');
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === 'oauth') return 'oauth';
  if (value === 'existing-client') return 'existing-client';
  return 'app-password';
}

/** True when the owner typed an explicit yes on this invocation. */
function saidYes(args: readonly string[]): boolean {
  return args.includes('--yes') || args.includes('-y');
}

/**
 * Where a consent link goes.
 *
 * Printed on its own line with nothing wrapped around it, because the person
 * has to be able to click or copy it cleanly. This is the single action the
 * whole flow asks of anyone.
 */
function consentAnnouncer(ctx: CommandContext): (url: string) => void {
  return (url: string) => {
    ctx.print('');
    ctx.print('Open this link and approve it:');
    ctx.print(url);
    ctx.print('');
  };
}

async function runSetup(args: readonly string[], ctx: CommandContext, intake?: GoogleClientIntakeChoice): Promise<void> {
  const report = await runGoogleSetup(parsePath(args), ctx, progressPort(ctx), intake);
  ctx.print(renderGoogleSetupReport(report));
}

async function setAccount(args: readonly string[], ctx: CommandContext): Promise<void> {
  const address = (args[0] ?? '').trim();
  if (address.length === 0 || !address.includes('@')) {
    ctx.print('Give the Gmail address to connect as: /google account <your-address@gmail.com>');
    return;
  }
  const config = googleConfigPort(ctx);
  config.set(GOOGLE_CONFIG_KEYS.emailUsername, address);
  config.set(GOOGLE_CONFIG_KEYS.emailFromAddress, address);
  ctx.print(`Gmail address set to ${address}. Continue with: /google connect`);
}

/**
 * The private iCal address is a credential in URL form, anyone holding it can
 * read the calendar, so it goes to the encrypted store, not to config.
 */
async function setCalendarAddress(args: readonly string[], ctx: CommandContext): Promise<void> {
  const url = (args[0] ?? '').trim();
  if (!url.startsWith('https://')) {
    ctx.print('Give the private iCal address: /google calendar-address <https://calendar.google.com/calendar/ical/.../basic.ics>');
    return;
  }
  // Touch the secrets manager through the same accessor the ports use, so an
  // unavailable secret store fails here rather than half-way through a write.
  requireSecretsManager(ctx);
  await googleSecretPort(ctx).set(GOOGLE_SECRET_KEYS.calendarIcsUrl, url);
  googleConfigPort(ctx).set(GOOGLE_CONFIG_KEYS.calendarIcsUrl, GOOGLE_CONFIG_KEYS.calendarIcsUrl);
  ctx.print('Stored the private calendar address in the encrypted secret store. Read it with: /calendar refresh');
}

/**
 * `/google approve`, the gesture that clears an outward-effect refusal.
 *
 * Refuses when the MODEL got here. `agent_harness mode:"run_command"` can run
 * any registered command, so without this check the remedy would be reachable
 * by exactly the route it exists to defend against: content steers the model,
 * the model runs the command, the approval appears. That the refusal message
 * tells the owner to type it himself is advice; this is the enforcement.
 */
function approveRefusedOutwardAction(ctx: CommandContext): void {
  if (ctx.invokedByModel === true) {
    ctx.print(
      'Refused: /google approve grants authority, so it only counts when you type it yourself. '
      + 'This came from the model running a command, which is the route content that was just read would use.',
    );
    return;
  }
  const refused = takeRefusedOutwardAction();
  if (refused === null) {
    ctx.print('Nothing is waiting for approval. Approvals name one specific message and last five minutes.');
    return;
  }
  const approval = getOutwardApprovalStore().grant({
    action: refused.action,
    // Supplied by this code path, which knows it ran from the owner's own
    // keystrokes. It is never read from an argument or from any content.
    surface: 'owner-direct',
    content: refused.content,
  });
  if (approval === null) {
    ctx.print('Could not record the approval.');
    return;
  }
  ctx.print([
    `Approved: ${refused.description}.`,
    'It is tied to that exact message, good once, and expires in five minutes.',
    'Re-issue the action now.',
  ].join(' '));
}

export async function runGoogleCommand(args: readonly string[], ctx: CommandContext): Promise<void> {
  const sub = (args[0] ?? 'status').trim().toLowerCase();
  const rest = args.slice(1);

  try {
    if (sub === 'status') {
      ctx.print(await describeGoogleConnection(ctx));
      return;
    }
    if (sub === 'connect') {
      const outcome = await connectGoogle(ctx, progressPort(ctx), consentAnnouncer(ctx));
      ctx.print(outcome.text);
      return;
    }
    if (sub === 'reauthorize' || sub === 'reauth') {
      const outcome = await reauthorizeGoogle(ctx, progressPort(ctx), consentAnnouncer(ctx));
      ctx.print(outcome.text);
      return;
    }
    if (sub === 'forget') {
      // Every stored Google credential is in scope, and none of it goes
      // without the owner's yes on this exact invocation.
      ctx.print(
        await forgetGoogleCredentials(
          ctx,
          ['refresh-token', 'client-secret', 'app-password', 'calendar-address'],
          saidYes(rest),
        ),
      );
      return;
    }
    if (sub === 'adopt') {
      const outcome = await adoptGoogleCredentials(
        ctx,
        { setup: '/google connect', status: '/google status' },
        { confirmReplace: saidYes(rest) },
      );
      ctx.print(outcome.text);
      return;
    }
    if (sub === 'setup') return await runSetup(rest, ctx);
    if (sub === 'account') return await setAccount(rest, ctx);
    if (sub === 'calendar-address') return await setCalendarAddress(rest, ctx);
    if (sub === 'runbook') {
      ctx.print(renderGoogleSetupRunbook());
      return;
    }
    if (sub === 'approve') return approveRefusedOutwardAction(ctx);
    if (sub === 'client-file') {
      const path = (rest[0] ?? '').trim();
      if (path.length === 0) {
        ctx.print('Give the path to the downloaded client JSON: /google client-file <path>');
        return;
      }
      return await runSetup(['--path', 'oauth'], ctx, { kind: 'client-json-file', path });
    }
    if (sub === 'client') {
      const clientId = (rest[0] ?? '').trim();
      const clientSecret = (rest[1] ?? '').trim();
      if (clientId.length === 0 || clientSecret.length === 0) {
        ctx.print('Give both values: /google client <client-id> <client-secret>');
        return;
      }
      return await runSetup(['--path', 'oauth'], ctx, { kind: 'manual-entry', clientId, clientSecret });
    }
    ctx.print(USAGE);
  } catch (error) {
    ctx.print(`Google setup could not run: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function registerGoogleRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'google',
    aliases: ['gmail'],
    description: 'Connect Gmail and Google Calendar: one command, one consent link, proven by use',
    usage: 'connect | status | reauthorize | forget [--yes] | adopt [--yes] | setup [--path app-password|oauth|existing-client] | client-file <path> | client <id> <secret> | account <address> | calendar-address <url> | runbook | approve',
    argsHint: 'connect|status|reauthorize|forget|adopt|setup|client-file|client|account|calendar-address|runbook|approve',
    handler: runGoogleCommand,
  });
}
