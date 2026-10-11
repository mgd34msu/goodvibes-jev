import { admitRegex, compileLegacyRegex } from '@goodvibes-jev/engine/errors';
const DEFAULT_MAX_INPUT_CHARS = 50_000;
export interface SafeRegExpOptions {
  readonly operation: string;
  readonly maxPatternChars?: number | undefined;
  readonly maxInputChars?: number | undefined;
}

/** @deprecated Synchronous compatibility only; production callers use createSafeRegex. */
export function compileSafeRegExp(source: string, flags: string, options: SafeRegExpOptions): RegExp {
  return compileLegacyRegex(source, flags, options);
}

export const createSafeRegex = admitRegex;

export function assertSafeRegexInput(input: string, options: SafeRegExpOptions): void {
  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  if (input.length > maxInputChars) {
    throw new Error(`${options.operation} regex input exceeds ${maxInputChars} characters`);
  }
}

export function safeRegExpTest(regex: RegExp, input: string, options: SafeRegExpOptions): boolean {
  assertSafeRegexInput(input, options);
  regex.lastIndex = 0;
  return regex.test(input);
}

export function safeRegExpExec(regex: RegExp, input: string, options: SafeRegExpOptions): RegExpExecArray | null {
  assertSafeRegexInput(input, options);
  return regex.exec(input);
}
