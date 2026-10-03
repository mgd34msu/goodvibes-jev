import type { AgentWorkspaceCategory } from './agent-workspace-types.ts';

type AgentWorkspaceAction = AgentWorkspaceCategory['actions'][number];

export function settingAction(options: {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly key: string;
  readonly value?: string;
  readonly visibleWhenKey?: string;
  readonly visibleWhenValue?: string | boolean | number;
}): AgentWorkspaceAction {
  return {
    id: options.id,
    label: options.label,
    detail: options.detail,
    kind: 'setting',
    safety: 'safe',
    settingKey: options.key,
    ...(options.value !== undefined ? { settingValueHint: options.value } : {}),
    ...(options.visibleWhenKey !== undefined ? { visibleWhenSettingKey: options.visibleWhenKey } : {}),
    ...(options.visibleWhenValue !== undefined ? { visibleWhenSettingValue: options.visibleWhenValue } : {}),
  };
}
