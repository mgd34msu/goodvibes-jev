import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { extractNativeHeadlessOptions } from '../../cli/native-headless-options.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';

const recoveryOptions = [
  ['--intake-status', 'status'],
  ['--intake-retry', 'retry'],
  ['--intake-resume', 'resume'],
  ['--intake-cancel', 'cancel'],
] as const;

// Every required-value spelling in this product's CLI grammar, including aliases.
const valueOptions = [
  '--provider', '--model', '-m', '--working-dir', '--cd',
  '-C', '--prompt', '-p', '--output-format', '--output',
  '-o', '--config', '-c', '--enable', '--disable',
  '--port', '--hostname', '--host', '--session', '-s',
  '--agent-profile', '--runtime-url', '--runtime',
];

function expectUnchanged(argv: readonly string[]) {
  expect(extractNativeHeadlessOptions(argv)).toEqual({ argv: [...argv], mode: 'submit', errors: [] });
}

describe('native headless option authority', () => {
  test('the guarded required-value spellings cover the current Agent parser', () => {
    const source = readFileSync(new URL('../../cli/parser.ts', import.meta.url), 'utf8');
    const branches = [...source.matchAll(/if \(([^{}]+)\) \{\s*const consumed = getValue\(/g)];
    const required = branches.flatMap(branch => [...branch[1]!.matchAll(/name === '([^']+)'/g)].map(match => match[1]!));
    expect([...new Set(required)].sort()).toEqual([...valueOptions].sort());
  });

  test('empty and ordinary argv have no recovery authority', () => {
    expectUnchanged([]);
    expectUnchanged(['run', '  Keep CRLF\r\n😀 !@source.md @context  ', '--output', 'json']);
  });

  for (const [option, mode] of recoveryOptions) {
    test(`${option} is extracted only as a standalone option`, () => {
      expect(extractNativeHeadlessOptions(['exec', '--output=json', option])).toEqual({
        argv: ['exec', '--output=json'], mode, errors: [],
      });
      expect(extractNativeHeadlessOptions([option, 'run'])).toEqual({ argv: ['run'], mode, errors: [] });
    });

    test(`${option} and malformed variants remain literal after --`, () => {
      expectUnchanged(['run', '--', option, `${option}=value`, option]);
      expectUnchanged(['--', option, '--intake-cancel']);
      expectUnchanged(['run', '--prompt', '--', option]);
      expectUnchanged(['run', '-p', '--', option]);
    });

    test(`${option} before -- does not claim any later control`, () => {
      expect(extractNativeHeadlessOptions(['run', option, '--', '--intake-cancel', `${option}=value`])).toEqual({
        argv: ['run', '--', '--intake-cancel', `${option}=value`], mode, errors: [],
      });
    });

    test(`${option} cannot take a value`, () => {
      for (const suffix of ['=', '=value', '=value=other']) {
        expect(extractNativeHeadlessOptions(['run', `${option}${suffix}`])).toEqual({
          argv: ['run'], mode: 'submit', errors: ['Native intake recovery options take no value.'],
        });
      }
    });

    test(`${option} conflicts with every second recovery option, including itself`, () => {
      for (const [other, otherMode] of recoveryOptions) {
        expect(extractNativeHeadlessOptions(['run', option, other])).toEqual({
          argv: ['run'], mode: otherMode, errors: ['Choose exactly one native intake recovery option.'],
        });
      }
    });
  }

  for (const valueOption of valueOptions) {
    test(`${valueOption} retains a recovery-looking operand and the original missing-value refusal`, () => {
      for (const [option] of recoveryOptions) {
        for (const operand of [option, `${option}=value`]) {
          const argv = ['run', valueOption, operand, 'source'];
          expectUnchanged(argv);
          expectUnchanged(['run', valueOption, '--', operand]);
          // Removing the recovery-looking token would incorrectly let "source"
          // become the flag value and can turn invalid argv into a valid action.
          expect(parseGoodVibesCli(extractNativeHeadlessOptions(argv).argv).errors).toContain(`${valueOption} requires a value.`);
        }
      }
    });

    test(`${valueOption} inline values stay opaque and do not reserve the next token`, () => {
      for (const [option] of recoveryOptions) {
        expectUnchanged(['run', `${valueOption}=${option}`]);
        expect(extractNativeHeadlessOptions(['run', `${valueOption}=${option}`, '--intake-status'])).toEqual({
          argv: ['run', `${valueOption}=${option}`], mode: 'status', errors: [],
        });
      }
    });
  }

  test('a protected operand does not conflict with an explicit recovery control', () => {
    for (const valueOption of valueOptions) {
      expect(extractNativeHeadlessOptions(['run', '--intake-status', valueOption, '--intake-cancel'])).toEqual({
        argv: ['run', valueOption, '--intake-cancel'], mode: 'status', errors: [],
      });
    }
  });

  test('one missing value cannot hide another value-taking flag from the guard', () => {
    expectUnchanged(['run', '--prompt', '--model', '--intake-cancel', 'source']);
  });

  test('a complete separate value does not reserve a later recovery option', () => {
    expect(extractNativeHeadlessOptions(['run', '--model', 'example:model', '--intake-status'])).toEqual({
      argv: ['run', '--model', 'example:model'], mode: 'status', errors: [],
    });
    expect(extractNativeHeadlessOptions(['run', '--prompt', '-', '--intake-status'])).toEqual({
      argv: ['run', '--prompt', '-'], mode: 'status', errors: [],
    });
  });

  test('optional-value flags do not claim option-shaped recovery tokens', () => {
    for (const option of ['--resume', '-r']) {
      expect(extractNativeHeadlessOptions(['run', option, '--intake-status'])).toEqual({
        argv: ['run', option], mode: 'status', errors: [],
      });
      expect(extractNativeHeadlessOptions(['run', option, 'session-id', '--intake-status'])).toEqual({
        argv: ['run', option, 'session-id'], mode: 'status', errors: [],
      });
    }
  });

  for (const optionalOption of ['--resume', '-r']) {
    test(`${optionalOption} refuses recovery extraction that would swallow a positional`, () => {
      for (const [option] of recoveryOptions) {
        for (const value of ['source', '', '  keep source  ', 'constructor']) {
          const argv = ['run', optionalOption, option, value];
          expect(extractNativeHeadlessOptions(argv)).toEqual({
            argv, mode: 'submit',
            errors: [`Native intake recovery after ${optionalOption} would change its optional value. Use an inline ${optionalOption}=value or move the recovery option.`],
          });
        }
      }
    });

    test(`${optionalOption} safely retains its bare meaning when the next token is not a value`, () => {
      for (const trailing of [[], ['-'], ['--', 'source'], ['--model', 'example:model']]) {
        const argv = ['run', optionalOption, '--intake-status', ...trailing];
        const result = extractNativeHeadlessOptions(argv);
        expect(result).toEqual({ argv: ['run', optionalOption, ...trailing], mode: 'status', errors: [] });
        const field = optionalOption === '--fork' ? 'fork' : 'resume';
        expect(parseGoodVibesCli(result.argv).flags[field]).toBe(parseGoodVibesCli(argv).flags[field]);
      }
    });

    test(`${optionalOption} with an explicit value leaves later positional source intact`, () => {
      for (const flagAndValue of [[`${optionalOption}=session-id`], [optionalOption, 'session-id']]) {
        const argv = ['run', ...flagAndValue, '--intake-status', 'source'];
        const result = extractNativeHeadlessOptions(argv);
        expect(result).toEqual({ argv: ['run', ...flagAndValue, 'source'], mode: 'status', errors: [] });
        expect(parseGoodVibesCli(result.argv).flags.prompt).toBe('source');
      }
    });
  }

  test('lookalikes and object property names have no recovery authority', () => {
    expectUnchanged(['run', 'constructor', 'toString', '__proto__', 'hasOwnProperty']);
    expectUnchanged(['run', '--intake-status-extra', '--intake-statusx=value', '-intake-status', ' --intake-status']);
  });

  test('does not mutate the original argv or reuse it as its output', () => {
    const argv = Object.freeze(['run', '--', '--intake-status']);
    const result = extractNativeHeadlessOptions(argv);
    expect(result.argv).toEqual([...argv]);
    expect(result.argv).not.toBe(argv);
    result.argv.push('new source');
    expect(argv).toEqual(['run', '--', '--intake-status']);
  });
});
