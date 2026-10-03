import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { beginOpenAICodexLogin, exchangeOpenAICodexCode } from '@goodvibes-jev/engine/sdk/platform/config';
import type { OAuthProviderConfig, ProviderSubscription } from '@goodvibes-jev/engine/sdk/platform/config';
import { getSubscriptionProviderConfig, listAvailableSubscriptionProviders } from '@goodvibes-jev/engine/sdk/platform/config';
import { inspectProviderAuth } from '@/runtime/index.ts';
import { formatAgentRecordSource } from '../../agent/record-labels.ts';
import { openExternalUrl } from '@goodvibes-jev/engine/sdk/platform/utils';
import { requireSecretsManager, requireServiceRegistry, requireShellPaths, requireSubscriptionManager } from './runtime-services.ts';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';

interface SubscriptionBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly subscriptions: readonly ProviderSubscription[];
}

function buildReviewText(ctx: CommandContext): string {
  const subscriptions = requireSubscriptionManager(ctx).list();
  const available = listAvailableSubscriptionProviders(requireServiceRegistry(ctx).getAll());
  if (subscriptions.length === 0) {
    return [
      'Subscription Review',
      '  No provider subscriptions stored yet.',
      ...(available.length > 0 ? [`  available providers ${available.map((entry) => entry.provider).join(', ')}`] : []),
    ].join('\n');
  }
  return [
    `Subscription Review`,
    ...subscriptions.map((subscription) => (
      `  ${subscription.provider}  auth mode ${subscription.authMode}  token ${subscription.tokenType}  expires ${subscription.expiresAt ? new Date(subscription.expiresAt).toISOString() : 'n/a'}`
    )),
  ].join('\n');
}

function inspectBundle(path: string): string {
  const bundle = JSON.parse(readFileSync(path, 'utf-8')) as SubscriptionBundle;
  return [
    'Subscription Bundle Review',
    `  exported at ${new Date(bundle.exportedAt).toISOString()}`,
    `  subscriptions ${bundle.subscriptions.length}`,
    ...bundle.subscriptions.map((subscription) => `  ${subscription.provider}  ${subscription.authMode}`),
  ].join('\n');
}

function extractAuthorizationCode(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    return url.searchParams.get('code');
  } catch {
    return null;
  }
}

function resolveManualLoginConfig(config: OAuthProviderConfig): OAuthProviderConfig {
  return config.manualRedirectUri
    ? { ...config, redirectUri: config.manualRedirectUri }
    : config;
}

function describePrecedence(record: Pick<ProviderSubscription, 'overrideAmbientApiKeys'>): string {
  return record.overrideAmbientApiKeys
    ? '  precedence this now overrides ambient API keys for the provider'
    : '  precedence stored for subscription-backed flows only; ambient API keys are unchanged';
}

export function registerSubscriptionRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'subscription',
    aliases: ['subs'],
    description: 'Manage provider subscription sessions and, when supported, let them override ambient API keys for matching providers',
    hidden: true,
    usage: '[review|list|providers|inspect <provider>|login <provider> start [--no-browser] --yes|login <provider> finish <code-or-url> --yes|logout <provider> --yes|bundle export <path> --yes|bundle inspect <path>]',
    async handler(args, ctx) {
      const parsed = stripYesFlag(args);
      const commandArgs = [...parsed.rest];
      const sub = (commandArgs[0] ?? 'review').toLowerCase();
      const manager = requireSubscriptionManager(ctx);
      const services = requireServiceRegistry(ctx);

      if (sub === 'review' || sub === 'list') {
        ctx.print(buildReviewText(ctx));
        return;
      }

      if (sub === 'providers') {
        const available = listAvailableSubscriptionProviders(services.getAll());
        if (available.length === 0) {
          ctx.print('No subscription-capable providers are currently configured or built in.');
          return;
        }
        ctx.print([
          'Available Subscription Providers',
          ...available.map((provider) => (
            `  ${provider.provider}  origin ${formatAgentRecordSource(provider.source)}  redirect ${provider.oauth.redirectUri}`
          )),
        ].join('\n'));
        return;
      }

      if (sub === 'inspect') {
        const provider = commandArgs[1];
        if (!provider) {
          ctx.print('Usage: /subscription inspect <provider>');
          return;
        }
        const resolved = getSubscriptionProviderConfig(provider, services.get(provider));
        if (!resolved && !manager.get(provider) && !manager.getPending(provider)) {
          ctx.print(`No stored or available subscription provider named ${provider}.`);
          return;
        }
        let inspection;
        try {
          inspection = await inspectProviderAuth(provider, {
            serviceRegistry: services,
            subscriptionManager: manager,
            secretsManager: requireSecretsManager(ctx),
          });
        } catch (error) {
          ctx.print(`Could not inspect provider auth for ${provider}: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        ctx.print([
          `Subscription ${provider}`,
          `  configured ${inspection.configured ? 'yes' : 'no'}`,
          `  freshness ${inspection.freshness}`,
          '  finish mode explicit manual',
          ...(resolved ? [
            `  origin ${formatAgentRecordSource(resolved.source)}`,
            `  redirect URI ${resolved.oauth.redirectUri}`,
            `  auth URL ${resolved.oauth.authUrl}`,
            `  token URL ${resolved.oauth.tokenUrl}`,
          ] : []),
          ...(inspection.activeSubscription ? [
            `  auth mode ${manager.get(provider)?.authMode ?? 'oauth'}`,
            `  token type ${inspection.tokenType ?? 'n/a'}`,
            `  created at ${manager.get(provider)?.createdAt ? new Date(manager.get(provider)!.createdAt).toISOString() : 'n/a'}`,
            `  updated at ${manager.get(provider)?.updatedAt ? new Date(manager.get(provider)!.updatedAt).toISOString() : 'n/a'}`,
            `  expires at ${inspection.expiresAt ? new Date(inspection.expiresAt).toISOString() : 'n/a'}`,
            `  refresh token ${manager.get(provider)?.refreshToken ? 'present' : 'absent'}`,
            describePrecedence(manager.get(provider)!),
          ] : [
            `  state ${inspection.freshness === 'pending' ? 'pending login' : 'available for login'}`,
          ]),
          ...inspection.issues.map((issue) => `  issue ${issue}`),
          ...inspection.nextActions.map((action) => `  next ${action}`),
        ].join('\n'));
        return;
      }

      if (sub === 'login') {
        const provider = commandArgs[1];
        const mode = commandArgs[2]?.toLowerCase();
        if (!provider || !mode) {
          ctx.print('Usage: /subscription login <provider> start|finish <code> --yes');
          return;
        }
        if (!parsed.yes) {
          requireYesFlag(ctx, `${mode} provider subscription login for ${provider}`, '/subscription login <provider> start|finish <code> --yes');
          return;
        }
        const service = services.get(provider);
        const resolved = getSubscriptionProviderConfig(provider, service);
        if (!resolved) {
          ctx.print([
            `OAuth is not configured for ${provider}.`,
            'Add an oauth block to .goodvibes/agent/services.json for that provider, for example:',
            `  { "name": "${provider}", "authType": "oauth", "tokenKey": "${provider.toUpperCase()}_API_KEY", "providerId": "${provider}", "oauth": { "authUrl": "...", "tokenUrl": "...", "clientId": "...", "redirectUri": "http://127.0.0.1/callback", "scopes": ["..."] } }`,
          ].join('\n'));
          return;
        }
        if (mode === 'start') {
          const flags = new Set(commandArgs.slice(3));
          const openBrowser = !flags.has('--no-browser');
          if (provider === 'openai' && resolved.source === 'builtin') {
            const started = await beginOpenAICodexLogin();
            manager.savePending({
              provider,
              state: started.state,
              verifier: started.verifier,
              redirectUri: started.redirectUri,
              createdAt: Date.now(),
            });

            const browserOpened = openBrowser
              ? await openExternalUrl(started.authorizationUrl)
              : false;

            ctx.print([
              `Subscription OAuth start ${provider}`,
              `  origin ${formatAgentRecordSource(resolved.source)}`,
              `  state ${started.state}`,
              `  redirect URI ${started.redirectUri}`,
              `  browser ${openBrowser ? (browserOpened ? 'opened' : 'open failed') : 'skipped'}`,
              '  completion paste the callback code or redirect URL into the finish command',
              `  next /subscription login ${provider} finish <code-or-url> --yes`,
              '  authorization URL',
              `  ${started.authorizationUrl}`,
            ].join('\n'));
            return;
          }
          const activeConfig = resolveManualLoginConfig(resolved.oauth);
          const started = await manager.beginOAuthLogin(provider, activeConfig);
          const browserOpened = openBrowser
            ? await openExternalUrl(started.authorizationUrl)
            : false;

          ctx.print([
            `Subscription OAuth start ${provider}`,
            `  origin ${formatAgentRecordSource(resolved.source)}`,
            `  state ${started.pending.state}`,
            `  redirect URI ${activeConfig.redirectUri}`,
            `  browser ${openBrowser ? (browserOpened ? 'opened' : 'open failed') : 'skipped'}`,
            '  completion paste the callback code or redirect URL into the finish command',
            `  next /subscription login ${provider} finish <code-or-url> --yes`,
            '  authorization URL',
            `  ${started.authorizationUrl}`,
          ].join('\n'));
          return;
        }
        if (mode === 'finish') {
          const codeInput = commandArgs[3];
          if (!codeInput) {
            ctx.print(`Usage: /subscription login ${provider} finish <code-or-url> --yes`);
            return;
          }
          const code = extractAuthorizationCode(codeInput) ?? codeInput;
          if (provider === 'openai' && resolved.source === 'builtin') {
            const pending = manager.getPending(provider);
            if (!pending) {
              ctx.print(`No pending OAuth login for ${provider}. Start with /subscription login ${provider} start --yes.`);
              return;
            }
            let token;
            try {
              token = await exchangeOpenAICodexCode(code, pending.verifier);
            } catch (error) {
              ctx.print(`Could not exchange authorization code for ${provider}: ${error instanceof Error ? error.message : String(error)}`);
              return;
            }
            const now = Date.now();
            const record = manager.saveSubscription({
              provider,
              accessToken: token.accessToken,
              refreshToken: token.refreshToken,
              tokenType: token.tokenType,
              expiresAt: token.expiresAt,
              ...(token.scopes ? { scopes: token.scopes } : {}),
              authMode: 'oauth',
              overrideAmbientApiKeys: false,
              createdAt: manager.get(provider)?.createdAt ?? now,
              updatedAt: now,
            });
            ctx.print([
              `Stored subscription session for ${provider}.`,
              `  token type ${record.tokenType}`,
              `  expires at ${record.expiresAt ? new Date(record.expiresAt).toISOString() : 'n/a'}`,
              describePrecedence(record),
            ].join('\n'));
            return;
          }
          const activeConfig = resolveManualLoginConfig(resolved.oauth);
          let record;
          try {
            record = await manager.completeOAuthLogin(provider, activeConfig, code);
          } catch (error) {
            ctx.print(`Could not complete OAuth login for ${provider}: ${error instanceof Error ? error.message : String(error)}`);
            return;
          }
          ctx.print([
            `Stored subscription session for ${provider}.`,
            `  token type ${record.tokenType}`,
            `  expires at ${record.expiresAt ? new Date(record.expiresAt).toISOString() : 'n/a'}`,
            describePrecedence(record),
          ].join('\n'));
          return;
        }
        ctx.print('Usage: /subscription login <provider> start|finish <code-or-url> --yes');
        return;
      }

      if (sub === 'logout') {
        const provider = commandArgs[1];
        if (!provider) {
          ctx.print('Usage: /subscription logout <provider> --yes');
          return;
        }
        if (!parsed.yes) {
          requireYesFlag(ctx, `log out provider subscription ${provider}`, '/subscription logout <provider> --yes');
          return;
        }
        const removed = manager.logout(provider);
        ctx.print(removed
          ? `Logged out of ${provider}. Ambient API key resolution will apply again if configured.`
          : `No stored subscription session existed for ${provider}.`);
        return;
      }

      if (sub === 'bundle') {
        const mode = commandArgs[1]?.toLowerCase();
        const pathArg = commandArgs[2];
        if (!mode || !pathArg) {
          ctx.print('Usage: /subscription bundle <export|inspect> <path>');
          return;
        }
        const targetPath = requireShellPaths(ctx).resolveWorkspacePath(pathArg);
        if (mode === 'export') {
          if (!parsed.yes) {
            requireYesFlag(ctx, `export subscription bundle to ${pathArg}`, '/subscription bundle export <path> --yes');
            return;
          }
          const bundle: SubscriptionBundle = {
            version: 1,
            exportedAt: Date.now(),
            subscriptions: manager.list(),
          };
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
          ctx.print(`Subscription bundle exported to ${targetPath}`);
          ctx.print('This file contains active sign-in tokens. Keep it private and delete it after use.');
          return;
        }
        if (mode === 'inspect') {
          try {
            ctx.print(inspectBundle(targetPath));
          } catch (error) {
            ctx.print(`Could not read that bundle file: ${error instanceof Error ? error.message : String(error)}`);
          }
          return;
        }
        ctx.print('Usage: /subscription bundle <export|inspect> <path>');
        return;
      }

      ctx.print('Usage: /subscription [review|list|providers|inspect <provider>|login <provider> start [--no-browser] --yes|login <provider> finish <code-or-url> --yes|logout <provider> --yes|bundle export <path> --yes|bundle inspect <path>]');
    },
  });
}
