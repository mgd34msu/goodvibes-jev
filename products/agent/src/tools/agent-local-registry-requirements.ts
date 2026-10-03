import type { AgentSkillRequirement } from '../agent/skill-registry.ts';

function readList(value: unknown): readonly string[] {
  if (typeof value === 'string') return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
}

export function buildAgentLocalRequirements(
  requiresEnv: unknown,
  requiresCommands: unknown,
): readonly AgentSkillRequirement[] | undefined {
  if (requiresEnv === undefined && requiresCommands === undefined) return undefined;
  return [
    ...readList(requiresEnv).map((name) => ({ kind: 'env' as const, name })),
    ...readList(requiresCommands).map((name) => ({ kind: 'command' as const, name })),
  ];
}
