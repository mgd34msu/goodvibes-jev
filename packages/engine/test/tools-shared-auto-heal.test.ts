import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ToolLLM } from '@goodvibes-jev/engine/sdk/platform/config';
import { AutoHealer } from '@goodvibes-jev/engine/sdk/platform/tools';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { useToolReadings } from './_helpers/tool-readings.ts';

/** Repairs the heal-acceptance reading accepts; any other change reads as not fixing the errors. */
const readings = useToolReadings([
  ["return 'world'; }", { fixesErrors: true, onlyTheFix: true }],
  ['+fixed content', { fixesErrors: true, onlyTheFix: true }],
  ['+export const extra = 1;', { fixesErrors: true, onlyTheFix: false }],
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TS = `export function hello(): string {
  return 'world';
}\n`;

const INVALID_TS = `export function hello(): string {
  return 'world'
  // missing brace`;

function makeHealer(autoHeal: boolean, chatImpl: (prompt: string, opts?: { maxTokens?: number; systemPrompt?: string }) => Promise<string> = async () => '') {
  const configManager: Pick<ConfigManager, 'get'> = {
    get: ((key: string) => {
      if (key === 'tools.autoHeal') return autoHeal;
      return undefined;
    }) as ConfigManager['get'],
  };
  const toolLLM: Pick<ToolLLM, 'chat'> = {
    chat: chatImpl,
  };
  return new AutoHealer(configManager, toolLLM);
}

/** Patch Bun.which to return null (disable formatter/linter detection). */
function disableWhich(): () => void {
  const original = Bun.which.bind(Bun);
  (Bun as unknown as Record<string, unknown>).which = () => null;
  return () => { (Bun as unknown as Record<string, unknown>).which = original; };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AutoHealer: config gate', () => {
  test('returns healed=false when tools.autoHeal is false', async () => {
    const healer = makeHealer(false);
    const result = await healer.heal('test.ts', VALID_TS, ['some error']);
    expect(result.healed).toBe(false);
    expect(result.content).toBe(VALID_TS);
    expect(result.method).toBeUndefined();
  });

  test('preserves original content when disabled', async () => {
    const healer = makeHealer(false);
    const result = await healer.heal('test.ts', 'some content', ['error1', 'error2']);
    expect(result.healed).toBe(false);
    expect(result.content).toBe('some content');
  });
});

describe('AutoHealer: no errors passthrough', () => {
  test('returns healed=false when errors array is empty', async () => {
    const healer = makeHealer(true);
    const result = await healer.heal('test.ts', VALID_TS, []);
    expect(result.healed).toBe(false);
    expect(result.content).toBe(VALID_TS);
  });
});

describe('AutoHealer: LLM stage (no formatter/linter)', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = disableWhich();
  });

  afterEach(() => {
    restore();
  });

  test('returns healed=false when LLM returns empty string', async () => {
    const healer = makeHealer(true, async () => '');
    const result = await healer.heal('test.ts', INVALID_TS, ['SyntaxError']);
    expect(result.healed).toBe(false);
    expect(result.content).toBe(INVALID_TS);
  });

  test('returns healed=true with method=llm when the reading accepts the rewrite', async () => {
    const fixedContent = 'export function hello(): string { return \'world\'; }\n';
    const healer = makeHealer(true, async () => fixedContent);
    const result = await healer.heal('test.ts', INVALID_TS, ['Unexpected end of input']);
    expect(result.healed).toBe(true);
    expect(result.content).toBe(fixedContent);
    expect(result.method).toBe('llm');
    expect(readings.requests).toHaveLength(1);
    expect(Object.keys(readings.requests[0]?.questions ?? {})).toEqual(['fixes_errors', 'only_the_fix']);
    const state = readings.requests[0]!.state as { file: string; errors: string[]; change: string };
    expect(state.errors).toEqual(['Unexpected end of input']);
    expect(state.change).toContain("-  // missing brace");
  });

  test('a rewrite that parses but changes more than the fix is not accepted', async () => {
    const healer = makeHealer(true, async () => `${VALID_TS}export const extra = 1;\n`);
    const result = await healer.heal('test.ts', INVALID_TS, ['Unexpected end of input']);
    expect(result.healed).toBe(false);
    expect(result.content).toBe(INVALID_TS);
    expect(result.warnings?.join('\n')).toContain('not accepted');
  });

  test('a JavaScript or TypeScript rewrite that does not parse is not asked about', async () => {
    const healer = makeHealer(true, async () => 'export function hello( {');
    const result = await healer.heal('test.ts', INVALID_TS, ['Unexpected end of input']);
    expect(result.healed).toBe(false);
    expect(readings.requests).toHaveLength(0);
  });

  test('a JudgmentError propagates instead of being reported as a failed stage', async () => {
    const previous = installJudgmentPort({
      model: 'jev-test',
      ask: async () => { throw new JudgmentError('unavailable', 'overloaded'); },
    });
    try {
      const healer = makeHealer(true, async () => 'fixed content');
      await expect(healer.heal('notes.txt', 'broken content', ['Error: invalid'])).rejects.toBeInstanceOf(JudgmentError);
    } finally {
      installJudgmentPort(previous);
    }
  });

  test('returns healed=true with method=llm for non-ts files when the reading accepts it', async () => {
    const fixedContent = 'fixed content';
    const healer = makeHealer(true, async () => fixedContent);
    const result = await healer.heal('test.txt', 'broken content', ['Error: invalid']);
    expect(result.healed).toBe(true);
    expect(result.content).toBe(fixedContent);
    expect(result.method).toBe('llm');
  });
});

describe('AutoHealer: never throws', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = disableWhich();
  });

  afterEach(() => {
    restore();
  });

  test('does not throw when LLM throws internally', async () => {
    const healer = makeHealer(true, async () => {
      throw new Error('Network error');
    });
    const result = await healer.heal('test.ts', INVALID_TS, ['error']);
    expect(result.healed).toBe(false);
    expect(result.content).toBe(INVALID_TS);
  });

  test('does not throw on empty inputs', async () => {
    const healer = makeHealer(true);
    const result = await healer.heal('', '', ['']);
    expect(typeof result.healed).toBe('boolean');
    expect(typeof result.content).toBe('string');
  });
});

describe('AutoHealer: HealResult shape', () => {
  test('result always has healed (boolean) and content (string)', async () => {
    const healer = makeHealer(true);
    const result = await healer.heal('test.ts', VALID_TS, ['some error']);
    expect(typeof result.healed).toBe('boolean');
    expect(typeof result.content).toBe('string');
  });

  test('result.method is undefined when config gate blocks execution', async () => {
    const healer = makeHealer(false);
    const result = await healer.heal('test.ts', VALID_TS, ['error']);
    expect(result.healed).toBe(false);
    expect(result.method).toBeUndefined();
  });

  test('result.method is one of formatter|linter|llm|undefined', async () => {
    const validMethods = ['formatter', 'linter', 'llm', undefined];
    const healer = makeHealer(true);
    const result = await healer.heal('test.ts', VALID_TS, ['error']);
    expect(validMethods).toContain(result.method);
  });
});
