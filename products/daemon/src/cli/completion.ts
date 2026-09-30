/**
 * completion.ts, shell completion generated from the command catalog.
 *
 * The scripts are DERIVED, never hand-maintained: a command added to
 * `./command-catalog.ts` is completable the moment it exists, and one removed
 * stops being offered. A hand-written completion script is a second vocabulary,
 * and a second vocabulary drifts.
 *
 * What each script completes:
 *   - the command word (names and aliases, in catalog order)
 *   - a command's own sub-words (`sessions list`, `config get`, `webui enable`)
 *   - a command's flags plus the global ones, once a command word is present
 *
 * Values are deliberately NOT completed. A settings key, a session id or a host
 * name would each have to be fetched from a running daemon, and a completion
 * that hangs while a socket times out is worse than one that offers nothing.
 */
import {
  DAEMON_COMMANDS,
  GLOBAL_FLAGS,
  daemonCommandSpec,
  flagsForCommand,
  type DaemonCommand,
} from './command-catalog.ts';

export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish'] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export function isCompletionShell(value: string | undefined): value is CompletionShell {
  return typeof value === 'string' && (COMPLETION_SHELLS as readonly string[]).includes(value);
}

/** Every word that selects a command, catalog order, names before aliases. */
export function completionCommandWords(): readonly string[] {
  return DAEMON_COMMANDS.flatMap((spec) => [spec.name, ...spec.aliases]);
}

/** Long and short flag tokens a command accepts, its own plus the global ones. */
export function completionFlagsFor(command: DaemonCommand): readonly string[] {
  return flagsForCommand(command).flatMap((flag) => flag.tokens);
}

/** A shell-safe identifier fragment (`goodvibes-daemon` -> `goodvibes_daemon`). */
function shellIdent(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, '_');
}

function bashScript(binary: string): string {
  const fn = `_${shellIdent(binary)}_complete`;
  const commandWords = completionCommandWords().join(' ');
  const globalFlags = GLOBAL_FLAGS.flatMap((flag) => flag.tokens).join(' ');

  const caseArms = DAEMON_COMMANDS.map((spec) => {
    const words = [spec.name, ...spec.aliases].join('|');
    const flags = completionFlagsFor(spec.name).join(' ');
    const subs = spec.subcommands.join(' ');
    return [
      `    ${words})`,
      `      __gvd_flags="${flags}"`,
      `      __gvd_subs="${subs}"`,
      '      ;;',
    ].join('\n');
  }).join('\n');

  return [
    `# bash completion for ${binary}, generated from its command catalog.`,
    `# Install: ${binary} completion bash > ~/.local/share/bash-completion/completions/${binary}`,
    '',
    `${fn}() {`,
    '  local cur prev words cword',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  prev="${COMP_WORDS[COMP_CWORD-1]}"',
    '',
    `  local __gvd_commands="${commandWords}"`,
    `  local __gvd_global="${globalFlags}"`,
    '  local __gvd_flags=""',
    '  local __gvd_subs=""',
    '  local __gvd_command=""',
    '',
    '  # The first word that is not an option and not an option value is the command.',
    '  local i',
    '  for (( i=1; i < COMP_CWORD; i++ )); do',
    '    local w="${COMP_WORDS[i]}"',
    '    case "$w" in',
    '      -*) continue ;;',
    '      *)',
    '        case " $__gvd_commands " in',
    '          *" $w "*) __gvd_command="$w"; break ;;',
    '        esac',
    '        ;;',
    '    esac',
    '  done',
    '',
    '  if [[ -z "$__gvd_command" ]]; then',
    '    if [[ "$cur" == -* ]]; then',
    '      COMPREPLY=( $(compgen -W "$__gvd_global" -- "$cur") )',
    '    else',
    '      COMPREPLY=( $(compgen -W "$__gvd_commands" -- "$cur") )',
    '    fi',
    '    return 0',
    '  fi',
    '',
    '  case "$__gvd_command" in',
    caseArms,
    '  esac',
    '',
    '  if [[ "$cur" == -* ]]; then',
    '    COMPREPLY=( $(compgen -W "$__gvd_flags" -- "$cur") )',
    '  else',
    '    COMPREPLY=( $(compgen -W "$__gvd_subs" -- "$cur") )',
    '  fi',
    '  return 0',
    '}',
    '',
    `complete -F ${fn} ${binary}`,
    '',
  ].join('\n');
}

function zshDescribe(value: string): string {
  // Colons separate a zsh completion candidate from its description.
  return value.replace(/:/g, '\\:').replace(/'/g, "'\\''");
}

function zshScript(binary: string): string {
  const commandLines = DAEMON_COMMANDS
    .map((spec) => `    '${zshDescribe(spec.name)}:${zshDescribe(spec.summary)}'`)
    .join('\n');

  const caseArms = DAEMON_COMMANDS.map((spec) => {
    const words = [spec.name, ...spec.aliases].join('|');
    const flags = completionFlagsFor(spec.name)
      .map((token) => `'${zshDescribe(token)}'`)
      .join(' ');
    const subs = spec.subcommands.map((sub) => `'${zshDescribe(sub)}'`).join(' ');
    return [
      `      ${words})`,
      `        __gvd_flags=(${flags})`,
      `        __gvd_subs=(${subs})`,
      '        ;;',
    ].join('\n');
  }).join('\n');

  const fn = `_${shellIdent(binary)}`;
  return [
    `#compdef ${binary}`,
    `# zsh completion for ${binary}, generated from its command catalog.`,
    `# Install: ${binary} completion zsh > ~/.zfunc/_${binary}   (with ~/.zfunc on $fpath)`,
    '',
    `${fn}() {`,
    '  local -a __gvd_commands __gvd_flags __gvd_subs',
    '  __gvd_commands=(',
    commandLines,
    '  )',
    '',
    '  local __gvd_command="" w',
    '  for w in ${words[2,CURRENT-1]}; do',
    '    case $w in',
    '      -*) continue ;;',
    '      *) __gvd_command=$w; break ;;',
    '    esac',
    '  done',
    '',
    '  if [[ -z $__gvd_command ]]; then',
    '    _describe -t commands "command" __gvd_commands',
    '    return',
    '  fi',
    '',
    '  case $__gvd_command in',
    caseArms,
    '  esac',
    '',
    '  if [[ ${words[CURRENT]} == -* ]]; then',
    '    compadd -a __gvd_flags',
    '  else',
    '    compadd -a __gvd_subs',
    '  fi',
    '}',
    '',
    `${fn} "$@"`,
    '',
  ].join('\n');
}

function fishEscape(value: string): string {
  return value.replace(/'/g, "\\'");
}

function fishScript(binary: string): string {
  const guard = `__${shellIdent(binary)}_no_command`;
  const lines: string[] = [
    `# fish completion for ${binary}, generated from its command catalog.`,
    `# Install: ${binary} completion fish > ~/.config/fish/completions/${binary}.fish`,
    '',
    `function ${guard}`,
    '  set -l tokens (commandline -opc)',
    '  set -e tokens[1]',
    '  for token in $tokens',
    '    switch $token',
    "      case '-*'",
    '        continue',
    "      case '*'",
    '        return 1',
    '    end',
    '  end',
    '  return 0',
    'end',
    '',
  ];

  for (const spec of DAEMON_COMMANDS) {
    lines.push(
      `complete -c ${binary} -n '${guard}' `
        + `-a '${fishEscape(spec.name)}' -d '${fishEscape(spec.summary)}'`,
    );
  }
  lines.push('');

  for (const spec of DAEMON_COMMANDS) {
    for (const sub of spec.subcommands) {
      lines.push(`complete -c ${binary} -n '__fish_seen_subcommand_from ${spec.name}' -a '${fishEscape(sub)}'`);
    }
    for (const flag of daemonCommandSpec(spec.name).flags) {
      for (const token of flag.tokens) {
        const option = token.startsWith('--') ? `-l ${token.slice(2)}` : `-s ${token.slice(1)}`;
        const takesValue = flag.kind === 'boolean' ? '' : ' -r';
        lines.push(
          `complete -c ${binary} -n '__fish_seen_subcommand_from ${spec.name}' `
            + `${option}${takesValue} -d '${fishEscape(flag.summary)}'`,
        );
      }
    }
  }

  lines.push('');
  for (const flag of GLOBAL_FLAGS) {
    for (const token of flag.tokens) {
      const option = token.startsWith('--') ? `-l ${token.slice(2)}` : `-s ${token.slice(1)}`;
      const takesValue = flag.kind === 'boolean' ? '' : ' -r';
      lines.push(`complete -c ${binary} ${option}${takesValue} -d '${fishEscape(flag.summary)}'`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function renderCompletionScript(shell: CompletionShell, binary = 'goodvibes-daemon'): string {
  if (shell === 'bash') return bashScript(binary);
  if (shell === 'zsh') return zshScript(binary);
  return fishScript(binary);
}

export interface CompletionCommandResult {
  readonly exitCode: number;
  readonly lines: readonly string[];
}

/**
 * `goodvibes-daemon completion <shell>`.
 *
 * A missing or unrecognized shell is a usage refusal (exit 2) naming the ones
 * that exist, rather than a default guess: writing a bash script into a zsh
 * fpath produces a completion that silently never fires.
 */
export function runCompletionCommand(
  argv: readonly string[],
  binary = 'goodvibes-daemon',
): CompletionCommandResult {
  const positional = argv.filter((token) => !token.startsWith('-'));
  const shell = positional[0];
  if (shell === undefined) {
    return {
      exitCode: 2,
      lines: [
        'completion: name the shell.',
        `  ${binary} completion ${COMPLETION_SHELLS.join('|')}`,
      ],
    };
  }
  if (!isCompletionShell(shell)) {
    return {
      exitCode: 2,
      lines: [
        `completion: '${shell}' is not a shell this generates for.`,
        `  ${binary} completion ${COMPLETION_SHELLS.join('|')}`,
      ],
    };
  }
  if (positional.length > 1) {
    return {
      exitCode: 2,
      lines: [
        `completion: '${positional[1]}' is one argument too many.`,
        `  ${binary} completion ${COMPLETION_SHELLS.join('|')}`,
      ],
    };
  }
  return { exitCode: 0, lines: [renderCompletionScript(shell, binary)] };
}
