/** Inspect original argv, never flattened commandArgs: -- ends option authority. */
export type NativeHeadlessMode = 'submit' | 'status' | 'retry' | 'resume' | 'cancel';

const recovery = new Map<string, NativeHeadlessMode>([
  ['--intake-status', 'status'],
  ['--intake-retry', 'retry'],
  ['--intake-resume', 'resume'],
  ['--intake-cancel', 'cancel'],
]);

// Mirror this product's required-value CLI flags, including their aliases.
const requiredValueOptions = new Set([
  '--provider', '--model', '-m',
  '--agent-profile', '--runtime-url', '--runtime',
  '--working-dir', '--cd', '-C', '--prompt', '-p',
  '--output-format', '--output', '-o', '--config', '-c',
  '--enable', '--disable', '--port', '--hostname', '--host', '--session', '-s',
]);

// These flags consume only following tokens that do not start with a dash.
const optionalValueOptions = new Set(['--resume', '-r']);

export function extractNativeHeadlessOptions(argv: readonly string[]): { argv: string[]; mode: NativeHeadlessMode; errors: string[] } {
  const result: string[] = [];
  const errors: string[] = [];
  let mode: NativeHeadlessMode = 'submit';

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      result.push(...argv.slice(i));
      break;
    }
    // Even an invalid, option-shaped operand must survive for the main
    // parser to reject. Stripping it could turn a later positional into the
    // missing value and silently promote the operand into recovery authority.
    // Check the original preceding token, so adjacent missing-value flags are
    // also protected. An inline =value never reserves the following token.
    if (i > 0 && requiredValueOptions.has(argv[i - 1]!)) {
      result.push(token);
      continue;
    }

    const action = recovery.get(token);
    if (action) {
      const previous = argv[i - 1];
      const next = argv[i + 1];
      // Removing this option must not let an optional flag swallow a token
      // that was originally positional (including an empty string).
      if (previous !== undefined && optionalValueOptions.has(previous) && next !== undefined && !next.startsWith('-')) {
        errors.push(`Native intake recovery after ${previous} would change its optional value. Use an inline ${previous}=value or move the recovery option.`);
        result.push(token);
        continue;
      }
      if (mode !== 'submit') errors.push('Choose exactly one native intake recovery option.');
      mode = action;
    } else if ([...recovery.keys()].some(flag => token.startsWith(`${flag}=`))) {
      errors.push('Native intake recovery options take no value.');
    } else {
      result.push(token);
    }
  }
  return { argv: result, mode, errors };
}
