// The product supplies its conversational capture contract. Test immutable
// policy composition here; settings authority is exercised at the real tool
// boundary in products/agent/src/test/runtime/agent-settings-admission.test.ts.
// Prompt wording can evolve without reviving obsolete permission behavior.
import { describe, expect, test } from 'bun:test';
import { buildAgentOperatorPolicy, GOODVIBES_AGENT_OPERATOR_POLICY_LINES } from '../sdk/src/platform/gate/policy/operator-policy.ts';

describe('the Agent operator policy', () => {
  test.each([
    '',
    '## Conversational capture\n- capture contract line',
    '  ## Capture\n\n- Preserve exact words: “yes”\n  trailing spaces  \n',
  ])('composition preserves policy order and exact capture bytes: %j', (capture) => {
    const policy = GOODVIBES_AGENT_OPERATOR_POLICY_LINES.join('\n');
    expect(buildAgentOperatorPolicy(capture)).toBe(`${policy}\n${capture}`);
    expect(buildAgentOperatorPolicy('a different capture')).toBe(`${policy}\na different capture`);
    expect(buildAgentOperatorPolicy(capture)).toBe(`${policy}\n${capture}`);
  });

  test('callers cannot replace, remove or append shared policy lines', () => {
    const original = [...GOODVIBES_AGENT_OPERATOR_POLICY_LINES];
    expect(original.length).toBeGreaterThan(0);
    expect(Object.isFrozen(GOODVIBES_AGENT_OPERATOR_POLICY_LINES)).toBe(true);
    expect(Reflect.set(GOODVIBES_AGENT_OPERATOR_POLICY_LINES, '0', 'replacement')).toBe(false);
    expect(Reflect.deleteProperty(GOODVIBES_AGENT_OPERATOR_POLICY_LINES, '0')).toBe(false);
    expect(Reflect.defineProperty(GOODVIBES_AGENT_OPERATOR_POLICY_LINES, String(original.length), { value: 'extra' })).toBe(false);
    expect(GOODVIBES_AGENT_OPERATOR_POLICY_LINES).toEqual(original);
    expect(buildAgentOperatorPolicy('capture')).toBe([...original, 'capture'].join('\n'));
  });
});
