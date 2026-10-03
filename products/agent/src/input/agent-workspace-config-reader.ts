import type { CommandContext } from './command-registry.ts';

export interface AgentWorkspaceConfigReader {
  get(key: string): unknown;
}

export function getAgentWorkspaceConfigReader(context: CommandContext): AgentWorkspaceConfigReader | null {
  const configManager: object = context.platform.configManager;
  const get = Reflect.get(configManager, 'get');
  if (typeof get !== 'function') return null;
  return {
    get(key: string): unknown {
      return Reflect.apply(get, configManager, [key]);
    },
  };
}
