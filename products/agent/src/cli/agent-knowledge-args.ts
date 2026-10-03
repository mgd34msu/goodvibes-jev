export function commandValues(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith('--')) {
      values.push(token);
      continue;
    }
    if (!token.includes('=') && args[index + 1] && !args[index + 1]!.startsWith('--')) index += 1;
  }
  return values;
}

export function delegationTaskValues(args: readonly string[]): string[] {
  const values: string[] = [];
  for (const token of args) {
    if (token === '--review' || token === '--wrfc') continue;
    if (!token.startsWith('--')) values.push(token);
  }
  return values;
}

export function readOptionValue(args: readonly string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === name) {
      const next = args[index + 1];
      return next && !next.startsWith('--') ? next : undefined;
    }
    if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
  }
  return undefined;
}

export function readPositiveInt(args: readonly string[], name: string, fallback: number): number {
  const raw = readOptionValue(args, name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readStringList(args: readonly string[], name: string): readonly string[] {
  const raw = readOptionValue(args, name);
  if (!raw) return [];
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

export function readFirstStringList(args: readonly string[], names: readonly string[]): readonly string[] {
  for (const name of names) {
    const values = readStringList(args, name);
    if (values.length > 0) return values;
  }
  return [];
}

export function readSinceMs(args: readonly string[]): number | undefined {
  const days = readOptionValue(args, '--since-days');
  if (!days) return undefined;
  const parsed = Number.parseInt(days, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Date.now() - parsed * 24 * 60 * 60 * 1000;
}

export function parseConnectorInput(value: string | undefined): unknown {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

export function hasAnyFlag(args: readonly string[], flags: readonly string[]): boolean {
  return flags.some((flag) => args.includes(flag));
}

export function stripCommandFlag(args: readonly string[], flag: string): { readonly rest: readonly string[]; readonly present: boolean } {
  const rest: string[] = [];
  let present = false;
  for (const arg of args) {
    if (arg === flag) {
      present = true;
      continue;
    }
    rest.push(arg);
  }
  return { rest, present };
}
