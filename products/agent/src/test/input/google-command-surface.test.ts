/**
 * The agent half of the Google-flow command contract.
 *
 * The SDK names commands in its error and help text; this repo is what makes
 * those names resolve. The defect that makes this file necessary: an error
 * told the owner to re-authorize by running a `/google setup` variant, and the
 * command surface answered "Unknown setup item google". The command existed
 * and the subcommand did not, so the sentence was authoritative and wrong. Five
 * more attempts died the same way on "Unknown setting calendar".
 *
 * So the SDK publishes `GOOGLE_REFERENCED_COMMANDS`, every invocation it names,
 * command AND subcommand, and this test walks that list against the real
 * registry, built by the real registration functions. A dead pointer on either
 * side goes red here.
 */

import { describe, expect, test } from 'bun:test';
import { GOOGLE_REFERENCED_COMMANDS } from '@goodvibes-jev/engine/sdk/platform/google';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerGoogleRuntimeCommands } from '../../input/commands/google-runtime.ts';

/** The registry with the Google command actually registered on it. */
function googleRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registerGoogleRuntimeCommands(registry);
  return registry;
}

/**
 * Subcommands a command declares it handles.
 *
 * Read from `argsHint`, which is the registry's own machine-readable list and
 * the same string the completion surface offers. A subcommand missing from it
 * is invisible to the user even when the handler would accept it.
 */
function declaredSubcommands(registry: CommandRegistry, name: string): readonly string[] {
  const command = registry.get(name);
  if (command === undefined) return [];
  return (command.argsHint ?? '').split('|').map((entry) => entry.trim()).filter(Boolean);
}

describe('every command the Google flow names actually resolves', () => {
  const registry = googleRegistry();

  test('the /google command is registered at all', () => {
    expect(registry.get('google')).toBeDefined();
  });

  test('every /google invocation named in SDK text is a subcommand /google handles', () => {
    const handled = declaredSubcommands(registry, 'google');
    const missing: string[] = [];

    for (const invocation of GOOGLE_REFERENCED_COMMANDS) {
      const [command, sub] = invocation.slice(1).split(' ');
      if (command !== 'google' || sub === undefined) continue;
      if (!handled.includes(sub)) missing.push(invocation);
    }

    expect(missing).toEqual([]);
  });

  test('the commands the incident named by hand are all present', () => {
    // Named explicitly rather than only through the list, so deleting an entry
    // from the SDK list cannot quietly delete its coverage here too.
    const handled = declaredSubcommands(registry, 'google');
    for (const sub of ['connect', 'status', 'reauthorize', 'forget', 'adopt']) {
      expect(handled).toContain(sub);
    }
  });

  test('the usage text and the declared subcommands agree', () => {
    // A subcommand handled but absent from usage is one nobody finds; one in
    // usage but not handled is the dead pointer this file exists for.
    const command = registry.get('google');
    const usage = command?.usage ?? '';
    for (const sub of declaredSubcommands(registry, 'google')) {
      expect(usage).toContain(sub);
    }
  });

  test('/email and /calendar invocations name subcommands those commands take', async () => {
    // Registered by their own modules, so this builds the pair it needs rather
    // than the whole shell.
    const { registerEmailRuntimeCommands } = await import('../../input/commands/email-runtime.ts');
    const { registerCalendarRuntimeCommands } = await import('../../input/commands/calendar-runtime.ts');
    const full = googleRegistry();
    registerEmailRuntimeCommands(full);
    registerCalendarRuntimeCommands(full);

    const missing: string[] = [];
    for (const invocation of GOOGLE_REFERENCED_COMMANDS) {
      const [command, sub] = invocation.slice(1).split(' ');
      if (command === 'google' || sub === undefined) continue;
      const registered = full.get(command);
      if (registered === undefined) {
        missing.push(`${invocation}: /${command} is not registered`);
        continue;
      }
      const text = `${registered.usage ?? ''} ${registered.argsHint ?? ''}`;
      if (!text.includes(sub)) missing.push(`${invocation}: /${command} does not offer "${sub}"`);
    }

    expect(missing).toEqual([]);
  });
});
