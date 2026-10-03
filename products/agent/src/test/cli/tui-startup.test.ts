import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createSessionSurface, createShellPathService, writeLastSessionPointer } from '@/runtime/index.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { applyInitialTuiCliState, formatFatalStartupErrorForUser, getInteractiveTerminalLaunchError } from '../../cli/tui-startup.ts';
import { writeOnboardingCheckMarker, writeOnboardingCompletionMarker } from '../../runtime/onboarding/index.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import type { InputHandler } from '../../input/handler.ts';
import type { GoodVibesCliParseResult } from '../../cli/types.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeShellPaths() {
  const root = makeProjectTempDir(`gv-tui-startup-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return createShellPathService({
    workingDirectory: join(root, 'workspace'),
    homeDirectory: join(root, 'home'),
  });
}

function makeSurface(shellPaths: ReturnType<typeof makeShellPaths>): SessionSurface {
  return createSessionSurface({
    surfaceRoot: 'agent',
    workingDirectory: shellPaths.workingDirectory,
    homeDirectory: shellPaths.homeDirectory,
  });
}

function makeCli(overrides: Partial<GoodVibesCliParseResult> = {}): GoodVibesCliParseResult {
  return {
    binary: 'goodvibes',
    command: 'tui',
    rawCommand: undefined,
    commandArgs: [],
    positionals: [],
    flags: {
      provider: undefined,
      model: undefined,
      agentProfile: undefined,
      workingDir: undefined,
      help: false,
      version: false,
      prompt: undefined,
      print: false,
      outputFormat: 'text',
      configOverrides: [],
      enableFeatures: [],
      disableFeatures: [],
      noAltScreen: false,
      port: undefined,
      hostname: undefined,
      open: false,
      continueLast: false,
      resume: undefined,
      session: undefined,
      fork: false,
      rawOutput: false,
      acceptRawOutputRisk: false,
      runtimeUrl: undefined,
    },
    errors: [],
    ...overrides,
  };
}

function runStartup(
  shellPaths: ReturnType<typeof makeShellPaths>,
  cli: GoodVibesCliParseResult = makeCli(),
): { readonly workspaceCategories: Array<string | undefined>; readonly prompt: string } {
  const workspaceCategories: Array<string | undefined> = [];
  const input = {
    prompt: '',
    cursorPos: 0,
    openAgentWorkspace: (_context: CommandContext, categoryId?: string) => {
      workspaceCategories.push(categoryId);
    },
  } as unknown as InputHandler;

  applyInitialTuiCliState({
    cli,
    input,
    commandRegistry: new CommandRegistry(),
    commandContext: {} as CommandContext,
    shellPaths,
    surface: makeSurface(shellPaths),
    render: () => {},
  });

  return { workspaceCategories, prompt: input.prompt };
}

type FakeSavedSession = { readonly name: string; readonly title: string; readonly timestamp: number; readonly messageCount: number };

/**
 * Runs startup with a fully-wired fake CommandContext (print + a stub
 * session-manager) so the resume-on-relaunch notice can be observed
 * end to end, the same way the real commandContext.print/session.sessionManager
 * are wired in main.ts.
 */
function runStartupCapturingResumeNotice(
  shellPaths: ReturnType<typeof makeShellPaths>,
  savedSessions: readonly FakeSavedSession[],
): { readonly printed: string[] } {
  const printed: string[] = [];
  const input = {
    prompt: '',
    cursorPos: 0,
    openAgentWorkspace: () => {},
  } as unknown as InputHandler;

  const commandContext = {
    print: (text: string) => printed.push(text),
    session: {
      sessionManager: {
        list: () => savedSessions.map((s) => ({ ...s, model: '', provider: '', filePath: '' })),
      },
    },
  } as unknown as CommandContext;

  applyInitialTuiCliState({
    cli: makeCli(),
    input,
    commandRegistry: new CommandRegistry(),
    commandContext,
    shellPaths,
    surface: makeSurface(shellPaths),
    render: () => {},
  });

  return { printed };
}

describe('initial TUI onboarding startup check', () => {
  test('opens the setup workspace when the user completion marker is absent', () => {
    const shellPaths = makeShellPaths();

    const result = runStartup(shellPaths);
    expect(result.workspaceCategories).toEqual(['setup']);
  });

  test('does not use project markers as the global onboarding check', () => {
    const shellPaths = makeShellPaths();
    writeOnboardingCheckMarker(shellPaths, {
      scope: 'project',
      source: 'wizard',
      mode: 'new',
    });

    const result = runStartup(shellPaths);
    expect(result.workspaceCategories).toEqual(['setup']);
  });

  test('opens Agent workspace when only the legacy global user check marker exists', () => {
    const shellPaths = makeShellPaths();
    writeOnboardingCheckMarker(shellPaths, {
      scope: 'user',
      source: 'wizard',
      mode: 'new',
    });

    const result = runStartup(shellPaths);
    expect(result.workspaceCategories).toEqual(['setup']);
  });

  test('does not open Agent workspace on normal startup after the user completion marker exists', () => {
    const shellPaths = makeShellPaths();
    writeOnboardingCompletionMarker(shellPaths, {
      scope: 'user',
      source: 'wizard',
      mode: 'new',
    });

    const result = runStartup(shellPaths);
    expect(result.workspaceCategories).toEqual([]);
  });

  test('still opens Agent workspace for the explicit onboarding command after the marker exists', () => {
    const shellPaths = makeShellPaths();
    writeOnboardingCompletionMarker(shellPaths, {
      scope: 'user',
      source: 'wizard',
      mode: 'new',
    });

    const result = runStartup(shellPaths, makeCli({
      command: 'onboarding',
      rawCommand: 'onboarding',
    }));
    expect(result.workspaceCategories).toEqual([undefined]);
  });

  test('does not replace a seeded prompt with the Agent workspace', () => {
    const shellPaths = makeShellPaths();
    writeOnboardingCompletionMarker(shellPaths, {
      scope: 'user',
      source: 'wizard',
      mode: 'new',
    });

    const result = runStartup(shellPaths, makeCli({
      positionals: ['summarize', 'today'],
    }));

    expect(result.workspaceCategories).toEqual([]);
    expect(result.prompt).toBe('summarize today');
  });
});

describe('resume-on-relaunch notice', () => {
  function completeOnboarding(shellPaths: ReturnType<typeof makeShellPaths>): void {
    writeOnboardingCompletionMarker(shellPaths, {
      scope: 'user',
      source: 'wizard',
      mode: 'new',
    });
  }

  test('shows no notice on a clean first run (no last-session pointer)', () => {
    const shellPaths = makeShellPaths();
    completeOnboarding(shellPaths);

    const { printed } = runStartupCapturingResumeNotice(shellPaths, []);
    expect(printed).toEqual([]);
  });

  test('surfaces an actionable resume notice when a valid last-session pointer exists', () => {
    const shellPaths = makeShellPaths();
    completeOnboarding(shellPaths);
    writeLastSessionPointer('user-relaunch-1', { surface: makeSurface(shellPaths) });

    const { printed } = runStartupCapturingResumeNotice(shellPaths, [
      { name: 'user-relaunch-1', title: 'Investigate the boot race', timestamp: Date.now() - 5 * 60_000, messageCount: 7 },
    ]);

    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('[Resume]');
    expect(printed[0]).toContain('Investigate the boot race');
    expect(printed[0]).toContain('/session resume user-relaunch-1');
  });

  test('is honest about a stale pointer instead of offering a dead resume button', () => {
    const shellPaths = makeShellPaths();
    completeOnboarding(shellPaths);
    writeLastSessionPointer('user-deleted-session', { surface: makeSurface(shellPaths) });

    // No matching entry in the session store: the pointer is dangling.
    const { printed } = runStartupCapturingResumeNotice(shellPaths, []);

    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('unavailable');
    expect(printed[0]).not.toContain('/session resume');
  });

  test('does not surface the notice before onboarding is complete', () => {
    const shellPaths = makeShellPaths();
    writeLastSessionPointer('user-relaunch-1', { surface: makeSurface(shellPaths) });

    const { printed } = runStartupCapturingResumeNotice(shellPaths, [
      { name: 'user-relaunch-1', title: 'x', timestamp: Date.now(), messageCount: 1 },
    ]);

    // Onboarding takes precedence; the resume branch never runs.
    expect(printed).toEqual([]);
  });

  test('the explicit `sessions resume` CLI path never also prints the ambient notice', () => {
    const shellPaths = makeShellPaths();
    completeOnboarding(shellPaths);
    writeLastSessionPointer('user-relaunch-1', { surface: makeSurface(shellPaths) });

    const printed: string[] = [];
    const input = { prompt: '', cursorPos: 0, openAgentWorkspace: () => {} } as unknown as InputHandler;
    const commandRegistry = new CommandRegistry();
    const resumeCalls: string[][] = [];
    commandRegistry.register({
      name: 'session',
      description: 'stub',
      usage: '',
      handler: async (args) => { resumeCalls.push(args); },
    });
    const commandContext = {
      print: (text: string) => printed.push(text),
      session: { sessionManager: { list: () => [] } },
    } as unknown as CommandContext;

    applyInitialTuiCliState({
      cli: makeCli({ command: 'sessions', commandArgs: ['resume', 'user-relaunch-1'] }),
      input,
      commandRegistry,
      commandContext,
      shellPaths,
      surface: makeSurface(shellPaths),
      render: () => {},
    });

    // The explicit path routes straight into the existing resume command,
    // it does not also print the ambient relaunch notice.
    expect(printed).toEqual([]);
    expect(resumeCalls).toEqual([['resume', 'user-relaunch-1']]);
  });
});

describe('interactive TUI terminal guard', () => {
  test('allows launch when stdin and stdout are TTY streams', () => {
    expect(getInteractiveTerminalLaunchError({
      binary: 'goodvibes-agent',
      stdinIsTTY: true,
      stdoutIsTTY: true,
    })).toBeNull();
  });

  test('returns a plain non-TTY error before renderer startup', () => {
    const message = getInteractiveTerminalLaunchError({
      binary: 'goodvibes-agent',
      stdinIsTTY: false,
      stdoutIsTTY: false,
    });

    expect(message).toContain('requires an interactive terminal');
    expect(message).toContain('stdin and stdout are not a TTY');
    expect(message).toContain('goodvibes-agent status --json');
    expect(message).not.toContain('\x1b[');
  });
});

describe('fatal TUI startup formatting', () => {
  test('renders permission errors without stack traces', () => {
    const error = Object.assign(new Error("EACCES: permission denied, mkdir '/work'"), {
      code: 'EACCES',
      path: '/work',
      syscall: 'mkdir',
    });

    const message = formatFatalStartupErrorForUser(error, { binary: 'goodvibes-agent' });

    expect(message).toContain('could not prepare its local workspace or log directory');
    expect(message).toContain('path: /work');
    expect(message).toContain('goodvibes-agent --cd <dir>');
    expect(message).not.toContain('at ');
    expect(message).not.toContain('Error: EACCES');
  });

  test('keeps stack traces available only in explicit debug mode', () => {
    const error = new Error('startup failed');

    const normal = formatFatalStartupErrorForUser(error, { binary: 'goodvibes-agent' });
    const debug = formatFatalStartupErrorForUser(error, { binary: 'goodvibes-agent', debug: true });

    expect(normal).toBe('startup failed\nSet GOODVIBES_AGENT_DEBUG=1 to print a stack trace.');
    expect(debug).toContain('Error: startup failed');
    expect(debug).toContain('at ');
  });
});
