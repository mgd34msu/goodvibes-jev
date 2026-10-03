/**
 * agent-harness-route-format.ts, the three formatters that render a model
 * route string.
 *
 * They live in their own module because both halves of what used to be one
 * agent-harness-metadata.ts need them: the command-policy table that names a
 * preferred model tool for every slash command, and the connected-host
 * capability map. Keeping one copy is what stops the two from drifting into
 * two spellings of the same route.
 */

export function agentHarnessModes(...modes: readonly string[]): string {
  return `agent_harness ${modes.map((mode) => `mode:"${mode}"`).join(', ')}`;
}

export function settingsActions(...actions: readonly string[]): string {
  return `settings ${actions.map((action) => `action:"${action}"`).join('|')}`;
}

export function hostActions(...actions: readonly string[]): string {
  return `host ${actions.map((action) => `action:"${action}"`).join('|')}`;
}
