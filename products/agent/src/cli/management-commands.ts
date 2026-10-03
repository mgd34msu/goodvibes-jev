import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SecretsManager } from '../config/secrets.ts';
import { credentialWriteScopeWasRelocated, resolveCredentialDeleteScope, resolveCredentialWriteScope } from '../config/credential-scope.ts';
import { BUILTIN_SECRET_PROVIDER_SOURCES, describeSecretRef, isSecretRefInput, resolveSecretRef } from '@goodvibes-jev/engine/sdk/platform/config';
import { getSubscriptionProviderConfig, listAvailableSubscriptionProviders } from '@goodvibes-jev/engine/sdk/platform/config';
import type { OAuthProviderConfig } from '@goodvibes-jev/engine/sdk/platform/config';
import { beginOpenAICodexLogin, exchangeOpenAICodexCode } from '@goodvibes-jev/engine/sdk/platform/config';
import { inspectProviderAuth } from '@/runtime/index.ts';
import { buildCompanionConnectionInfo, encodeConnectionPayload, formatConnectionBlock } from '@goodvibes-jev/engine/sdk/platform/pairing';
import { generateQrMatrix, renderQrToString } from '@goodvibes-jev/engine/sdk/platform/pairing';
import { resolveRuntimeEndpointBinding } from './endpoints.ts';
import type { CliCommandRuntime } from './management.ts';
import { extractAuthorizationCode, formatJsonOrText, hasCommandFlag, openBrowser, urlHostForBindHost, withRuntimeServices, yesNo } from './management.ts';
import { GOODVIBES_AGENT_PAIRING_SURFACE } from '../config/surface.ts';
import { connectedHostTokenRequiredMessage, readConnectedHostOperatorToken } from '../runtime/connected-host-auth.ts';
import { formatAgentRecordSource } from '../agent/record-labels.ts';
import { appendTemporalLabel } from './temporal-label.ts';

function resolveManualSubscriptionConfig(config: OAuthProviderConfig): OAuthProviderConfig {
  return config.manualRedirectUri
    ? { ...config, redirectUri: config.manualRedirectUri }
    : config;
}

export async function renderSubscriptions(runtime: CliCommandRuntime): Promise<string> {
  return await withRuntimeServices(runtime, async (services) => {
    const binary = runtime.cli.binary;
    const [sub = 'list', ...rest] = runtime.cli.commandArgs;
    const subscriptions = services.subscriptionManager.list();
    const pending = services.subscriptionManager.listPending();
    const available = listAvailableSubscriptionProviders(services.serviceRegistry.getAll());
    if (sub === 'providers') {
      return formatJsonOrText(runtime.cli)(available, [
        'GoodVibes subscription providers',
        ...available.map((provider) => `  ${provider.provider}  origin ${provider.source}  redirect ${provider.oauth.redirectUri}`),
      ].join('\n'));
    }
    if (sub === 'inspect' || sub === 'show') {
      const provider = rest[0];
      if (!provider) return `Usage: ${binary} subscription inspect <provider>`;
      const resolved = getSubscriptionProviderConfig(provider, services.serviceRegistry.get(provider));
      if (!resolved && !services.subscriptionManager.get(provider) && !services.subscriptionManager.getPending(provider)) {
        return `No stored or available subscription provider named ${provider}.`;
      }
      const inspection = await inspectProviderAuth(provider, {
        serviceRegistry: services.serviceRegistry,
        subscriptionManager: services.subscriptionManager,
        secretsManager: services.secretsManager,
      });
      const stored = services.subscriptionManager.get(provider);
      return formatJsonOrText(runtime.cli)({ provider, resolved, inspection, stored }, [
        `GoodVibes subscription ${provider}`,
        `  configured ${yesNo(inspection.configured)}`,
        `  freshness ${inspection.freshness}`,
        '  finish mode explicit manual',
        ...(resolved ? [
          `  origin ${formatAgentRecordSource(resolved.source)}`,
          `  redirect URI ${resolved.oauth.redirectUri}`,
        ] : []),
        ...(stored ? [
          `  token type ${stored.tokenType}`,
          `  expires ${stored.expiresAt ? appendTemporalLabel(new Date(stored.expiresAt).toISOString(), stored.expiresAt) : 'n/a'}`,
          `  refresh token ${stored.refreshToken ? 'present' : 'absent'}`,
          `  override ambient ${yesNo(stored.overrideAmbientApiKeys)}`,
        ] : ['  stored no']),
        ...inspection.issues.map((issue) => `  issue ${issue}`),
        ...inspection.nextActions.map((action) => `  next ${action}`),
      ].join('\n'));
    }
    if (sub === 'login' || sub === 'start') {
      const provider = sub === 'start' ? rest[0] : rest[0];
      const mode = sub === 'start' ? 'start' : rest[1]?.toLowerCase();
      if (!provider || mode !== 'start') return `Usage: ${binary} subscription login <provider> start [--open]`;
      const resolved = getSubscriptionProviderConfig(provider, services.serviceRegistry.get(provider));
      if (!resolved) return `No subscription provider found ${provider}`;
      if (provider === 'openai' && resolved.source === 'builtin') {
        const started = await beginOpenAICodexLogin();
        services.subscriptionManager.savePending({
          provider,
          state: started.state,
          verifier: started.verifier,
          redirectUri: started.redirectUri,
          createdAt: Date.now(),
        });
        const openResult = runtime.cli.flags.open || hasCommandFlag(rest, '--open') ? openBrowser(started.authorizationUrl) : null;
        return [
          `Subscription OAuth started ${provider}`,
          `  origin ${formatAgentRecordSource(resolved.source)}`,
          `  state ${started.state}`,
          `  redirect URI ${started.redirectUri}`,
          ...(openResult ? [`  open ${openResult}`] : []),
          '  completion paste the callback code or redirect URL into the finish command',
          `  next ${binary} subscription login ${provider} finish <code-or-url>`,
          '  authorization URL',
          `  ${started.authorizationUrl}`,
        ].join('\n');
      }
      const activeConfig = resolveManualSubscriptionConfig(resolved.oauth);
      const started = await services.subscriptionManager.beginOAuthLogin(provider, activeConfig);
      const openResult = runtime.cli.flags.open || hasCommandFlag(rest, '--open') ? openBrowser(started.authorizationUrl) : null;
      return [
        `Subscription OAuth started ${provider}`,
        `  origin ${formatAgentRecordSource(resolved.source)}`,
        `  state ${started.pending.state}`,
        `  redirect URI ${started.pending.redirectUri}`,
        ...(openResult ? [`  open ${openResult}`] : []),
        '  completion paste the callback code or redirect URL into the finish command',
        `  next ${binary} subscription login ${provider} finish <code-or-url>`,
        '  authorization URL',
        `  ${started.authorizationUrl}`,
      ].join('\n');
    }
    if (sub === 'finish' || (sub === 'login' && rest[1]?.toLowerCase() === 'finish')) {
      const provider = sub === 'finish' ? rest[0] : rest[0];
      const codeInput = sub === 'finish' ? rest[1] : rest[2];
      if (!provider || !codeInput) return `Usage: ${binary} subscription login <provider> finish <code-or-url>`;
      const resolved = getSubscriptionProviderConfig(provider, services.serviceRegistry.get(provider));
      if (!resolved) return `No subscription provider found ${provider}`;
      const code = extractAuthorizationCode(codeInput);
      if (provider === 'openai' && resolved.source === 'builtin') {
        const pendingLogin = services.subscriptionManager.getPending(provider);
        if (!pendingLogin) return `No pending OAuth login for ${provider}.`;
        const token = await exchangeOpenAICodexCode(code, pendingLogin.verifier);
        const now = Date.now();
        const record = services.subscriptionManager.saveSubscription({
          provider,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          tokenType: token.tokenType,
          expiresAt: token.expiresAt,
          ...(token.scopes ? { scopes: token.scopes } : {}),
          authMode: 'oauth',
          overrideAmbientApiKeys: false,
          createdAt: services.subscriptionManager.get(provider)?.createdAt ?? now,
          updatedAt: now,
        });
        return [
          `Subscription stored ${provider}`,
          `  token type ${record.tokenType}`,
          `  expires ${record.expiresAt ? appendTemporalLabel(new Date(record.expiresAt).toISOString(), record.expiresAt) : 'n/a'}`,
        ].join('\n');
      }
      const activeConfig = resolveManualSubscriptionConfig(resolved.oauth);
      const record = await services.subscriptionManager.completeOAuthLogin(provider, activeConfig, code);
      return [
        `Subscription stored ${provider}`,
        `  token type ${record.tokenType}`,
        `  expires ${record.expiresAt ? appendTemporalLabel(new Date(record.expiresAt).toISOString(), record.expiresAt) : 'n/a'}`,
      ].join('\n');
    }
    if (sub === 'refresh') {
      const provider = rest[0];
      if (!provider) return `Usage: ${binary} subscription refresh <provider>`;
      const resolved = getSubscriptionProviderConfig(provider, services.serviceRegistry.get(provider));
      if (!resolved) return `No subscription provider found ${provider}`;
      const record = await services.subscriptionManager.refreshOAuthToken(provider, resolved.oauth);
      return [
        `Subscription refreshed ${provider}`,
        `  expires ${record.expiresAt ? appendTemporalLabel(new Date(record.expiresAt).toISOString(), record.expiresAt) : 'n/a'}`,
      ].join('\n');
    }
    if (sub === 'logout' || sub === 'remove') {
      const provider = rest[0];
      if (!provider) return `Usage: ${binary} subscription logout <provider>`;
      const removed = services.subscriptionManager.logout(provider);
      return removed ? `Subscription removed ${provider}` : `No stored subscription session existed for ${provider}.`;
    }
    if (sub !== 'list' && sub !== 'status' && sub !== 'review') {
      return `Usage: ${binary} subscription [list|providers|inspect <provider>|login <provider> start|finish <code-or-url>|refresh <provider>|logout <provider>]`;
    }
    const value = {
      subscriptions: subscriptions.map((sub) => ({
        provider: sub.provider,
        tokenType: sub.tokenType,
        expiresAt: sub.expiresAt ?? null,
        overrideAmbientApiKeys: sub.overrideAmbientApiKeys,
      })),
      pending: pending.map((sub) => ({ provider: sub.provider, createdAt: sub.createdAt })),
    };
    return formatJsonOrText(runtime.cli)(value, [
      'GoodVibes subscriptions',
      subscriptions.length === 0 ? '  active none' : '  active',
      ...subscriptions.map((sub) => `    ${sub.provider} token ${sub.tokenType} expires ${sub.expiresAt ? appendTemporalLabel(new Date(sub.expiresAt).toISOString(), sub.expiresAt) : 'n/a'} override ambient ${yesNo(sub.overrideAmbientApiKeys)}`),
      pending.length === 0 ? '  pending none' : '  pending',
      ...pending.map((sub) => `    ${sub.provider} created ${appendTemporalLabel(new Date(sub.createdAt).toISOString(), sub.createdAt)}`),
    ].join('\n'));
  });
}

export async function handleSecrets(runtime: CliCommandRuntime): Promise<string> {
  const secrets = new SecretsManager({
    projectRoot: runtime.workingDirectory,
    globalHome: runtime.homeDirectory,
    configManager: runtime.configManager,
  });
  const [sub = 'list', ...rest] = runtime.cli.commandArgs;
  if (sub === 'providers') {
    const value = { providers: BUILTIN_SECRET_PROVIDER_SOURCES };
    return formatJsonOrText(runtime.cli)(value, [
      'GoodVibes secret providers',
      ...BUILTIN_SECRET_PROVIDER_SOURCES.map((provider) => `  ${provider}`),
      '',
      'Secret refs use goodvibes://secrets/<source>/... and never embed secret values.',
    ].join('\n'));
  }
  if (sub === 'test') {
    const ref = rest.join(' ').trim();
    if (!ref || !ref.startsWith('goodvibes://secrets/') || !isSecretRefInput(ref)) {
      return `Usage: ${runtime.cli.binary} secrets test goodvibes://secrets/<source>/...`;
    }
    const resolved = await resolveSecretRef(ref, { resolveLocalSecret: (key) => secrets.get(key) });
    const value = { ref: describeSecretRef(ref), resolved: Boolean(resolved.value) };
    return formatJsonOrText(runtime.cli)(value, [
      'GoodVibes secret test',
      `  ref ${value.ref}`,
      `  result ${value.resolved ? 'resolved <redacted>' : 'missing'}`,
    ].join('\n'));
  }
  if (sub === 'set' || sub === 'link') {
    const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
    const values = rest.filter((arg) => !arg.startsWith('--'));
    const [key, ...rawValueParts] = values;
    const value = rawValueParts.join(' ');
    if (!key || !value) return `Usage: ${runtime.cli.binary} secrets ${sub} <KEY> <value> [--user|--project] [--secure|--plaintext]`;
    if (sub === 'link' && (!value.startsWith('goodvibes://secrets/') || !isSecretRefInput(value))) {
      return 'Invalid secret reference. Use goodvibes://secrets/<source>/...';
    }
    // The requested scope is what the operator typed (or the historical
    // 'project' default when they typed neither flag), and it is honoured for
    // every credential except one the daemon reads. For those the write is
    // RELOCATED to the daemon tier and said so out loud: `--project` on a
    // mailbox password or a calendar feed URL is a flag nobody thought about,
    // and honouring it means the credential works until this command exits.
    const requestedScope = flags.has('--user') ? 'user' : 'project';
    const scope = resolveCredentialWriteScope(key, requestedScope);
    await secrets.set(key, value, {
      scope,
      medium: flags.has('--plaintext') ? 'plaintext' : 'secure',
    });
    return [
      `Secret ${sub === 'link' ? 'linked' : 'stored'}`,
      `  key ${key}`,
      `  scope ${scope}`,
      ...(credentialWriteScopeWasRelocated(key, requestedScope)
        ? [`  note filed in the daemon tier instead of ${requestedScope}, the daemon is what reads this credential, and it reads only its own tier`]
        : []),
    ].join('\n');
  }
  if (sub === 'delete') {
    const key = rest.find((arg) => !arg.startsWith('--'));
    if (!key) return `Usage: ${runtime.cli.binary} secrets delete <KEY> [--user|--project] [--secure|--plaintext]`;
    const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
    // A daemon-read credential lives in the daemon tier whatever the caller
    // asked for, so the delete sweeps every tier rather than the requested one:
    // a narrowed delete would report success and leave the live copy in place,
    // a credential the operator believes is revoked and is not.
    await secrets.delete(key, {
      scope: resolveCredentialDeleteScope(key, flags.has('--user') ? 'user' : flags.has('--project') ? 'project' : undefined),
      medium: flags.has('--secure') ? 'secure' : flags.has('--plaintext') ? 'plaintext' : undefined,
    });
    return [
      'Secret deleted',
      `  key ${key}`,
    ].join('\n');
  }
  const [records, review] = await Promise.all([secrets.listDetailed(), secrets.inspect()]);
  const stored = records.filter((record) => record.source !== 'env');
  const value = { policy: review.policy, records: stored, warnings: review.warnings };
  return formatJsonOrText(runtime.cli)(value, [
    'GoodVibes secrets',
    `  policy ${review.policy}`,
    `  secure available ${yesNo(review.secureAvailable)}`,
    `  stored keys ${stored.length}`,
    ...stored.map((record) => `    ${record.key} (${record.source}${record.refSource ? `, ref:${record.refSource}` : ''}${record.overriddenByEnv ? ', env override' : ''})`),
    ...review.warnings.map((warning) => `  warning ${warning}`),
  ].join('\n'));
}

export async function handleSessions(runtime: CliCommandRuntime): Promise<string | null> {
  return await withRuntimeServices(runtime, (services) => {
    const binary = runtime.cli.binary;
    const [sub = 'list', ...rest] = runtime.cli.commandArgs;
    const sessions = services.sessionManager.list();
    if (sub === 'list') {
      const value = sessions;
      return formatJsonOrText(runtime.cli)(value, [
        `GoodVibes sessions (${sessions.length})`,
        ...sessions.slice(0, 50).map((session) => `  ${session.name}  messages ${session.messageCount}  ${appendTemporalLabel(new Date(session.timestamp).toISOString(), session.timestamp)}  ${session.title || '(untitled)'}`),
      ].join('\n'));
    }
    if (sub === 'show' || sub === 'info') {
      const target = rest.join(' ').trim();
      if (!target) return `Usage: ${binary} sessions show <id|name>`;
      const found = sessions.find((session) => session.name === target || session.name.startsWith(target) || session.title.toLowerCase() === target.toLowerCase());
      if (!found) return `Session not found ${target}`;
      return formatJsonOrText(runtime.cli)(found, [
        `Session ${found.name}`,
        `  title ${found.title || '(untitled)'}`,
        `  messages ${found.messageCount}`,
        `  provider/model ${found.provider}/${found.model}`,
        `  updated ${appendTemporalLabel(new Date(found.timestamp).toISOString(), found.timestamp)}`,
        `  file ${found.filePath}`,
      ].join('\n'));
    }
    if (sub === 'export') {
      const target = rest[0];
      const outputPath = rest[1];
      if (!target) return `Usage: ${binary} sessions export <id|name> [path]`;
      const found = sessions.find((session) => session.name === target || session.name.startsWith(target) || session.title.toLowerCase() === target.toLowerCase());
      if (!found) return `Session not found ${target}`;
      const data = services.sessionManager.load(found.name);
      const text = JSON.stringify({ name: found.name, ...data }, null, 2) + '\n';
      if (outputPath) {
        const targetPath = services.shellPaths.resolveWorkspacePath(outputPath);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, text, 'utf-8');
        return [
          'Session exported',
          `  path ${targetPath}`,
        ].join('\n');
      }
      return text.trimEnd();
    }
    if (sub === 'resume') {
      const target = rest.join(' ').trim();
      return target ? null : `Usage: ${binary} sessions resume <id|name>`;
    }
    return `Usage: ${binary} sessions list|show <id>|export <id> [path]|resume <id>`;
  });
}

export async function handleTasks(runtime: CliCommandRuntime): Promise<string> {
  const [sub = 'list', ...rest] = runtime.cli.commandArgs;
  if (sub === 'submit') {
    return [
      'GoodVibes Agent blocks CLI task submission from the host-owned task workflow.',
      '  policy do normal assistant work in the main Agent conversation or use `goodvibes-agent run <prompt>` for an explicit one-shot run.',
      '  build/fix/review use `goodvibes-agent delegate <task>` for explicit GoodVibes TUI handoff.',
      '  result no local task was started.',
    ].join('\n');
  }
  return await withRuntimeServices(runtime, (services) => {
    const tasks = [...services.runtimeStore.getState().tasks.tasks.values()];
    if (sub === 'list') {
      return tasks.length === 0
        ? 'GoodVibes tasks\n  No connected-host tasks are currently recorded.'
        : ['GoodVibes tasks', ...tasks.map((task) => `  ${task.id} ${task.status} ${task.kind} ${task.title}`)].join('\n');
    }
    if (sub === 'show') {
      if (!rest[0]) return `Usage: ${runtime.cli.binary} tasks show <taskId>`;
      const task = tasks.find((candidate) => candidate.id === rest[0]);
      return task ? JSON.stringify(task, null, 2) : `Unknown task ${rest[0] ?? ''}`;
    }
    return `Usage: ${runtime.cli.binary} tasks list|show <taskId>`;
  });
}

export async function renderPairing(runtime: CliCommandRuntime): Promise<string> {
  const tokenRecord = readConnectedHostOperatorToken(runtime.homeDirectory);
  if (!tokenRecord.token) return connectedHostTokenRequiredMessage(tokenRecord.path);
  const binding = resolveRuntimeEndpointBinding(runtime.configManager, 'controlPlane');
  const connectedHostUrl = `http://${urlHostForBindHost(binding.host)}:${binding.port}`;
  const info = buildCompanionConnectionInfo({
    daemonUrl: connectedHostUrl,
    token: tokenRecord.token,
    username: 'admin',
    surface: GOODVIBES_AGENT_PAIRING_SURFACE,
  });
  const payload = encodeConnectionPayload(info);
  const qr = renderQrToString(generateQrMatrix(payload));
  return [formatConnectionBlock(info, payload), '', qr].join('\n');
}
