/**
 * `engine.runtime.system-message-priority`: whether a system message is high
 * priority (the operator should see it now) or low priority (routine status).
 * One choice per message, read by system-message-policy.ts.
 *
 * Band: low stakes. Priority only decides how prominently a host shows the
 * message; the message is delivered either way.
 */
import { defineBattery, oneOf, STAKES_BANDS, type ChoiceReading } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';

const PRIORITY_OPTIONS = {
  high: 'It changes what the session is running on or holding, or reports that something broke: an error, failure, crash or unhandled exception; a failed recovery or restore; the model or provider switched, fallen back or not found; the session saved, loaded or restored; the conversation context compacted',
  low: 'Routine background status that changes nothing the operator relies on: servers or tools discovered, limits found, progress and counts, a plan parsed, work that completed normally, a title set',
} as const;

export type SystemMessagePriorityOption = keyof typeof PRIORITY_OPTIONS;

export const systemMessagePriority = defineBattery({
  name: 'engine.runtime.system-message-priority',
  version: 1,
  description: 'Whether a system message needs the operator\'s attention now (high) or is routine status (low).',
  accuracyFloor: 0.9,
  items: {
    priority: oneOf('Should the operator see this system message right away (high) or can it wait in the background (low)?', PRIORITY_OPTIONS, STAKES_BANDS.low.confidence),
  },
  fixtures: [
    {
      name: 'model exhausted and falling back',
      state: '[Model] coder-large exhausted across all providers. Automatically falling back to coder-small via local-lan.',
      expect: { priority: 'high' },
    },
    { name: 'unknown model', state: '[Model] Unknown model: coder-xl', expect: { priority: 'high' } },
    { name: 'provider switch', state: '[Provider] switch to local-lan (3 models)', expect: { priority: 'high' } },
    { name: 'session saved', state: '[Session] Saved session abc123', expect: { priority: 'high' } },
    { name: 'session restored', state: '[Recovery] Session restored successfully', expect: { priority: 'high' } },
    { name: 'restore failed', state: '[Recovery] Failed to restore: disk error', expect: { priority: 'high' } },
    { name: 'context compacted', state: '[Compaction] Compacted context: 142k -> 38k tokens', expect: { priority: 'high' } },
    {
      name: 'unhandled exception',
      state: 'Unhandled exception in tool runner: TypeError: Cannot read properties of undefined (reading \'path\')',
      expect: { priority: 'high' },
    },
    {
      name: 'agent process crashed',
      state: '[Agents] ✗ engineer 4f2a9c1d: "Add export command" failed in 42s: agent process crashed (exit code 139)',
      expect: { priority: 'high' },
    },
    { name: 'server found', state: '[Scan] Found llama-server at 192.168.1.20:8080 (3 models)', expect: { priority: 'low' } },
    { name: 'context window found', state: '[Scan] coder-small: context 32768 tokens', expect: { priority: 'low' } },
    {
      name: 'plan parsed',
      state: '[Plan] Parsed 5 item(s) from your plan. Spawn agents for the items with no blockers to begin execution.',
      expect: { priority: 'low' },
    },
    {
      name: 'agent completed',
      state: '[Agents] ✓ engineer 4f2a9c1d: "Add export command" completed in 42s (17 tool calls)',
      expect: { priority: 'low' },
    },
    { name: 'session auto-titled', state: '[Session] Auto-titled: "Fix login redirect"', expect: { priority: 'low' } },
    { name: 'mcp server discovered', state: '[MCP] Discovered server filesystem in ~/.config/goodvibes/mcp.json', expect: { priority: 'low' } },
  ],
});

/**
 * The priority a system message reads as. 'high' only when the reading is
 * strong enough to act on; a weak reading leaves the message at the routine
 * level. `site` names the decision site for the decision log.
 */
export async function readSystemMessagePriority(message: string, site: string): Promise<SystemMessagePriorityOption> {
  const run = await systemMessagePriority.run(judgmentPort(site), message, { site });
  const reading: ChoiceReading<SystemMessagePriorityOption> = run.readings.priority;
  return reading.outcome === 'act' ? reading.choice : 'low';
}
