import { beginOpenAICodexLogin, exchangeOpenAICodexCode, getSubscriptionProviderConfig } from '@goodvibes-jev/engine/sdk/platform/config';
import type { OAuthProviderConfig, ProviderSubscription } from '@goodvibes-jev/engine/sdk/platform/config';
import { openExternalUrl } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { CommandContext } from './command-registry.ts';
import { isAffirmative } from './agent-workspace-editors.ts';
import { buildAgentWorkspaceRuntimeSnapshot } from './agent-workspace-snapshot.ts';
import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor, AgentWorkspaceRuntimeSnapshot } from './agent-workspace-types.ts';

export interface AgentWorkspaceSubscriptionEditorHost {
  localEditor: AgentWorkspaceLocalEditor | null;
  runtimeSnapshot: AgentWorkspaceRuntimeSnapshot | null;
  status: string;
  lastActionResult: AgentWorkspaceActionResult | null;
  clampSelection(): void;
  /**
   * Called after a successful sign-in so the host can refresh onboarding state
   * and navigate to the next onboarding step (e.g. account-model). Optional,
   * only available when running in ONBOARDING mode.
   */
  onSubscriptionLoginSuccess?(): void;
}

export type AgentWorkspaceSubscriptionFieldReader = (id: string) => string;

export async function submitAgentWorkspaceSubscriptionLoginStartEditor(
  host: AgentWorkspaceSubscriptionEditorHost,
  editor: AgentWorkspaceLocalEditor,
  context: CommandContext | null,
  readField: AgentWorkspaceSubscriptionFieldReader,
): Promise<void> {
  if (!isAffirmative(readField('confirm'))) {
    host.localEditor = { ...editor, message: 'Subscription login start not confirmed. Type yes, then press Enter.' };
    host.status = 'Subscription login start not confirmed.';
    return;
  }
  try {
    const provider = readField('provider') || 'openai';
    const openBrowser = isAffirmative(readField('openBrowser'));
    const { manager, services } = subscriptionServices(context);
    const resolved = getSubscriptionProviderConfig(provider, services.get(provider));
    if (!resolved) {
      throw new Error(`OAuth is not configured for ${provider}. Add an OAuth provider service or choose a built-in subscription provider.`);
    }

    const started = provider === 'openai' && resolved.source === 'builtin'
      ? await beginOpenAICodexLogin()
      : null;
    const authorizationUrl = started
      ? started.authorizationUrl
      : (await manager.beginOAuthLogin(provider, resolveManualLoginConfig(resolved.oauth))).authorizationUrl;

    if (started) {
      manager.savePending({
        provider,
        state: started.state,
        verifier: started.verifier,
        redirectUri: started.redirectUri,
        createdAt: Date.now(),
      });
    }

    const browserOpened = openBrowser ? await openExternalUrl(authorizationUrl) : false;
    host.localEditor = null;
    host.runtimeSnapshot = context ? buildAgentWorkspaceRuntimeSnapshot(context) : host.runtimeSnapshot;
    host.status = `Subscription login started for ${provider}.`;
    host.lastActionResult = {
      kind: 'refreshed',
      title: 'Subscription login started',
      detail: [
        `Provider: ${provider}.`,
        `Browser: ${openBrowser ? (browserOpened ? 'opened' : 'open failed') : 'skipped'}.`,
        'Use Finish subscription login with the callback code or redirect URL.',
        `Authorization URL: ${authorizationUrl}`,
      ].join(' '),
      safety: 'safe',
    };
    host.clampSelection();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    host.localEditor = { ...editor, message: detail };
    host.status = detail;
    host.lastActionResult = { kind: 'error', title: 'Subscription login start failed', detail, safety: 'safe' };
  }
}

export async function submitAgentWorkspaceSubscriptionLoginFinishEditor(
  host: AgentWorkspaceSubscriptionEditorHost,
  editor: AgentWorkspaceLocalEditor,
  context: CommandContext | null,
  readField: AgentWorkspaceSubscriptionFieldReader,
): Promise<void> {
  if (!isAffirmative(readField('confirm'))) {
    host.localEditor = { ...editor, message: 'Subscription login finish not confirmed. Type yes, then press Enter.' };
    host.status = 'Subscription login finish not confirmed.';
    return;
  }
  try {
    const provider = readField('provider') || 'openai';
    const codeInput = readField('code');
    const code = extractAuthorizationCode(codeInput) ?? codeInput;
    const { manager, services } = subscriptionServices(context);
    const resolved = getSubscriptionProviderConfig(provider, services.get(provider));
    if (!resolved) {
      throw new Error(`OAuth is not configured for ${provider}. Start with a configured or built-in subscription provider.`);
    }

    const record = provider === 'openai' && resolved.source === 'builtin'
      ? (() => {
        const pending = manager.getPending(provider);
        if (!pending) throw new Error(`No pending OAuth login for ${provider}. Start subscription login first.`);
        return exchangeOpenAICodexCode(code, pending.verifier).then((token) => {
          const now = Date.now();
          return manager.saveSubscription({
            provider,
            accessToken: token.accessToken,
            tokenType: token.tokenType,
            ...(typeof token.refreshToken === 'string' && token.refreshToken.length > 0
              ? { refreshToken: token.refreshToken }
              : {}),
            ...(typeof token.expiresAt === 'number' && Number.isFinite(token.expiresAt)
              ? { expiresAt: token.expiresAt }
              : {}),
            ...(token.scopes ? { scopes: token.scopes } : {}),
            authMode: 'oauth',
            overrideAmbientApiKeys: false,
            createdAt: manager.get(provider)?.createdAt ?? now,
            updatedAt: now,
          });
        });
      })()
      : manager.completeOAuthLogin(provider, resolveManualLoginConfig(resolved.oauth), code);

    const saved = await record;
    host.localEditor = null;
    host.runtimeSnapshot = context ? buildAgentWorkspaceRuntimeSnapshot(context) : host.runtimeSnapshot;
    host.status = `Subscription session saved for ${provider}.`;
    host.lastActionResult = {
      kind: 'refreshed',
      title: 'Subscription session saved',
      detail: [
        `Provider: ${provider}.`,
        `Token type: ${saved.tokenType}.`,
        `Expires: ${saved.expiresAt ? new Date(saved.expiresAt).toISOString() : 'n/a'}.`,
        describeSubscriptionPrecedence(saved),
      ].join(' '),
      safety: 'safe',
    };
    host.clampSelection();
    host.onSubscriptionLoginSuccess?.();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    host.localEditor = { ...editor, message: detail };
    host.status = detail;
    host.lastActionResult = { kind: 'error', title: 'Subscription login finish failed', detail, safety: 'safe' };
  }
}

export function submitAgentWorkspaceSubscriptionLogoutEditor(
  host: AgentWorkspaceSubscriptionEditorHost,
  editor: AgentWorkspaceLocalEditor,
  context: CommandContext | null,
  readField: AgentWorkspaceSubscriptionFieldReader,
): void {
  if (!isAffirmative(readField('confirm'))) {
    host.localEditor = { ...editor, message: 'Subscription logout not confirmed. Type yes, then press Enter.' };
    host.status = 'Subscription logout not confirmed.';
    return;
  }
  try {
    const provider = readField('provider') || 'openai';
    const { manager } = subscriptionServices(context);
    const removed = manager.logout(provider);
    host.localEditor = null;
    host.runtimeSnapshot = context ? buildAgentWorkspaceRuntimeSnapshot(context) : host.runtimeSnapshot;
    host.status = removed ? `Logged out of ${provider}.` : `No subscription session existed for ${provider}.`;
    host.lastActionResult = {
      kind: removed ? 'refreshed' : 'guidance',
      title: removed ? 'Subscription session removed' : 'No subscription session found',
      detail: removed
        ? `Removed active or pending subscription state for ${provider}. Ambient API key resolution applies if configured.`
        : `No active or pending subscription state existed for ${provider}.`,
      safety: 'safe',
    };
    host.clampSelection();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    host.localEditor = { ...editor, message: detail };
    host.status = detail;
    host.lastActionResult = { kind: 'error', title: 'Subscription logout failed', detail, safety: 'safe' };
  }
}

function subscriptionServices(context: CommandContext | null) {
  const manager = context?.platform.subscriptionManager;
  const services = context?.platform.serviceRegistry;
  if (!manager || !services) throw new Error('Subscription services are unavailable in this runtime.');
  return { manager, services };
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

function describeSubscriptionPrecedence(record: Pick<ProviderSubscription, 'overrideAmbientApiKeys'>): string {
  return record.overrideAmbientApiKeys
    ? 'Subscription routing now overrides ambient API keys for this provider.'
    : 'Subscription session is stored for subscription-backed flows; ambient API keys are unchanged.';
}
