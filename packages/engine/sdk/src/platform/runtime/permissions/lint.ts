import { mapLimit } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { policyBreadth } from '../../gate/batteries/policy-breadth.js';
import type { PermissionsConfig, PolicyRule } from './types.js';

export type PolicyLintSeverity = 'info' | 'warn' | 'error';

export interface PolicyLintFinding {
  severity: PolicyLintSeverity;
  ruleId?: string | undefined;
  message: string;
}

function toArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

/** Patterns read at once. */
const BREADTH_CONCURRENCY = 8;
const BREADTH_SITE = 'engine.gate.policy-lint';

/**
 * Whether a path or host pattern grants a broader area than a scoped rule
 * should: a Jev reading (`engine.gate.policy-breadth`). A pattern is broad
 * unless the reading is a no that acts, so a doubtful one is shown to the
 * owner. A JudgmentError propagates.
 */
async function isBroadPattern(kind: 'path' | 'host', pattern: string, effect: string): Promise<boolean> {
  const item = kind === 'path' ? 'broad_path' : 'broad_host';
  const run = await policyBreadth.run(judgmentPort(BREADTH_SITE), { kind, pattern, effect }, { site: BREADTH_SITE, only: [item] });
  const reading = run.readings[item]!;
  const broad = !(reading.verdict === 'no' && reading.outcome === 'act');
  run.recordAction(broad ? 'flagged' : 'scoped');
  return broad;
}

async function anyBroad(kind: 'path' | 'host', patterns: readonly string[], effect: string): Promise<boolean> {
  return (await mapLimit(patterns, BREADTH_CONCURRENCY, (pattern) => isBroadPattern(kind, pattern, effect))).some(Boolean);
}

async function lintRule(rule: PolicyRule): Promise<PolicyLintFinding[]> {
  const findings: PolicyLintFinding[] = [];

  if (rule.type === 'path-scope') {
    if (await anyBroad('path', rule.pathPatterns, rule.effect)) {
      findings.push({
        severity: rule.effect === 'allow' ? 'error' : 'warn',
        ruleId: rule.id,
        message: `Path scope rule '${rule.id}' uses an overly broad path pattern.`,
      });
    }
  }

  if (rule.type === 'network-scope') {
    if (await anyBroad('host', rule.hostPatterns, rule.effect)) {
      findings.push({
        severity: rule.effect === 'allow' ? 'error' : 'warn',
        ruleId: rule.id,
        message: `Network scope rule '${rule.id}' uses an overly broad host pattern.`,
      });
    }
  }

  if (rule.type === 'mode-constraint') {
    if (rule.activeModes.includes('allow-all') && rule.effect === 'allow') {
      findings.push({
        severity: 'warn',
        ruleId: rule.id,
        message: `Mode constraint rule '${rule.id}' redundantly allows actions in allow-all mode.`,
      });
    }
  }

  // `*` is the evaluator's own wildcard for every tool (rules/prefix.ts), so
  // an allow on it with no command prefix allows everything: code.
  if (rule.type === 'prefix' && rule.effect === 'allow' && toArray(rule.toolPattern).includes('*') && !rule.commandPrefixes?.length) {
    findings.push({
      severity: 'error',
      ruleId: rule.id,
      message: `Prefix rule '${rule.id}' allows every tool without a command prefix constraint.`,
    });
  }

  return findings;
}

export async function lintPolicyConfig(config: PermissionsConfig): Promise<PolicyLintFinding[]> {
  const findings: PolicyLintFinding[] = [];
  const rules = config.rules ?? [];
  const seenIds = new Set<string>();

  for (const rule of rules) {
    if (seenIds.has(rule.id)) {
      findings.push({
        severity: 'error',
        ruleId: rule.id,
        message: `Duplicate policy rule id '${rule.id}'.`,
      });
    } else {
      seenIds.add(rule.id);
    }
    findings.push(...(await lintRule(rule)));
  }

  if (config.mode === 'allow-all' && rules.length > 0) {
    findings.push({
      severity: 'warn',
      message: 'Policy rules are loaded while allow-all mode is active; runtime evaluation will still short-circuit to allow-all.',
    });
  }

  return findings;
}
