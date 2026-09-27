/**
 * tool-contract-verifier.test.ts
 *
 * The tool contract verifier: every check is code except whether a tool's
 * description explains what the tool does and when to use it, which
 * `engine.tools.description-quality` reads once per distinct description.
 * Registration gates on the code checks alone; the full verification adds the
 * reading as a warning.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Question } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { forgetDescriptionReadings, ToolContractVerifier } from '../sdk/src/platform/runtime/tools/contract-verifier.ts';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import type { Tool } from '../sdk/src/platform/types/tools.ts';

const GOOD = 'Read a file from the workspace. Use it before editing a file or to see what a file contains.';
const VAGUE = 'Helper tool.';

function tool(name: string, description: unknown, parameters: unknown = { type: 'object', properties: {} }): Tool {
  return {
    definition: { name, description, parameters },
    execute: async () => ({ success: true }),
    category: 'read',
  } as unknown as Tool;
}

/** A port that reads GOOD as explaining the tool and anything else as not. */
function descriptionPort() {
  return fakePort((_name: string, _question: Question, state: unknown) => noulAnswer(state === GOOD ? 0.95 : 0.04));
}

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  forgetDescriptionReadings();
  previous = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previous);
  forgetDescriptionReadings();
});

describe('the code checks', () => {
  test('need no judgment port and still catch schema errors', () => {
    const verifier = new ToolContractVerifier({ strictIdempotency: false });
    expect(verifier.verifyStructure(tool('read', GOOD)).passed).toBe(true);
    const missing = verifier.verifyStructure(tool('read', undefined));
    expect(missing.passed).toBe(false);
    expect(missing.violations[0]!.message).toBe("Tool 'read': missing or non-string description.");
    expect(verifier.verifyStructure(tool('read', GOOD, { type: 'tuple' })).passed).toBe(false);
  });

  test('registration gates on them without asking', () => {
    const registry = new ToolRegistry();
    const result = registry.registerWithContract(tool('read', VAGUE), { strictIdempotency: false });
    expect(result.passed).toBe(true);
    expect(registry.has('read')).toBe(true);
    expect(() => registry.registerWithContract(tool('broken', GOOD, null))).toThrow(/failed contract verification/);
  });
});

describe('the description reading', () => {
  test('a description that explains the tool adds nothing; one that does not adds a warning', async () => {
    installJudgmentPort(descriptionPort().port);
    const verifier = new ToolContractVerifier({ strictIdempotency: false });
    expect((await verifier.verify(tool('read', GOOD))).violations).toEqual([]);
    const vague = await verifier.verify(tool('helper', VAGUE));
    expect(vague.passed).toBe(true);
    expect(vague.violations).toEqual([{
      dimension: 'schema',
      severity: 'warn',
      message: "Tool 'helper': description does not clearly explain what the tool does and when to use it.",
      hint: 'Say what the tool does and in which situations the LLM should call it.',
    }]);
  });

  test('each distinct description is read once, across tools and verifications', async () => {
    const { port, requests } = descriptionPort();
    installJudgmentPort(port);
    const registry = new ToolRegistry();
    registry.register(tool('read', GOOD));
    registry.register(tool('read_again', GOOD));
    registry.register(tool('helper', VAGUE));
    const results = await registry.verifyAllContracts({ strictIdempotency: false });
    expect([...results.keys()]).toEqual(['read', 'read_again', 'helper']);
    expect(requests).toHaveLength(2);
    await registry.verifyContract('helper', { strictIdempotency: false });
    expect(requests).toHaveLength(2);
    expect(await registry.verifyContract('absent')).toBeUndefined();
  });

  test('a blank description is warned about without asking', async () => {
    const { port, requests } = descriptionPort();
    installJudgmentPort(port);
    const result = await new ToolContractVerifier({ strictIdempotency: false }).verify(tool('blank', '   '));
    expect(requests).toHaveLength(0);
    expect(result.violations.map((v) => v.severity)).toEqual(['warn']);
  });

  test('the full verification with no judgment port installed throws', async () => {
    await expect(new ToolContractVerifier().verify(tool('read', GOOD))).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });
});
