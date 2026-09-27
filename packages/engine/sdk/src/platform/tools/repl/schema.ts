import type { ToolDefinition } from '../../types/tools.js';

export const REPL_TOOL_SCHEMA: ToolDefinition = {
  name: 'repl',
  description: 'Evaluate bounded JavaScript, TypeScript, Python, SQL, and GraphQL snippets in an isolating sandbox profile. Eval refuses while no isolating sandbox backend is available (local host execution does not isolate code); history mode lists past eval attempts.',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['eval', 'history'] },
      runtime: { type: 'string', enum: ['javascript', 'typescript', 'python', 'sql', 'graphql'] },
      expression: { type: 'string' },
      bindings: { type: 'object', additionalProperties: true },
    },
    required: ['mode'],
    additionalProperties: false,
  },
};

export interface ReplToolInput {
  readonly mode: 'eval' | 'history';
  readonly runtime?: 'javascript' | 'typescript' | 'python' | 'sql' | 'graphql' | undefined;
  readonly expression?: string | undefined;
  readonly bindings?: Record<string, unknown> | undefined;
}
