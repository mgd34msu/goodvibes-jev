const COMMANDS = [
  'run',
  'exec',
  'onboarding',
  'setup',
  'doctor',
  'status',
  'models',
  'providers',
  'profiles',
  'routines',
  'ci',
  'principals',
  'owner-profile',
  'channel-profiles',
  'workspaces',
  'fleet',
  'browser',
  'auth',
  'compat',
  'knowledge',
  'ask',
  'search',
  'delegate',
  'subscription',
  'secrets',
  'sessions',
  'pair',
  'qrcode',
  'bundle',
  'completion',
  'version',
  'help',
] as const;

const OPTIONS = [
  '--help',
  '--version',
  '--model',
  '--provider',
  '--agent-profile',
  '--runtime-url',
  '--cd',
  '--working-dir',
  '--config',
  '--enable',
  '--disable',
  '--prompt',
  '--print',
  '--output',
  '--output-format',
  '--json',
  '--no-alt-screen',
  '--open',
  '--resume',
  '--session',
  '--continue',
  '--fork',
  '--password',
  '--password-stdin',
  '--role',
  '--manual',
] as const;

export function renderCompletion(shell: string | undefined, binary = 'goodvibes-agent'): string {
  const normalized = (shell ?? 'bash').toLowerCase();
  const words = [...COMMANDS, ...OPTIONS].join(' ');

  if (normalized === 'zsh') {
    return [
      `#compdef ${binary}`,
      `_${binary}() {`,
      `  compadd -- ${words}`,
      '}',
      `_${binary} "$@"`,
    ].join('\n');
  }

  if (normalized === 'fish') {
    return [...COMMANDS, ...OPTIONS]
      .map((word) => `complete -c ${binary} -a ${JSON.stringify(word)}`)
      .join('\n');
  }

  return [
    `_${binary}() {`,
    '  local cur',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    `  COMPREPLY=( $(compgen -W "${words}" -- "$cur") )`,
    '}',
    `complete -F _${binary} ${binary}`,
  ].join('\n');
}
