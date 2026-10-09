import { shellSplit } from '@goodvibes-jev/engine/sdk/platform/utils';

/** Quoting is command grammar, never schedule meaning. Reject incomplete input. */
export function scheduleCommandArguments(command: string): string[] | undefined {
  let quote: '"' | "'" | undefined;
  let tokenStart: number | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (!quote && /\s/.test(ch!)) {
      // shellSplit intentionally drops empty words. A positional command must
      // reject that input before a prompt can shift into the schedule slot.
      if (tokenStart !== undefined && shellSplit(command.slice(tokenStart, i)).length === 0) return undefined;
      tokenStart = undefined;
      continue;
    }
    tokenStart ??= i;
    if (ch === '\\' && quote !== "'") {
      if (i + 1 === command.length) return undefined;
      if (!quote || command[i + 1] === '"' || command[i + 1] === '\\') i++;
    } else if (ch === quote) quote = undefined;
    else if (!quote && (ch === '"' || ch === "'")) quote = ch;
  }
  if (quote || (tokenStart !== undefined && shellSplit(command.slice(tokenStart)).length === 0)) return undefined;
  return shellSplit(command).slice(1);
}
