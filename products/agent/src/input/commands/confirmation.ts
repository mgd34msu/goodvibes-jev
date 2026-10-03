import type { CommandContext } from '../command-registry.ts';

export interface ConfirmationArgs {
  readonly rest: readonly string[];
  readonly yes: boolean;
}

export function stripYesFlag(args: readonly string[]): ConfirmationArgs {
  const rest: string[] = [];
  let yes = false;
  for (const token of args) {
    if (token === '--yes') {
      yes = true;
      continue;
    }
    rest.push(token);
  }
  return { rest, yes };
}

export function requireYesFlag(ctx: CommandContext, action: string, usage: string): boolean {
  ctx.print(`Refusing to ${action} without --yes.\nUsage: ${usage}`);
  return false;
}
