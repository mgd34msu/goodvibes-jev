import { assertDeliveryCurrent } from '../../utils/delivery-lifetime.js';
import { retireDeliveryResponse } from '../../integrations/delivery-diagnostics.js';
import { ArtifactStore } from '../../artifacts/index.js';
import { ConfigManager } from '../../config/manager.js';
import type { SecretsManager } from '../../config/secrets.js';
import { ServiceRegistry } from '../../config/service-registry.js';
import { resolveSecretInput } from '../../config/secret-refs.js';
import { ControlPlaneGateway } from '../../control-plane/gateway.js';
import { DiscordIntegration, HomeAssistantIntegration, NtfyIntegration, SlackIntegration } from '../../integrations/index.js';
import { postToPublicWebhook, validatePublicWebhookUrl } from '../../utils/url-safety.js';
import type { HostResolver } from '../../tools/fetch/pinned-request.js';
import { resolveReachableBaseUrl } from '../../utils/reachable-base-url.js';
import type { ChannelDeliveryStrategy } from './types.js';
import {
  appendAttachmentSummary,
  deliveryFetch,
  extractResponseId,
  firstNonEmpty,
  requireOkResponse,
  resolveDeliveryCredential,
  resolveAttachments,
  resolveChannelDeliverySurfaceKind,
  success,
  titleFromBody,
  trimForSurface,
} from './shared.js';
import { HttpStatusError } from '@goodvibes-jev/engine/errors';

export function createWebhookDeliveryStrategy(
  configManager: ConfigManager,
  artifactStore: ArtifactStore,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
  /** Resolves the target host before delivery; the system resolver when absent (utils/url-safety.ts). */
  options: { readonly resolveHost?: HostResolver | undefined } = {},
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:webhook',
    supportsGuardedDelivery: true,
    canHandle(request) {
      return request.target.kind === 'webhook' || resolveChannelDeliverySurfaceKind(request.target) === 'webhook';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager, 128 * 1024);
      const address = request.target.address
        ?? (typeof request.binding?.metadata.callbackUrl === 'string' ? request.binding.metadata.callbackUrl : undefined)
        // The default target is declared secret-bearing (it can carry its own
        // token), so it may be a secret reference.
        ?? await resolveSecretInput(configManager.get('surfaces.webhook.defaultTarget'), {
          diagnosticMode: 'structural',
          resolveLocalSecret: (key) => secretsManager.get(key),
          homeDirectory: secretsManager.getGlobalHome?.() ?? undefined,
        })
        ?? '';
      if (!address) throw new Error('Missing webhook delivery target');
      const validation = validatePublicWebhookUrl(address);
      if (!validation.ok) throw new Error(validation.error);
      const timeoutMs = Number(configManager.get('surfaces.webhook.timeoutMs') ?? 15_000);
      // Resolved, every answer checked, pinned to a checked address (utils/url-safety.ts).
      const response = await postToPublicWebhook(validation.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          text: request.body,
          message: request.body,
          title: request.title,
          jobId: request.jobId,
          runId: request.runId,
          routeId: request.binding?.id,
          attachments,
          artifacts: attachments,
        }),
      }, { ...options, assertCurrent: request.assertCurrent });
      if (!response.ok) {
        throw new HttpStatusError(`HTTP ${response.status}: ${await response.text().catch(() => '')}`, { status: response.status });
      }
      await retireDeliveryResponse(response);
      return success();
    },
  };
}

export function createSlackDeliveryStrategy(
  serviceRegistry: ServiceRegistry,
  configManager: ConfigManager,
  artifactStore: ArtifactStore,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:slack',
    supportsGuardedDelivery: true,
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'slack';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const bodyWithAttachments = appendAttachmentSummary(request.body, attachments);
      const slack = new SlackIntegration('', '');
      const responseUrl = typeof request.binding?.metadata.responseUrl === 'string'
        ? request.binding.metadata.responseUrl
        : undefined;
      if (responseUrl?.startsWith('https://hooks.slack.com/')) {
        const response = await deliveryFetch(request, responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response_type: 'in_channel',
            blocks: slack.formatAgentResult(request.agentId ?? request.runId, request.title, bodyWithAttachments),
          }),
        }, 'opaque-url');
        try { await retireDeliveryResponse(response); }
        finally {
          if (!response.ok) throw new HttpStatusError('Slack response URL rejected the request', { status: response.status });
        }
        return success();
      }
      if (request.target.address?.startsWith('https://')) {
        await slack.postWebhook(bodyWithAttachments, undefined, request.target.address, request);
        return success();
      }
      const channelId = firstNonEmpty(
        request.target.address,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.slack.defaultChannel') ?? ''),
      );
      if (channelId) {
        const botToken = await resolveDeliveryCredential(configManager, serviceRegistry, secretsManager, {
          serviceName: 'slack', serviceField: 'primary', configKey: 'surfaces.slack.botToken',
          environmentValue: process.env.SLACK_BOT_TOKEN,
        });
        await new SlackIntegration('', botToken ?? '').postMessage(channelId, bodyWithAttachments, undefined, request);
        return success(channelId);
      }
      const webhookUrl = await serviceRegistry.resolveSecret('slack', 'webhookUrl') ?? process.env.SLACK_WEBHOOK_URL;
      await new SlackIntegration(webhookUrl ?? '', '').postWebhook(bodyWithAttachments, undefined, undefined, request);
      return success();
    },
  };
}

export function createDiscordDeliveryStrategy(
  serviceRegistry: ServiceRegistry,
  configManager: ConfigManager,
  artifactStore: ArtifactStore,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:discord',
    supportsGuardedDelivery: true,
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'discord';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const bodyWithAttachments = appendAttachmentSummary(request.body, attachments);
      const discord = new DiscordIntegration('', '');
      const applicationId = typeof request.binding?.metadata.applicationId === 'string'
        ? request.binding.metadata.applicationId
        : undefined;
      const interactionToken = typeof request.binding?.metadata.interactionToken === 'string'
        ? request.binding.metadata.interactionToken
        : undefined;
      if (applicationId && interactionToken) {
        await discord.editOriginalResponse(
          applicationId,
          interactionToken,
          '',
          [discord.formatAgentResult(request.agentId ?? request.runId, request.title, bodyWithAttachments)],
          request,
        );
        return success();
      }
      if (request.target.address?.startsWith('https://')) {
        await discord.postWebhook(bodyWithAttachments, undefined, request.target.address, request);
        return success();
      }
      const channelId = firstNonEmpty(
        request.target.address,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.discord.defaultChannelId') ?? ''),
      );
      if (channelId) {
        const botToken = await resolveDeliveryCredential(configManager, serviceRegistry, secretsManager, {
          serviceName: 'discord', serviceField: 'primary', configKey: 'surfaces.discord.botToken',
          environmentValue: process.env.DISCORD_BOT_TOKEN,
        });
        await new DiscordIntegration('', botToken ?? '').postMessage(channelId, bodyWithAttachments, undefined, request);
        return success(channelId);
      }
      const webhookUrl = await serviceRegistry.resolveSecret('discord', 'webhookUrl') ?? process.env.DISCORD_WEBHOOK_URL;
      await new DiscordIntegration(webhookUrl ?? '', '').postWebhook(bodyWithAttachments, undefined, undefined, request);
      return success();
    },
  };
}

export function createNtfyDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:ntfy',
    supportsGuardedDelivery: true,
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'ntfy';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const baseUrl = String(configManager.get('surfaces.ntfy.baseUrl') ?? 'https://ntfy.sh');
      const token = await resolveDeliveryCredential(configManager, serviceRegistry, secretsManager, {
        serviceName: 'ntfy', serviceField: 'primary', configKey: 'surfaces.ntfy.token',
        environmentValue: process.env.NTFY_ACCESS_TOKEN,
      });
      const topic = firstNonEmpty(
        request.target.address,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.ntfy.topic') ?? ''),
      );
      if (!topic) throw new Error('Missing ntfy topic');
      const ntfy = new NtfyIntegration(baseUrl, token ?? undefined);
      // undefined here means nothing configured resolves to a reachable
      // address, omit the click target rather than shipping a dead link.
      const baseUrlHint = resolveReachableBaseUrl(configManager, 'off-host');
      const primaryAttachment = attachments[0]!;
      await ntfy.publish(topic, appendAttachmentSummary(request.body, attachments), {
        title: request.target.label ?? titleFromBody(request.body),
        ...(request.includeLinks && baseUrlHint ? { click: `${baseUrlHint}/api/control-plane/web` } : {}),
        ...(primaryAttachment?.contentUrl ? { attach: primaryAttachment.contentUrl } : {}),
        markGoodVibesOrigin: true,
        allowDuplicate: request.allowDuplicate === true,
        signal: request.signal,
        assertCurrent: request.assertCurrent,
      });
      return success(topic);
    },
  };
}

export function createWebControlPlaneDeliveryStrategy(
  configManager: ConfigManager,
  artifactStore: ArtifactStore,
  getGateway: () => ControlPlaneGateway | null,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:web-control-plane',
    supportsGuardedDelivery: true,
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'web';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const gateway = getGateway();
      if (!gateway) {
        throw new Error('Web control-plane gateway unavailable');
      }
      assertDeliveryCurrent(request);
      const published = gateway.publishSurfaceMessage({
        surface: 'web',
        title: request.target.label ?? request.title,
        body: request.body,
        level: request.status === 'failed' ? 'error' : request.status === 'completed' ? 'success' : 'info',
        routeId: request.binding?.id ?? request.target.routeId,
        surfaceId: request.binding?.surfaceId,
        attachments,
        metadata: {
          jobId: request.jobId,
          runId: request.runId,
          agentId: request.agentId,
        },
      });
      return success(published.id);
    },
  };
}

export function createHomeAssistantDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:homeassistant',
    supportsGuardedDelivery: true,
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'homeassistant';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager, 128 * 1024);
      const baseUrl = firstNonEmpty(
        String(configManager.get('surfaces.homeassistant.instanceUrl') ?? ''),
        serviceRegistry.get('homeassistant')?.baseUrl,
        process.env.HOMEASSISTANT_URL,
        process.env.HOME_ASSISTANT_URL,
        process.env.HA_URL,
      );
      if (!baseUrl) throw new Error('Missing Home Assistant instance URL');
      const token = firstNonEmpty(
        await serviceRegistry.resolveSecret('homeassistant', 'primary'),
        await resolveSecretInput(configManager.get('surfaces.homeassistant.accessToken'), {
          diagnosticMode: 'structural',
          resolveLocalSecret: (key) => secretsManager.get(key),
          homeDirectory: secretsManager.getGlobalHome?.() ?? undefined,
        }),
        process.env.HOMEASSISTANT_ACCESS_TOKEN,
        process.env.HOME_ASSISTANT_ACCESS_TOKEN,
        process.env.HA_ACCESS_TOKEN,
      );
      if (!token) throw new Error('Missing Home Assistant access token');
      const eventType = firstNonEmpty(
        String(configManager.get('surfaces.homeassistant.eventType') ?? ''),
        'goodvibes_message',
      )!;
      const client = new HomeAssistantIntegration({ baseUrl, accessToken: token });
      const pending = readRecord(request.metadata?.pending);
      const messageId = firstNonEmpty(
        readString(pending?.messageId),
        readString(request.binding?.metadata.messageId),
      );
      const conversationId = firstNonEmpty(
        readString(pending?.conversationId),
        readString(request.binding?.metadata.conversationId),
        request.binding?.externalId,
      );
      const result = await client.publishGoodVibesEvent(eventType, {
        type: request.status === 'failed' ? 'error' : 'message',
        title: request.target.label ?? request.title,
        body: appendAttachmentSummary(request.body, attachments),
        speechText: request.body,
        status: request.status,
        jobId: request.jobId,
        runId: request.runId,
        agentId: request.agentId,
        sessionId: request.sessionId,
        routeId: request.binding?.id,
        surfaceId: request.binding?.surfaceId,
        externalId: request.binding?.externalId,
        messageId: firstNonEmpty(readString(pending?.outboundMessageId), request.agentId ? `gv:${request.agentId}` : undefined),
        replyToMessageId: firstNonEmpty(readString(pending?.replyToMessageId), messageId),
        conversationId,
        metadata: {
          threadId: request.binding?.threadId,
          channelId: request.binding?.channelId,
          phase: readString(request.metadata?.phase),
          inboundMessageId: messageId,
          conversationId,
          attachments,
        },
      }, request);
      return success(extractResponseId(result) ?? eventType);
    },
  };
}

export function createTelegramDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:telegram',
    supportsGuardedDelivery: true,
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'telegram';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const token = await resolveDeliveryCredential(configManager, serviceRegistry, secretsManager, {
        serviceName: 'telegram', serviceField: 'primary', configKey: 'surfaces.telegram.botToken',
        environmentValue: process.env.TELEGRAM_BOT_TOKEN,
      });
      const chatId = firstNonEmpty(
        request.target.address,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.telegram.defaultChatId') ?? ''),
      );
      if (!token) throw new Error('Missing Telegram bot token');
      if (!chatId) throw new Error('Missing Telegram chat id');
      const response = await deliveryFetch(request, `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: trimForSurface(appendAttachmentSummary(request.body, attachments), 4_096),
          disable_web_page_preview: true,
          ...(request.binding?.threadId && /^\d+$/.test(request.binding.threadId)
            ? { message_thread_id: Number(request.binding.threadId) }
            : {}),
        }),
      }, 'opaque-url');
      const payload = await requireOkResponse('Telegram delivery failed', response);
      if (payload === null || typeof payload !== 'object' || !('ok' in payload) || payload.ok !== true) {
        throw new Error('Telegram did not acknowledge the send request');
      }
      return success(extractResponseId(payload));
    },
  };
}

export function createGoogleChatDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:google-chat',
    supportsGuardedDelivery: true,
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'google-chat';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const explicitTarget = request.target.address;
      if (explicitTarget !== undefined) {
        let valid = false;
        try { valid = new URL(explicitTarget).protocol === 'https:'; } catch { /* Closed protocol refusal below. */ }
        if (!valid) throw new Error('Google Chat requires an explicit HTTPS webhook target');
      }
      const webhookUrl = firstNonEmpty(explicitTarget, readString(request.binding?.metadata.webhookUrl))
        ?? await resolveDeliveryCredential(configManager, serviceRegistry, secretsManager, {
          serviceName: 'google-chat', serviceField: 'webhookUrl', configKey: 'surfaces.googleChat.webhookUrl',
          serviceDefault: () => serviceRegistry.get('google-chat')?.baseUrl,
          environmentValue: process.env.GOOGLE_CHAT_WEBHOOK_URL,
        });
      if (!webhookUrl) {
        throw new Error('Missing Google Chat webhook URL');
      }
      const threadKey = firstNonEmpty(request.binding?.threadId, request.binding?.channelId, request.binding?.externalId);
      const response = await deliveryFetch(request, webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({
          text: trimForSurface(appendAttachmentSummary(request.body, attachments), 4_000),
          ...(threadKey ? { thread: { threadKey } } : {}),
        }),
      }, 'opaque-url');
      const payload = await requireOkResponse('Google Chat delivery failed', response);
      return success(extractResponseId(payload));
    },
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
