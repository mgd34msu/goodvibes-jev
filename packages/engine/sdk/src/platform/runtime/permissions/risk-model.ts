/**
 * Risk families: the closed set the approval brief, the checklists
 * (risk-language.ts) and the accept-edits preset are keyed by. Which family a
 * call belongs to is Jev's reading (gate/batteries/risk-family.ts), carried on
 * the request analysis as `riskFamily`; this module only names the families
 * and turns an analysis into the descriptor the brief renders.
 *
 * The old classifyPermissionRiskFamily regex and substring cascade is gone.
 */
import type { PermissionRequestAnalysis, PermissionRiskLevel } from '../../permissions/types.js';
import type { GateRiskFamily } from '../../gate/batteries/risk-family.js';

export type PermissionRiskFamily = GateRiskFamily;

export interface PermissionRiskDescriptor {
  readonly family: PermissionRiskFamily;
  readonly level: PermissionRiskLevel;
  readonly headline: string;
}

/** The headline each family shows on the approval card. */
export const RISK_HEADLINES: Readonly<Record<PermissionRiskFamily, string>> = {
  delegation: 'Agent delegation',
  'shell-read': 'Read-only shell command',
  'shell-mutation': 'Shell command with side effects',
  'shell-destructive': 'Destructive shell command',
  'dependency-install': 'Dependency install',
  'file-mutation': 'File mutation',
  'config-mutation': 'Configuration mutation',
  'notebook-edit': 'Notebook edit',
  'network-egress': 'External network access',
  'remote-dispatch': 'Remote dispatch',
  'agent-spawn': 'Agent spawn',
  'sandbox-policy-change': 'Sandbox policy change',
  'mcp-escalation': 'MCP trust escalation',
  'plugin-lifecycle': 'Plugin or ecosystem lifecycle change',
  'hook-execution': 'Hook execution',
  generic: 'Tool call',
};

/**
 * The descriptor for an analysis: the family Jev read, or `generic` for a
 * request that was never read (a sandbox escalation or an exec prompt, which
 * carry their own classification).
 */
export function riskDescriptorFor(analysis: PermissionRequestAnalysis): PermissionRiskDescriptor {
  const family = analysis.riskFamily ?? 'generic';
  return {
    family,
    level: analysis.riskLevel,
    headline: family === 'generic' ? analysis.summary : RISK_HEADLINES[family],
  };
}
