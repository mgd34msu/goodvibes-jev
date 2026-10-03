import type { SubmissionIntent } from './submission-intent.ts';

export interface SubmissionRouterInput {
  readonly text: string;
  readonly commandMode?: boolean;
  readonly hasAttachments?: boolean;
}

const PLAN_COMMANDS = new Set(['plan']);
const DELEGATION_COMMANDS = new Set(['delegate', 'build', 'review', 'wrfc', 'agents', 'remote']);
const ORCHESTRATION_COMMANDS = new Set([
  'orchestration',
  'tasks',
  'bridge',
  'teleport',
]);

export function routeSubmissionIntent(input: SubmissionRouterInput): SubmissionIntent {
  const trimmed = input.text.trim();
  const hasAttachments = input.hasAttachments ?? false;

  if (!trimmed) {
    return {
      kind: 'empty',
      label: 'prompt',
      hasAttachments,
    };
  }

  if (trimmed.startsWith('!#')) {
    return { kind: 'memory-pin', label: 'memory pin', hasAttachments };
  }

  if (trimmed.startsWith('!')) {
    return { kind: 'shell', label: 'shell', hasAttachments };
  }

  if (input.commandMode || trimmed.startsWith('/')) {
    const commandName = trimmed.replace(/^\//, '').split(/\s+/, 1)[0] ?? '';
    if (PLAN_COMMANDS.has(commandName)) {
      return { kind: 'plan', label: 'plan', commandName, hasAttachments };
    }
    if (DELEGATION_COMMANDS.has(commandName)) {
      return { kind: 'delegation', label: 'delegation', commandName, hasAttachments };
    }
    if (ORCHESTRATION_COMMANDS.has(commandName)) {
      return { kind: 'orchestration', label: 'orchestration', commandName, hasAttachments };
    }
    return { kind: 'slash-command', label: 'command', commandName, hasAttachments };
  }

  return { kind: 'prompt', label: 'prompt', hasAttachments };
}
