export interface ParsedAgentLocalLibraryArgs {
  readonly rest: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
  readonly yes: boolean;
}

export interface AgentLocalLibraryArgOptions {
  readonly valueFlags: readonly string[];
}

export function parseAgentLocalLibraryArgs(
  args: readonly string[],
  options: AgentLocalLibraryArgOptions,
): ParsedAgentLocalLibraryArgs {
  const valueFlags = new Set(options.valueFlags);
  const flags = new Map<string, string>();
  const rest: string[] = [];
  let yes = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? '';
    if (token === '--') {
      rest.push(...args.slice(index + 1));
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
      if (valueFlags.has(raw)) {
        const next = args[index + 1];
        if (next !== undefined) {
          flags.set(raw, next);
          index += 1;
        } else {
          flags.set(raw, '');
        }
        continue;
      }
      flags.set(raw, 'true');
      continue;
    }
    rest.push(token);
  }
  return { rest, flags, yes };
}
