import type { ChannelDeliveryRouter } from '@goodvibes-jev/engine/sdk/platform/channels';
import { lstatSync, realpathSync } from 'node:fs';
import { resolveAndValidatePath } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { ToolInputProjectionError, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { harnessCatalogInvocationAuthority } from './agent-harness-catalog-ingress.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import {
  buildAgentChannelDeliveryPreview,
  deliverAgentChannelMessage,
  formatAgentChannelDeliveryPreview,
  formatAgentChannelDeliveryResult,
} from '../agent/channel-delivery.ts';
import { agentChannelDeliveryReceiptPath, recordAgentChannelDeliveryReceipt } from '../agent/channel-delivery-receipts.ts';
import { evaluateOutwardEffect, getSessionUntrustedContentLedger } from '../trust/untrusted-content.ts';

export interface AgentChannelSendToolArgs {
  readonly message?: unknown;
  readonly title?: unknown;
  readonly channel?: unknown;
  readonly route?: unknown;
  readonly webhook?: unknown;
  readonly link?: unknown;
  readonly confirm?: unknown;
  readonly preview?: unknown;
  readonly explicitUserRequest?: unknown;
}

export interface AgentChannelSendToolOptions {
  readonly shellPaths?: Pick<ShellPathService, 'resolveUserPath'> & Partial<Pick<ShellPathService, 'homeDirectory'>>;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 'yes';
}

function failure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

function output(text: string): { readonly success: true; readonly output: string } {
  return { success: true, output: text };
}

export function createAgentChannelSendTool(
  channelDeliveryRouter: Pick<ChannelDeliveryRouter, 'deliver' | 'listStrategies'>,
  options: AgentChannelSendToolOptions = {},
): Tool {
  return {
    definition: {
      name: 'agent_channel_send',
      description: 'Preview or deliver one message through one configured Agent target. Delivery requires current recorded effect admission.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Plain-text message to deliver.',
          },
          title: {
            type: 'string',
            description: 'Optional delivery title.',
          },
          channel: {
            type: 'string',
            description: 'Optional channel target. Use exactly one target field.',
          },
          route: {
            type: 'string',
            description: 'Optional route id or route:label. Use exactly one target field.',
          },
          webhook: {
            type: 'string',
            description: 'Optional http(s) webhook URL. Use exactly one target field.',
          },
          link: {
            type: 'string',
            description: 'Optional link delivery target. Use exactly one target field.',
          },
          confirm: {
            type: 'boolean',
            description: 'Optional historical provenance; does not grant delivery authority.',
          },
          preview: {
            type: 'boolean',
            description: 'Return a read-only delivery preview without sending.',
          },
          explicitUserRequest: {
            type: 'string',
            description: 'Optional human request provenance; does not grant delivery authority.',
          },
        },
        required: ['message'],
        additionalProperties: false,
      },
      sideEffects: ['network'],
    },
    execute: async (rawArgs: Record<string, unknown>, executionOptions) => {
      const args = snapshotJudgmentInput(rawArgs) as AgentChannelSendToolArgs;
      const input = {
        message: readString(args.message) ?? '',
        ...(readString(args.title) ? { title: readString(args.title) } : {}),
        ...(readString(args.channel) ? { channel: readString(args.channel) } : {}),
        ...(readString(args.route) ? { route: readString(args.route) } : {}),
        ...(readString(args.webhook) ? { webhook: readString(args.webhook) } : {}),
        ...(readString(args.link) ? { link: readString(args.link) } : {}),
      };
      let preview: ReturnType<typeof buildAgentChannelDeliveryPreview>;
      try {
        preview = buildAgentChannelDeliveryPreview(input);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
      if (readBoolean(args.preview)) {
        return output(formatAgentChannelDeliveryPreview(preview, channelDeliveryRouter.listStrategies().length));
      }
      const ledger = getSessionUntrustedContentLedger();
      const ledgerSnapshot = () => JSON.stringify([ledger.originsThisTurn(), ledger.exposuresThisTurn(), ledger.taintSourcesThisTurn()]);
      const sources = ledgerSnapshot();
      const receiptPaths = options.shellPaths, receiptResolver = receiptPaths?.resolveUserPath, receiptHome = receiptPaths?.homeDirectory;
      const receiptPath = receiptPaths && agentChannelDeliveryReceiptPath(receiptPaths);
      const receiptRoot = receiptHome && realpathSync(receiptHome);
      const deliver = channelDeliveryRouter.deliver, listStrategies = channelDeliveryRouter.listStrategies;
      const strategies = listStrategies.call(channelDeliveryRouter).map(strategy => ({ strategy, canHandle: strategy.canHandle, deliver: strategy.deliver }));
      const assertCurrent = () => {
        executionOptions?.signal?.throwIfAborted();
        if (!harnessCatalogInvocationAuthority(rawArgs, executionOptions, 'send')) throw new ToolInputProjectionError('held');
        const current = listStrategies.call(channelDeliveryRouter);
        if (channelDeliveryRouter.deliver !== deliver || channelDeliveryRouter.listStrategies !== listStrategies
          || getSessionUntrustedContentLedger() !== ledger || ledgerSnapshot() !== sources
          || current.length !== strategies.length || strategies.some((source, index) => current[index] !== source.strategy
            || source.strategy.canHandle !== source.canHandle || source.strategy.deliver !== source.deliver)) throw new ToolInputProjectionError('held');
      };
      try { assertCurrent(); } catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
      // Delivering a channel message is an outward effect and had no
      // untrusted-content gate at all, the ledger was never consulted here, so
      // a page or a mailbox the agent had just read could dictate the text of a
      // message to a webhook, a channel or a link. `confirm:true` and
      // `explicitUserRequest` do not close that: both are set by the model, and
      // a model that has just read an injected instruction is exactly what they
      // fail against.
      //
      // Every field is enumerated, so this asks the narrow question rather than
      // the blunt one, a message the owner composed goes even when the turn has
      // read something, and only one that repeats what was read is refused.
      const outwardDecision = await evaluateOutwardEffect({
        request: {
          toolName: 'agent_channel_send',
          action: 'channel.send',
          // The target as the caller named it, not the resolved target object:
          // a refusal has to say the thing the reader typed.
          description: `sending a channel message to ${input.channel ?? input.route ?? input.webhook ?? input.link ?? 'the configured target'}`,
        },
        ledger,
        content: {
          message: input.message,
          title: input.title,
          channel: input.channel,
          route: input.route,
          webhook: input.webhook,
          link: input.link,
        },
        taintOptions: {
          signal: executionOptions?.signal,
          // Where the message GOES. A webhook URL lifted out of a page is the
          // redirect attack in its purest form, and it is short enough to pass
          // both length thresholds, so these are tested by containment.
          exactMatchFields: ['channel', 'route', 'webhook', 'link'],
        },
      });
      assertCurrent();
      if (!outwardDecision.allowed) {
        return failure(outwardDecision.reason ?? 'Outward channel delivery held.');
      }
      try {
        const result = await deliverAgentChannelMessage(channelDeliveryRouter, input, { signal: executionOptions?.signal, assertCurrent });
        const lines = [formatAgentChannelDeliveryResult(result)];
        if (options.shellPaths) {
          try {
            assertCurrent();
            if (!receiptPaths || !receiptHome || !receiptRoot || !receiptPath || options.shellPaths !== receiptPaths
              || receiptPaths.resolveUserPath !== receiptResolver || receiptPaths.homeDirectory !== receiptHome
              || realpathSync(receiptHome) !== receiptRoot || agentChannelDeliveryReceiptPath(receiptPaths) !== receiptPath) throw new ToolInputProjectionError('held');
            resolveAndValidatePath(receiptPath, receiptHome);
            if (lstatSync(receiptPath, { throwIfNoEntry: false })?.isSymbolicLink()) realpathSync(receiptPath);
            const receipt = recordAgentChannelDeliveryReceipt(receiptPaths, {
              source: 'model-tool',
              deliveryInput: input,
              result,
            });
            lines.push(`  receipt ${receipt.id}`);
          } catch (receiptError) {
            lines.push(`  receipt unavailable ${receiptError instanceof Error ? receiptError.message : String(receiptError)}`);
          }
        }
        return output(lines.join('\n'));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function registerAgentChannelSendTool(
  registry: ToolRegistry,
  channelDeliveryRouter: Pick<ChannelDeliveryRouter, 'deliver' | 'listStrategies'>,
  options: AgentChannelSendToolOptions = {},
): void {
  registry.register(createAgentChannelSendTool(channelDeliveryRouter, options));
}
