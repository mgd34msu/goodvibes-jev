import type { WebhookNotifierSendResult } from '@goodvibes-jev/engine/sdk/platform/integrations';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { assertCurrentToolEffect, ToolInputProjectionError, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { snapshotJudgmentInput, captureStrictJudgmentJson } from '@goodvibes-jev/engine/sdk/platform/gate';
import { retainSurfaceRead, retainSurfaceMethods } from './agent-surface-effect.ts';
import { evaluateOutwardEffect, getSessionUntrustedContentLedger } from '../trust/untrusted-content.ts';
import { screenOutboundForCardMaterial, CardMaterialRefusedError } from '../agent/payments-channel-guard.ts';

interface AgentNotificationConfigReader {
  getCategory(category: string): unknown;
  getConfigurationIncarnation?(): number;
}

interface AgentNotificationSender {
  setUrls(urls: string[]): void;
  send(text: string, lifetime?: { readonly signal?: AbortSignal | undefined; readonly assertCurrent?: (() => void) | undefined }): Promise<WebhookNotifierSendResult>;
}

export interface AgentNotifyToolArgs {
  readonly message?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
  readonly preview?: unknown;
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
    '  policy external notification delivery requires current recorded effect admission',
  ].join('\n');
}

function formatSendResult(result: WebhookNotifierSendResult): string {
  const lines = [
    result.failed === 0 && result.delivered > 0 ? 'Agent notification sent' : 'Agent notification delivery incomplete',
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
      description: 'Preview or send one plain-text notification through current recorded effect admission.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Plain-text notification body.',
          },
          confirm: {
            type: 'boolean',
            description: 'Optional historical provenance; does not grant delivery authority.',
          },
          explicitUserRequest: {
            type: 'string',
            description: 'Optional request provenance; does not grant delivery authority.',
          },
          preview: { type: 'boolean', description: 'Return a read-only preview without sending.' },
        },
        required: ['message'],
        additionalProperties: false,
      },
      sideEffects: ['network'],
    },
    execute: async (rawArgs, executionOptions) => {
      try {
        const args = captureStrictJudgmentJson(rawArgs); snapshotJudgmentInput(args);
        const message = readString(args.message);
        if (!message) return failure('message is required.');
        const urls = configuredWebhookUrls(configManager);
        if (readBoolean(args.preview)) return output(preview(message, urls.length));
        if (urls.length === 0) {
          return failure('No Agent notification webhook targets are configured. Add one from the Channels workspace before sending notifications.');
        }
        const getCategory = configManager.getCategory;
        const getIncarnation = configManager.getConfigurationIncarnation;
        const configCurrent = retainSurfaceRead(configManager,
          getIncarnation ? ['getCategory', 'getConfigurationIncarnation'] : ['getCategory'],
          () => ({ category: getCategory.call(configManager, 'notifications'), incarnation: getIncarnation?.call(configManager) ?? null }));
        const notifierCurrent = retainSurfaceMethods(notifier, ['setUrls', 'send']);
        const ledger = getSessionUntrustedContentLedger();
        const ledgerMethods = retainSurfaceMethods(ledger, ['getPublicationRevision', 'originsThisTurn', 'exposuresThisTurn', 'taintSourcesThisTurn']);
        const ledgerCurrent = () => JSON.stringify([ledger.getPublicationRevision(), ledger.originsThisTurn(), ledger.exposuresThisTurn(), ledger.taintSourcesThisTurn()]);
        const sources = ledgerCurrent();
        const assertCurrent = () => {
          executionOptions?.signal?.throwIfAborted();
          if (!assertCurrentToolEffect(rawArgs, executionOptions, 'send')) throw new ToolInputProjectionError('held');
          configCurrent(); notifierCurrent(); ledgerMethods();
          if (getSessionUntrustedContentLedger() !== ledger || ledgerCurrent() !== sources) throw new ToolInputProjectionError('stale');
        };
        assertCurrent();
        const outward = await evaluateOutwardEffect({ request: { toolName: 'agent_notify', action: 'notification.send', description: 'sending the configured notification' },
          ledger, content: { message }, taintOptions: { signal: executionOptions?.signal } });
        assertCurrent();
        if (!outward.allowed) return failure(outward.reason ?? 'Notification content was refused.');
        const card = await screenOutboundForCardMaterial({ surface: 'webhook', message }, { signal: executionOptions?.signal, assertCurrent });
        assertCurrent(); if (card) throw new CardMaterialRefusedError(card);
        notifier.setUrls([...urls]);
        assertCurrent();
        const result = await notifier.send(message, { signal: executionOptions?.signal, assertCurrent });
        try { assertCurrent(); } catch {
          return failure(`Notification delivery settled with ${result.delivered} delivered and ${result.failed} failed before its owner changed. No delivery was retried.`);
        }
        if (result.failed > 0 || result.delivered === 0) return failure(formatSendResult(result));
        return output(formatSendResult(result));
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
