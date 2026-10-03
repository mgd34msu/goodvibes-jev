import { join } from 'node:path';
import type { CommandContext } from '../input/command-registry.ts';

export interface AgentHarnessSudoPosture {
  readonly capability: 'sudo';
  readonly status: 'foreground-or-user-supervised-only';
  readonly setupStatus: 'optional' | 'check';
  readonly userOutcome: string;
  readonly modelRoute: string;
  readonly setupRoute: string;
  readonly foregroundRoute: string;
  readonly credentialSignal: {
    readonly envPresent: boolean;
    readonly checked: 'process.env.SUDO_PASSWORD only';
    readonly envFilePath: string | null;
    readonly rawValueReturned: false;
    readonly valueUsableForBackgroundProcess: false;
    readonly guidance: string;
  };
  readonly supportedRoutes: readonly Record<string, string>[];
  readonly blockedRoutes: readonly Record<string, string>[];
  readonly missingContracts: readonly string[];
  readonly signals: readonly string[];
  readonly nextAction: string;
  readonly policy: string;
}

function homeDirectory(context?: CommandContext): string | null {
  const shellPaths = context?.workspace.shellPaths as { readonly homeDirectory?: unknown } | undefined;
  const fromShellPaths = typeof shellPaths?.homeDirectory === 'string' && shellPaths.homeDirectory.trim()
    ? shellPaths.homeDirectory.trim()
    : '';
  if (fromShellPaths) return fromShellPaths;
  return typeof process.env.HOME === 'string' && process.env.HOME.trim() ? process.env.HOME.trim() : null;
}

export function sudoExecutionPosture(context?: CommandContext): AgentHarnessSudoPosture {
  const sudoPasswordPresent = Boolean(process.env.SUDO_PASSWORD);
  const home = homeDirectory(context);
  const envFilePath = home ? join(home, '.goodvibes', '.env') : null;
  const setupRoute = 'setup action:"item" setupItemId:"sudo-execution-posture"';
  const foregroundRoute = 'execution action:"route" id:"local-shell-command"';
  const processCapabilitiesRoute = 'process action:"capabilities"';
  return {
    capability: 'sudo',
    status: 'foreground-or-user-supervised-only',
    setupStatus: sudoPasswordPresent ? 'check' : 'optional',
    userOutcome: 'Privilege escalation stays explicit, visible, and user-supervised; hidden background sudo prompts are blocked.',
    modelRoute: foregroundRoute,
    setupRoute,
    foregroundRoute,
    credentialSignal: {
      envPresent: sudoPasswordPresent,
      checked: 'process.env.SUDO_PASSWORD only',
      envFilePath,
      rawValueReturned: false,
      valueUsableForBackgroundProcess: false,
      guidance: sudoPasswordPresent
        ? 'SUDO_PASSWORD is present in the current environment, but Agent only reports presence and does not read, print, or pass the value to hidden background sudo.'
        : 'If future SDK/daemon mediation supports sudo credentials, GoodVibes can load SUDO_PASSWORD from ~/.goodvibes/.env; Agent does not write or display that value.',
    },
    supportedRoutes: [
      {
        id: 'foreground-supervised-shell',
        route: foregroundRoute,
        outcome: 'Use a visible foreground shell route for explicit user-requested escalation.',
      },
      {
        id: 'process-capability-report',
        route: processCapabilitiesRoute,
        outcome: 'Inspect the process parity report before choosing background process behavior.',
      },
      {
        id: 'setup-posture',
        route: setupRoute,
        outcome: 'Show sudo setup posture, credential presence, blocked routes, and next steps without exposing secrets.',
      },
    ],
    blockedRoutes: [
      {
        id: 'background-sudo-prompt',
        route: 'terminal command:"sudo ..." background:true',
        reason: 'Blocked because background password prompts can hang or hide privilege escalation.',
      },
      {
        id: 'stdin-password-write',
        route: 'process action:"write" data:"..."',
        reason: 'Blocked until ProcessManager exposes a safe stdin/credential-prompt contract.',
      },
      {
        id: 'raw-password-display',
        route: 'setup/output/logs',
        reason: 'Blocked because raw sudo passwords must never be printed, stored by Agent, or included in model-visible output.',
      },
    ],
    missingContracts: [
      'SDK ProcessManager stdin write',
      'SDK ProcessManager PTY session',
      'daemon credential-prompt mediation',
      'model-visible credential-use receipt without secret value disclosure',
    ],
    signals: [
      `SUDO_PASSWORD env present: ${sudoPasswordPresent ? 'yes' : 'no'}`,
      `credential check: process.env.SUDO_PASSWORD only`,
      `env file guidance: ${envFilePath ?? '~/.goodvibes/.env'}`,
      'background sudo prompt: blocked',
      'raw sudo password returned: never',
    ],
    nextAction: sudoPasswordPresent
      ? 'Review sudo posture before escalation; use only visible foreground sudo until the SDK/daemon publishes safe credential mediation.'
      : 'Use visible foreground sudo for explicit escalation; configure SUDO_PASSWORD outside Agent only if a future safe credential contract requires it.',
    policy: 'Agent reports only credential presence and safe routes. It never reads, stores, prints, or injects raw sudo passwords, and it blocks hidden background sudo prompts.',
  };
}
