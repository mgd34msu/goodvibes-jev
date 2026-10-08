/**
 * CLI barrel for the daemon product.
 *
 * Two halves, deliberately separable:
 *   - `command-catalog.ts` is WHAT this binary understands, every command,
 *     alias, flag and help string, as data.
 *   - `parser.ts`, `help.ts` and `completion.ts` are the ENGINE that reads a
 *     catalog and produces a parse, a help page or a completion script. None of
 *     them names a daemon command.
 *
 * The argument surface a `goodvibes` front-end shares, the parse engine's
 * catalog contract, redaction, config overrides, settings-value reading and
 * endpoint resolution, is @goodvibes-jev/engine/terminal-shell's, imported at the
 * point of use. What stays here is what only this binary has: its own command
 * vocabulary, and the help and completion built on it.
 */
export * from './types.ts';
export * from './command-catalog.ts';
export * from './parser.ts';
export * from './help.ts';
export * from './completion.ts';
export { runDaemonCli, type DaemonCliOptions } from './run.js';
export type { DaemonCliRuntime } from './serve.js';
export { createSlackDaemonInboxFactory, createSlackDaemonInboxSourceFactory } from '../runtime/slack-inbox-composition.js';
export type { SlackDaemonInboxOptions, SlackDaemonInboxFactories, SlackDaemonInboxSourceFactories } from '../runtime/slack-inbox-composition.js';

export { createEmailDaemonInboxFactory, createEmailDaemonInboxSourceFactory } from '../runtime/email-inbox-composition.js';
export type { EmailDaemonInboxOptions, EmailDaemonInboxFactories, EmailDaemonInboxSourceFactories } from '../runtime/email-inbox-composition.js';

export { createMultiOwnerDaemonInboxFactory } from '../runtime/multiowner-inbox-composition.js';
export type { DaemonInboxSourceFactory } from '../runtime/multiowner-inbox-composition.js';
