/**
 * Host-neutral system-message routing policy helpers.
 *
 * These helpers decide message kind, default targets, and delivery shape.
 * Actual wiring into conversations, panels, or other host surfaces stays
 * outside the SDK.
 */

import { readSystemMessagePriority } from './batteries/system-message-priority.js';

export type SystemMessagePriorityLevel = 'high' | 'low';
/**
 * 'contract' is the review workflow's status stream: the contract runner's
 * `[Contract]` messages, and the `[WRFC]` messages the contract runner
 * replaces (contract-runner.md section 8.2).
 */
export type SystemMessageKind = 'system' | 'operational' | 'contract';
export type SystemMessageTarget = 'conversation' | 'panel' | 'both';

/**
 * Whether the operator needs to see a system message now. Read by Jev
 * (engine.runtime.system-message-priority); a weak reading is 'low'.
 */
export function classifySystemMessagePriority(message: string): Promise<SystemMessagePriorityLevel> {
  return readSystemMessagePriority(message, 'runtime.system-message-policy.priority');
}

export function defaultSystemMessageTarget(kind: SystemMessageKind): SystemMessageTarget {
  if (kind === 'contract') return 'both';
  return 'panel';
}

/**
 * The kind of every leading bracket tag hosts give system messages, keyed by
 * the tag name in lower case (tags match case-insensitively). A message with
 * no leading tag, or a tag not listed, is 'system'.
 */
export const SYSTEM_MESSAGE_TAG_KINDS: Readonly<Record<string, Exclude<SystemMessageKind, 'system'>>> = {
  contract: 'contract',
  wrfc: 'contract',
  scan: 'operational',
  local: 'operational',
  agents: 'operational',
  mcp: 'operational',
  plugin: 'operational',
  hook: 'operational',
  tool: 'operational',
  exec: 'operational',
  remote: 'operational',
  bridge: 'operational',
  approval: 'operational',
};

/** The name inside a message's leading `[Tag]`, or undefined when it has none. */
function leadingTag(message: string): string | undefined {
  if (!message.startsWith('[')) return undefined;
  const end = message.indexOf(']');
  return end > 1 ? message.slice(1, end) : undefined;
}

export function classifySystemMessageKind(message: string): SystemMessageKind {
  const tag = leadingTag(message)?.toLowerCase();
  if (tag === undefined || !Object.hasOwn(SYSTEM_MESSAGE_TAG_KINDS, tag)) return 'system';
  return SYSTEM_MESSAGE_TAG_KINDS[tag]!;
}

export function resolveSystemMessageDelivery(
  target: SystemMessageTarget,
  hasPanel: boolean,
): { readonly toPanel: boolean; readonly toConversation: boolean } {
  if (target === 'both') {
    return { toPanel: hasPanel, toConversation: true };
  }
  if (target === 'conversation') {
    return { toPanel: false, toConversation: true };
  }
  return hasPanel
    ? { toPanel: true, toConversation: false }
    : { toPanel: false, toConversation: true };
}
