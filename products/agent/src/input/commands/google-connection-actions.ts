import { googleSetupWritePorts } from './google-setup-effects.ts';
import type { JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
/**
 * The Google connection actions, owned in one place so every surface runs the
 * same code.
 *
 * `/google` was the first caller and for a while the only one. The workspace UI
 * now offers the same routes as cards, and the rule that made this file
 * necessary is that neither surface may carry its own copy: a second
 * implementation of "adopt the credentials on this machine" is a second thing
 * that can be wrong, and the two would drift the moment one of them was fixed.
 * So the ports, the status report, the adoption and the flow run all live here,
 * and the command and the workspace editors are thin renderers over them.
 *
 * The split is deliberate about what each side owns: this module decides what
 * happens and returns text; the caller decides where that text goes, the
 * console for the command, an action result panel for the workspace.
 *
 * The connector itself is `@goodvibes-jev/engine/sdk/platform/google`, the flows,
 * the step plan, the credential handling and the browser-driven pages all live
 * there now, so the daemon can run them too. What stayed here is the wiring
 * that only this product can supply: config and secret access through the
 * running shell, and a browser built from the agent's own untrusted-content
 * ledger. This file composes those; it implements none of them.
 *
 * Nothing here ever returns a credential. Values go from a flow straight into
 * the encrypted secret store; the status text reports presence, provenance,
 * scopes and expiry only.
 */

import type { CommandContext } from '../command-registry.ts';
import { requirePlatform, requireSecretsManager, requireShellPaths } from './runtime-services.ts';
import {
  adoptExistingGoogleCredentials,
  buildGoogleSetupRunners,
  createGoogleBrowserPort,
  describeGoogleConnectionPlan,
  describeGoogleConnectionProof,
  describeGoogleSetupState,
  detectGoogleSetupState,
  openGoogleConnection,
  planGoogleConnection,
  proveGoogleConnection,
  removeGoogleCredentials,
  runGoogleSetupFlow,
  type GoogleBrowserPort,
  type GoogleClientIntakeChoice,
  type GoogleConfigPort,
  type GoogleConnectionPlan,
  type GoogleCredentialItem,
  type GoogleProgressPort,
  type GoogleSecretPort,
  type GoogleSetupActionDeps,
  type GoogleSetupPath,
  type GoogleSetupReport,
} from '@goodvibes-jev/engine/sdk/platform/google';
import {
  createProcessCommandPort,
  nodeGoogleFilePort,
  startLoopbackListener,
} from '@goodvibes-jev/engine/sdk/platform/google/node';
import { ensureConnectorConfigSections } from '@goodvibes-jev/engine/sdk/platform/config';
import {
  agentBrowserProfileRoot,
  agentBrowserScreenshotRoot,
  createAgentBrowserEngine,
} from '../../runtime/agent-browser.ts';

// ---------------------------------------------------------------------------
// Ports built from the running shell
// ---------------------------------------------------------------------------

export function googleConfigPort(ctx: CommandContext): GoogleConfigPort {
  const raw = requirePlatform(ctx).configManager;
  // The flow spans three app-layer config sections. Seed all of them before any
  // access: resolvePath throws on a section that is not there. One call rather
  // than three: seeding a subset is how the connector came to work on one
  // surface and throw on the others.
  ensureConnectorConfigSections(raw);
  const manager = raw as {
    get: (key: string) => unknown;
    setDynamic: (key: string, value: unknown) => void;
  };
  return {
    get: (key) => manager.get(key),
    set: (key, value) => { manager.setDynamic(key, value); },
  };
}

/**
 * Encrypted secret storage for the connector's credentials.
 *
 * No scope is passed, and that is the whole point. Every name in
 * `GOOGLE_SECRET_KEYS` derives from a daemon-owned config path, so the store
 * files it in the daemon tier by itself. Forcing a surface scope here, which
 * this did until now, overrode that and hid the credential from the daemon,
 * and from any node that later took the work over. The daemon is a consumer of
 * this connector, not a bystander to it.
 */
export function googleSecretPort(ctx: CommandContext): GoogleSecretPort {
  const manager = requireSecretsManager(ctx) as {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string, ownership?: { readonly assertCurrent: () => void }) => Promise<void>;
    delete?: (key: string) => Promise<void>;
  };
  return {
    get: (key) => manager.get(key),
    set: (key, value, ownership) => manager.set(key, value, ownership),
    // Carried so a confirmation-gated removal can actually remove. Nothing
    // reaches it except `forgetGoogleCredentials`, which refuses without an
    // explicit yes, see the SDK's credential-removal.ts.
    ...(manager.delete === undefined ? {} : { delete: (key: string) => manager.delete!(key) }),
  };
}

/** Plain node file reads. Adoption never writes, so there is no write side. */
export const googleFilePort = nodeGoogleFilePort;

/**
 * A browser, created only when a step actually needs one.
 *
 * The profile is named and persistent on purpose: Google blocks automated
 * browsers at its sign-in wall, so the person signs in by hand exactly once and
 * every later run reuses that session. This is also why every surface has to
 * warn that the flow will pause, an unattended run cannot get past it.
 */
export function googleBrowserFactory(ctx: CommandContext): () => Promise<GoogleBrowserPort> {
  const homeDirectory = requireShellPaths(ctx).homeDirectory;
  let port: GoogleBrowserPort | null = null;
  return async () => {
    if (port !== null) return port;
    const engine = createAgentBrowserEngine({
      profileRoot: agentBrowserProfileRoot(homeDirectory),
      screenshotDirectory: agentBrowserScreenshotRoot(homeDirectory),
      homeDirectory,
    });
    port = createGoogleBrowserPort(engine, { launch: { profileName: 'google', headless: false } });
    return port;
  };
}

const googleSetupRequests = new WeakMap<CommandContext, object>();

export interface GoogleSetupExecutionOptions extends JudgmentReadingOptions {
  /** A caller-owned browser adapter; defaults to the agent browser. */
  readonly browser?: (() => Promise<GoogleBrowserPort>) | undefined;
}

export function googleActionDeps(ctx: CommandContext, intake?: GoogleClientIntakeChoice, options: GoogleSetupExecutionOptions = {}): GoogleSetupActionDeps {
  const homeDirectory = requireShellPaths(ctx).homeDirectory;
  const platform = ctx.platform, session = ctx.session, runtime = session.runtime;
  const sessionId = runtime.sessionId, configManager = platform.configManager;
  const secretsManager = requireSecretsManager(ctx);
  const request = Object.freeze({});
  googleSetupRequests.set(ctx, request);
  const configGet = configManager.get, configSet = configManager.setDynamic;
  const secretGet = secretsManager.get, secretSet = secretsManager.set;
  const signal = options.signal, externalCurrent = options.assertCurrent;
  const assertCurrent = () => {
    if (signal?.aborted) throw new Error('The Google setup request was cancelled.');
    const result: unknown = externalCurrent?.();
    if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new Error('The Google setup request guard must be synchronous.'); }
    if (googleSetupRequests.get(ctx) !== request || configManager.get !== configGet || configManager.setDynamic !== configSet
      || secretsManager.get !== secretGet || secretsManager.set !== secretSet || ctx.platform !== platform || ctx.session !== session || session.runtime !== runtime
      || runtime.sessionId !== sessionId || platform.configManager !== configManager
      || requireSecretsManager(ctx) !== secretsManager) throw new Error('The Google setup request is no longer current.');
  };
  const writes = googleSetupWritePorts(configManager, secretsManager, googleConfigPort(ctx), googleSecretPort(ctx), assertCurrent);
  return {
    assertCurrent: writes.assertCurrent,
    signal,
    config: writes.config,
    secrets: writes.secrets,
    browser: options.browser ?? googleBrowserFactory(ctx),
    commands: createProcessCommandPort(),
    fetchPort: { fetch: (url, init) => fetch(url, init) },
    files: googleFilePort,
    // Binding the port Google redirects back to is real machine I/O, so the
    // connector takes it as a port and the concrete listener is named here.
    loopback: startLoopbackListener,
    homeDirectory,
    ...(intake === undefined ? {} : { clientIntake: intake }),
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** The live Google client, or null when nothing is connected. */
async function openConnection(ctx: CommandContext, signedInAccount: string | null) {
  return await openGoogleConnection(
    {
      files: googleFilePort,
      homeDirectory: requireShellPaths(ctx).homeDirectory,
      configGet: (key) => googleConfigPort(ctx).get(key),
      secretGet: (key) => googleSecretPort(ctx).get(key),
    },
    { fetch: { fetch: (url: string, init: RequestInit) => fetch(url, init) }, signedInAccount },
  );
}

/**
 * Status.
 *
 * Reports what is configured and, when a credential is stored, what it can
 * actually do, by using it. "A refresh token is present" is not the question
 * anyone is asking; "does mail work, does calendar work" is.
 *
 * What this deliberately no longer does is rummage through the home directory
 * for another tool's credential files and offer to adopt whatever it finds.
 * Most people have no such files, and going looking unasked is not this
 * command's business. Adoption is still here, reached by asking for it.
 */
export async function describeGoogleConnection(ctx: CommandContext): Promise<string> {
  const config = googleConfigPort(ctx);
  const secrets = googleSecretPort(ctx);

  const state = await detectGoogleSetupState({ config, secrets });
  const lines = ['Google connection', ...describeGoogleSetupState(state).map((entry) => `  ${entry}`)];

  if (!state.hasRefreshToken) {
    lines.push('', 'Connect it with: /google connect');
    return lines.join('\n');
  }

  const connection = await openConnection(ctx, null);
  if (connection === null) {
    lines.push('', 'A credential is recorded but could not be assembled. Repair it with: /google connect');
    return lines.join('\n');
  }

  lines.push('', 'Proven by use');
  for (const entry of describeGoogleConnectionProof(await proveGoogleConnection(connection.client))) {
    lines.push(`  ${entry}`);
  }
  return lines.join('\n');
}

export interface GoogleAdoptionOutcome {
  readonly adopted: boolean;
  readonly text: string;
}

/**
 * Take up credentials from files on this machine.
 *
 * Reached only because someone asked, by running the adopt command or by
 * naming a path. Nothing calls this from status or discovery, and nothing
 * scans for these files on its own.
 *
 * `confirmReplace` carries the owner's yes when adoption would overwrite a
 * refresh token that is already stored. Overwriting one destroys it as surely
 * as deleting it, so it is confirmed rather than assumed.
 */
export async function adoptGoogleCredentials(
  ctx: CommandContext,
  hints: { readonly setup: string; readonly status: string },
  options: { readonly confirmReplace?: boolean } = {},
): Promise<GoogleAdoptionOutcome> {
  const outcome = await adoptExistingGoogleCredentials({
    files: googleFilePort,
    config: googleConfigPort(ctx),
    secrets: googleSecretPort(ctx),
    homeDirectory: requireShellPaths(ctx).homeDirectory,
    ...(options.confirmReplace === undefined ? {} : { confirmReplace: options.confirmReplace }),
  });

  if (outcome.needsConfirmation === true) {
    return {
      adopted: false,
      text: [outcome.detail, outcome.prompt ?? '', 'Confirm with: /google adopt --yes'].filter(Boolean).join('\n'),
    };
  }

  if (!outcome.adopted) {
    return {
      adopted: false,
      text: [outcome.detail, `Connect an account instead with: ${hints.setup}`].join('\n'),
    };
  }

  return {
    adopted: true,
    text: [
      outcome.detail,
      outcome.scopes.length > 0 ? `Granted scopes: ${outcome.scopes.join(', ')}` : 'The credential lists no scopes.',
      `Check what this enables with: ${hints.status}`,
    ].join('\n'),
  };
}

/** Run one setup path end to end. The caller supplies where progress goes. */
export async function runGoogleSetup(
  path: GoogleSetupPath,
  ctx: CommandContext,
  progress: GoogleProgressPort,
  intake?: GoogleClientIntakeChoice,
  options: GoogleSetupExecutionOptions = {},
): Promise<GoogleSetupReport> {
  return await runGoogleSetupFlow(path, {
    progress,
    runners: buildGoogleSetupRunners(path, googleActionDeps(ctx, intake, options)),
  });
}

/** Work out how to connect, without changing anything. */
export async function planGoogleConnectionFor(ctx: CommandContext): Promise<GoogleConnectionPlan> {
  return await planGoogleConnection({
    config: googleConfigPort(ctx),
    secrets: googleSecretPort(ctx),
    commands: createProcessCommandPort(),
    homeDirectory: requireShellPaths(ctx).homeDirectory,
  });
}

export interface GoogleConnectOutcome {
  readonly connected: boolean;
  readonly text: string;
}

/**
 * `/google connect`, discovery first, then the shortest route to a working
 * connection, then proof that it works.
 *
 * The bar this is written to: from "connect google" to working mail AND
 * calendar, the person does at most one thing, open a printed link and
 * approve it. Everything else belongs to the flow. When a route needs a second
 * action, the plan says so and says why, and the only reason that survives is
 * a fact about Google (creating an OAuth client has no API and no gcloud
 * command; only the console does it).
 */
export async function connectGoogle(
  ctx: CommandContext,
  progress: GoogleProgressPort,
  announceConsentUrl: (url: string) => void,
): Promise<GoogleConnectOutcome> {
  const plan = await planGoogleConnectionFor(ctx);
  const lines: string[] = [...describeGoogleConnectionPlan(plan)];

  // Already complete: refresh it and prove it, asking nobody anything.
  if (plan.route === 'stored-credential') {
    const connection = await openConnection(ctx, plan.gcloud?.account ?? null);
    if (connection === null) {
      return { connected: false, text: [...lines, 'The stored credential could not be assembled.'].join('\n') };
    }
    const proof = await proveGoogleConnection(connection.client);
    return {
      connected: proof.ok,
      text: [...lines, '', ...describeGoogleConnectionProof(proof)].join('\n'),
    };
  }

  const setupPath = plan.setupPath ?? 'oauth';
  const deps: GoogleSetupActionDeps = {
    ...googleActionDeps(ctx),
    announceConsentUrl,
    ...(plan.intendedAccount === null ? {} : { loginHint: plan.intendedAccount }),
    proveConnection: async () => {
      const connection = await openConnection(ctx, plan.gcloud?.account ?? null);
      if (connection === null) {
        return {
          ok: false,
          detail: 'The credential was stored but could not be assembled into a working client.',
          problem: 'The stored client id, client secret and refresh token did not combine into a usable credential.',
          fix: 'Run /google status to see which half is missing.',
        };
      }
      const proof = await proveGoogleConnection(connection.client);
      return proof.ok
        ? { ok: true, detail: proof.summary }
        : {
          ok: false,
          detail: proof.summary,
          problem: proof.mail.problem ?? proof.calendar.problem ?? proof.summary,
          fix: proof.mail.fix ?? proof.calendar.fix ?? 'Run /google reauthorize.',
        };
    },
  };

  const report = await runGoogleSetupFlow(setupPath, {
    progress,
    runners: buildGoogleSetupRunners(setupPath, deps),
  });

  return { connected: report.ok, text: [...lines, '', report.summary].join('\n') };
}

/**
 * `/google reauthorize`, a fresh consent covering every scope, without
 * deleting anything.
 *
 * This is the command the old error text pointed at and which did not exist.
 * It runs the existing-client path, which is consent and proof only: the
 * client is already there, so nothing about the project or the console is
 * touched. The stored refresh token is replaced by Google issuing a new one on
 * a fresh consent, the person's approval IS the confirmation, which is why
 * this does not additionally prompt.
 */
export async function reauthorizeGoogle(
  ctx: CommandContext,
  progress: GoogleProgressPort,
  announceConsentUrl: (url: string) => void,
): Promise<GoogleConnectOutcome> {
  const config = googleConfigPort(ctx);
  const secrets = googleSecretPort(ctx);
  const state = await detectGoogleSetupState({ config, secrets });

  if (state.oauthClientId === null || !state.hasOAuthClientSecret) {
    return {
      connected: false,
      text: 'There is no OAuth client to re-authorize against yet. Start with: /google connect',
    };
  }

  const plan = await planGoogleConnectionFor(ctx);
  const deps: GoogleSetupActionDeps = {
    ...googleActionDeps(ctx),
    announceConsentUrl,
    ...(plan.intendedAccount === null ? {} : { loginHint: plan.intendedAccount }),
    // Google returns a new refresh token on a fresh consent, and the authorize
    // step stores it. Forcing the step to run means clearing the "already
    // authorized" short-circuit, which is what the removal below is for, and
    // it is the one removal that does not need a separate yes, because the
    // person is about to approve a replacement on the consent screen.
    proveConnection: async () => {
      const connection = await openConnection(ctx, plan.gcloud?.account ?? null);
      if (connection === null) return { ok: false, detail: 'No usable credential after consent.' };
      const proof = await proveGoogleConnection(connection.client);
      return proof.ok
        ? { ok: true, detail: proof.summary }
        : { ok: false, detail: proof.summary, problem: proof.calendar.problem ?? proof.mail.problem ?? proof.summary };
    },
  };

  const removal = await removeGoogleCredentials(
    { secrets, config },
    { items: ['refresh-token'], confirmed: true, reason: 'Replacing it with the token this consent produces.' },
  );

  const report = await runGoogleSetupFlow('existing-client', {
    progress,
    runners: buildGoogleSetupRunners('existing-client', deps),
  });

  const preamble = removal.confirmed && removal.removed.length > 0
    ? 'Replacing the existing refresh token with a fresh consent covering mail and calendar together.'
    : 'Asking for a fresh consent covering mail and calendar together.';

  return { connected: report.ok, text: [preamble, '', report.summary].join('\n') };
}

/**
 * `/google forget`, remove stored credentials, only ever with an explicit yes.
 *
 * Called without confirmation this changes nothing and returns the question.
 * The agent deleted a refresh token mid-flow with nothing asked and nothing
 * announced, and this is the shape that makes that impossible.
 */
export async function forgetGoogleCredentials(
  ctx: CommandContext,
  items: readonly GoogleCredentialItem[],
  confirmed: boolean,
): Promise<string> {
  const result = await removeGoogleCredentials(
    { secrets: googleSecretPort(ctx), config: googleConfigPort(ctx) },
    { items, confirmed },
  );

  if (result.confirmed) return result.detail;
  if ('refused' in result) return result.prompt;
  return [result.prompt, 'Confirm with: /google forget --yes'].join('\n');
}
