import type { WebhookNotifierSendResult } from '@goodvibes-jev/engine/sdk/platform/integrations';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';

interface AgentNotificationConfigReader {
  getCategory(category: string): unknown;
}

interface AgentNotificationSender {
  setUrls(urls: string[]): void;
  send(text: string): Promise<WebhookNotifierSendResult>;
}

export interface AgentNotifyToolArgs {
  readonly message?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 'yes';
}

function configuredWebhookUrls(configManager: AgentNotificationConfigReader): readonly string[] {
  const category = configManager.getCategory('notifications');
  if (!isRecord(category) || !Array.isArray(category.webhookUrls)) return [];
  return category.webhookUrls
    .filter((url): url is string => typeof url === 'string')
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

function preview(message: string, targetCount: number): string {
  return [
    'Agent notification preview',
    `  message ${message}`,
    `  configured targets: ${targetCount}`,
    '  policy external notification delivery requires an explicit user request and confirm:true',
  ].join('\n');
}

function formatSendResult(result: WebhookNotifierSendResult): string {
  const lines = [
    'Agent notification sent',
    `  attempted: ${result.attempted}`,
    `  delivered: ${result.delivered}`,
    `  failed: ${result.failed}`,
  ];
  result.results.slice(0, 20).forEach((delivery, index) => {
    lines.push(`  target ${index + 1} ${delivery.ok ? 'ok' : `failed${delivery.error ? ` (${delivery.error})` : ''}`}`);
  });
  if (result.results.length > 20) lines.push(`  ${result.results.length - 20} more target(s) omitted.`);
  return lines.join('\n');
}

function failure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

function output(text: string): { readonly success: true; readonly output: string } {
  return { success: true, output: text };
}

export function createAgentNotifyTool(
  configManager: AgentNotificationConfigReader,
  notifier: AgentNotificationSender,
): Tool {
  return {
    definition: {
      name: 'agent_notify',
      description: 'Send one confirmed plain-text notification.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Plain-text notification body.',
          },
          confirm: {
            type: 'boolean',
            description: 'Required true only when user requested notification.',
          },
          explicitUserRequest: {
            type: 'string',
            description: 'User request authorizing this notification.',
          },
        },
        required: ['message', 'confirm', 'explicitUserRequest'],
        additionalProperties: false,
      },
      sideEffects: ['network'],
    },
    execute: async (rawArgs: unknown) => {
      try {
        const args = rawArgs as AgentNotifyToolArgs;
        const message = readString(args.message);
        const explicitUserRequest = readString(args.explicitUserRequest);
        if (!message) return failure('message is required.');
        if (!explicitUserRequest) {
          return failure('explicitUserRequest is required so notification delivery stays tied to a direct user request.');
        }
        const urls = configuredWebhookUrls(configManager);
        if (!readBoolean(args.confirm)) {
          return failure([
            preview(message, urls.length),
            '',
            'Model tool confirmation required. Call this tool with confirm:true only when the user explicitly asked GoodVibes Agent to send this notification.',
          ].join('\n'));
        }
        if (urls.length === 0) {
          return failure('No Agent notification webhook targets are configured. Add one from the Channels workspace before sending notifications.');
        }
        notifier.setUrls([...urls]);
        return output(formatSendResult(await notifier.send(message)));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function registerAgentNotifyTool(
  registry: ToolRegistry,
  configManager: AgentNotificationConfigReader,
  notifier: AgentNotificationSender,
): void {
  registry.register(createAgentNotifyTool(configManager, notifier));
}
