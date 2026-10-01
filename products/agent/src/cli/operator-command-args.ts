/**
 * Shared flag/positional parser for the connected-host operator CLI commands
 * (ci, principals, channel-profiles). Mirrors parseRoutineOptions in
 * routines-command.ts: `--flag value`, `--flag=value`, bare `--flag` booleans,
 * and a `--yes` confirmation flag, with `--` starting pure positionals.
 */

export interface ParsedOperatorCommandArgs {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
  readonly booleanFlags: ReadonlySet<string>;
  readonly yes: boolean;
}

export function parseOperatorCommandArgs(
  args: readonly string[],
  valueFlags: readonly string[] = [],
): ParsedOperatorCommandArgs {
  const valued = new Set(valueFlags);
  const flags = new Map<string, string>();
  const booleanFlags = new Set<string>();
  const positionals: string[] = [];
  let yes = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? '';
    if (token === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (token === '--yes') {
      yes = true;
      continue;
    }
    if (token.startsWith('--') && token.length > 2) {
      const raw = token.slice(2);
      const equalIndex = raw.indexOf('=');
      if (equalIndex >= 0) {
        flags.set(raw.slice(0, equalIndex), raw.slice(equalIndex + 1));
        continue;
      }
      const key = raw;
      const next = args[index + 1];
      if (next !== undefined && (valued.has(key) || !next.startsWith('--'))) {
        flags.set(key, next);
        index += 1;
      } else {
        booleanFlags.add(key);
        flags.set(key, 'true');
      }
      continue;
    }
    positionals.push(token);
  }
  return { positionals, flags, booleanFlags, yes };
}

export function operatorFlagValue(parsed: ParsedOperatorCommandArgs, key: string): string | undefined {
  const value = parsed.flags.get(key)?.trim();
  return value ? value : undefined;
}

export function operatorHasFlag(parsed: ParsedOperatorCommandArgs, key: string): boolean {
  return parsed.booleanFlags.has(key) || parsed.flags.get(key) === 'true';
}

export function operatorRequiredFlag(parsed: ParsedOperatorCommandArgs, key: string, usage: string): string {
  const value = operatorFlagValue(parsed, key);
  if (!value) throw new Error(`${usage}\nMissing --${key}.`);
  return value;
}

export function operatorParseIntFlag(parsed: ParsedOperatorCommandArgs, key: string, usage: string): number | undefined {
  const value = operatorFlagValue(parsed, key);
  if (value === undefined) return undefined;
  const parsedNumber = Number.parseInt(value, 10);
  if (!Number.isFinite(parsedNumber)) throw new Error(`${usage}\n--${key} must be a number.`);
  return parsedNumber;
}

/** Splits comma-separated `channel:value` pairs, e.g. "slack:U123,email:a@b.com". */
export function parseIdentityPairs(raw: string | undefined): readonly { readonly channel: string; readonly value: string }[] {
  if (!raw) return [];
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const index = entry.indexOf(':');
    if (index < 0) throw new Error(`Invalid --identity entry "${entry}"; expected channel:value.`);
    return { channel: entry.slice(0, index).trim(), value: entry.slice(index + 1).trim() };
  });
}
