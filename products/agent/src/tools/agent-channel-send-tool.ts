import type { ChannelDeliveryRouter } from '@goodvibes-jev/engine/sdk/platform/channels';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ShellPathService } from '@/runtime/index.ts';
import {
  buildAgentChannelDeliveryPreview,
  deliverAgentChannelMessage,
  formatAgentChannelDeliveryPreview,
  formatAgentChannelDeliveryResult,
} from '../agent/channel-delivery.ts';
import { recordAgentChannelDeliveryReceipt } from '../agent/channel-delivery-receipts.ts';
import { evaluateOutwardEffect, getSessionUntrustedContentLedger } from '../trust/untrusted-content.ts';

export interface AgentChannelSendToolArgs {
  readonly message?: unknown;
  readonly title?: unknown;
  readonly channel?: unknown;
  readonly route?: unknown;
  readonly webhook?: unknown;
  readonly link?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

export interface AgentChannelSendToolOptions {
  readonly shellPaths?: Pick<ShellPathService, 'resolveUserPath'>;
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
      description: 'Send one confirmed message through one configured Agent target.',
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
            description: 'Required true for confirmed delivery.',
          },
          explicitUserRequest: {
            type: 'string',
            description: 'User request authorizing this delivery.',
          },
        },
        required: ['message', 'confirm', 'explicitUserRequest'],
        additionalProperties: false,
      },
      sideEffects: ['network'],
    },
    execute: async (rawArgs: Record<string, unknown>) => {
      const args = rawArgs as AgentChannelSendToolArgs;
      const explicitUserRequest = readString(args.explicitUserRequest);
      if (!explicitUserRequest) {
        return failure('explicitUserRequest is required so channel delivery stays tied to a direct user request.');
      }
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
      if (!readBoolean(args.confirm)) {
        return failure([
          formatAgentChannelDeliveryPreview(preview, channelDeliveryRouter.listStrategies().length),
          '',
          'Model tool confirmation required. Call this tool with confirm:true only when the user explicitly asked GoodVibes Agent to send this channel message.',
        ].join('\n'));
      }
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
        ledger: getSessionUntrustedContentLedger(),
        content: {
          message: input.message,
          title: input.title,
          channel: input.channel,
          route: input.route,
          webhook: input.webhook,
          link: input.link,
        },
        taintOptions: {
          // Where the message GOES. A webhook URL lifted out of a page is the
          // redirect attack in its purest form, and it is short enough to pass
          // both length thresholds, so these are tested by containment.
          exactMatchFields: ['channel', 'route', 'webhook', 'link'],
        },
        requestedBy: 'owner-direct',
      });
      if (!outwardDecision.allowed) {
        return failure(`${outwardDecision.reason ?? 'Refused.'} ${outwardDecision.fix ?? ''}`.trim());
      }
      try {
        const result = await deliverAgentChannelMessage(channelDeliveryRouter, input);
        const lines = [formatAgentChannelDeliveryResult(result)];
        if (options.shellPaths) {
          try {
            const receipt = recordAgentChannelDeliveryReceipt(options.shellPaths, {
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
