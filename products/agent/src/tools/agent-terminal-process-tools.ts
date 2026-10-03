import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext } from '../input/command-registry.ts';
import { backgroundProcessSummary, describeBackgroundProcess, runBackgroundProcessAction } from './agent-harness-background-processes.ts';

const READ_ONLY_PROCESS_ACTIONS = new Set(['list', 'status', 'poll', 'log', 'output', 'capabilities', 'doctor', 'parity']);

interface AgentTerminalToolArgs {
  readonly command?: unknown;
  readonly background?: unknown;
  readonly cwd?: unknown;
  readonly timeoutMs?: unknown;
  readonly processClass?: unknown;
  readonly killOnTimeout?: unknown;
  readonly pty?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

interface AgentProcessToolArgs {
  readonly action?: unknown;
  readonly processAction?: unknown;
  readonly processId?: unknown;
  readonly processSessionId?: unknown;
  readonly sessionId?: unknown;
  readonly session_id?: unknown;
  readonly command?: unknown;
  readonly cwd?: unknown;
  readonly timeoutMs?: unknown;
  readonly processClass?: unknown;
  readonly killOnTimeout?: unknown;
  readonly pty?: unknown;
  readonly data?: unknown;
  readonly query?: unknown;
  readonly target?: unknown;
  readonly limit?: unknown;
  readonly includeParameters?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

function output(value: unknown): { readonly success: true; readonly output: string } {
  return {
    success: true,
    output: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  };
}

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

function readProcessAction(args: AgentProcessToolArgs): string {
  const action = readString(args.action) || readString(args.processAction);
  if (action) return action.toLowerCase();
  return readString(args.command) ? 'start' : 'list';
}

function isReadOnlyProcessAction(action: string): boolean {
  return READ_ONLY_PROCESS_ACTIONS.has(action);
}

export function createAgentTerminalTool(commandContext: CommandContext): Tool {
  return {
    definition: {
      name: 'terminal',
      description: 'Start visible tracked background shell commands. A timeout terminates ordinary commands; a long_lived process (an interactive application or a server) keeps running past it unless killOnTimeout is set true.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to start via the shared ProcessManager.' },
          background: { type: 'boolean', description: 'Must be true. Foreground shell uses exec.' },
          cwd: { type: 'string', description: 'Workspace-relative or absolute working directory.' },
          timeoutMs: { type: 'number', description: 'How long to allow before the timeout contract applies. Whether it terminates the process depends on processClass and killOnTimeout.' },
          processClass: {
            type: 'string',
            enum: ['command', 'long_lived'],
            description: 'command: an ordinary job, terminated when timeoutMs expires. long_lived: an interactive application or a server whose lifetime is the user\'s, it keeps running past timeoutMs and must be stopped explicitly. Inferred from the program name when omitted.',
          },
          killOnTimeout: { type: 'boolean', description: 'Overrides processClass: true terminates this process when timeoutMs expires, false leaves it running. Set true deliberately before a timeout may destroy something the user is using.' },
          pty: { type: 'boolean', description: 'Request PTY mode; returns unsupported until the SDK publishes a typed PTY contract.' },
          confirm: { type: 'boolean', description: 'Required true for starting a process.' },
          explicitUserRequest: { type: 'string', description: 'The user request authorizing the background command.' },
        },
        required: ['command', 'background'],
        additionalProperties: false,
      },
      sideEffects: ['exec'],
      concurrency: 'serial',
      supportsProgress: true,
      supportsStreamingOutput: true,
    },
    execute: async (args: Record<string, unknown>) => {
      const input = args as AgentTerminalToolArgs;
      if (!readBoolean(input.background)) {
        return error('terminal is the tracked-background adapter. Use exec for bounded foreground shell commands, or call terminal with background:true, confirm:true, and explicitUserRequest.');
      }
      return output(await runBackgroundProcessAction(commandContext, {
        ...input,
        processAction: 'start',
      }));
    },
  };
}

export function createAgentProcessTool(commandContext: CommandContext): Tool {
  return {
    definition: {
      name: 'process',
      description: 'List, poll, log, wait, stop tracked processes.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'poll', 'status', 'wait', 'log', 'output', 'kill', 'stop', 'cancel', 'write', 'start', 'capabilities', 'doctor', 'parity'],
            description: 'Process lifecycle action. list/poll/log are read-only; wait/kill/write/start require confirmation.',
          },
          processAction: { type: 'string', description: 'Alias for action.' },
          processId: { type: 'string', description: 'Tracked background process id.' },
          processSessionId: { type: 'string', description: 'Process session id alias.' },
          sessionId: { type: 'string', description: 'Process session id alias.' },
          session_id: { type: 'string', description: 'Process session id alias.' },
          command: { type: 'string', description: 'Shell command for action:start.' },
          cwd: { type: 'string', description: 'Working directory for action:start.' },
          timeoutMs: { type: 'number', description: 'Wait or background timeout in milliseconds.' },
          pty: { type: 'boolean', description: 'Request PTY mode; reports unsupported until a typed contract exists.' },
          data: { type: 'string', description: 'Input data for confirmed action:write when supported by the SDK.' },
          query: { type: 'string', description: 'Search text for list or process lookup.' },
          target: { type: 'string', description: 'Process lookup text.' },
          limit: { type: 'number', description: 'Maximum list rows.' },
          includeParameters: { type: 'boolean', description: 'Include full bounded command/output metadata.' },
          confirm: { type: 'boolean', description: 'Required true for wait/kill/write/start.' },
          explicitUserRequest: { type: 'string', description: 'The user request authorizing side-effecting process actions.' },
        },
        additionalProperties: false,
      },
      sideEffects: ['exec'],
      concurrency: 'serial',
      supportsProgress: true,
      supportsStreamingOutput: true,
    },
    execute: async (args: Record<string, unknown>) => {
      const input = args as AgentProcessToolArgs;
      const action = readProcessAction(input);

      if (action === 'list') return output(backgroundProcessSummary(commandContext, input));
      if (isReadOnlyProcessAction(action) && action !== 'capabilities' && action !== 'doctor' && action !== 'parity') {
        const resolved = describeBackgroundProcess(commandContext, {
          ...input,
          processAction: action,
        });
        if (resolved.status === 'found') return output(resolved.process);
        if (resolved.status === 'ambiguous') return error(`Ambiguous process ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
        return error(resolved.usage);
      }

      return output(await runBackgroundProcessAction(commandContext, {
        ...input,
        processAction: action,
      }));
    },
  };
}

export function registerAgentTerminalProcessTools(registry: ToolRegistry, commandContext: CommandContext): void {
  if (!registry.has('terminal')) registry.register(createAgentTerminalTool(commandContext));
  if (!registry.has('process')) registry.register(createAgentProcessTool(commandContext));
}
