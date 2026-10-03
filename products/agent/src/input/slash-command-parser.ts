export interface ParsedSlashCommand {
  readonly name: string;
  readonly args: readonly string[];
}

export function parseSlashCommand(command: string): ParsedSlashCommand {
  const tokens = tokenizeSlashCommand(command.trim().replace(/^\//, ''));
  return {
    name: tokens[0] ?? '',
    args: tokens.slice(1),
  };
}

export function tokenizeSlashCommand(command: string): readonly string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += '\\';
  if (current.length > 0) tokens.push(current);
  return tokens;
}

export function quoteSlashCommandArg(value: string): string {
  if (/^[A-Za-z0-9._/:=@,+-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
