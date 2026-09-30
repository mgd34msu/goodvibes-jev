import type { DaemonCommand } from './command-catalog.ts';

/**
 * Everything a parse can produce.
 *
 * One record for every command, rather than a discriminated union per command:
 * the fields a command does not use are simply left at their empty value, and
 * the catalog is what decides which flags could have set them. A command's
 * dispatcher reads only the fields its own catalog entry declares.
 *
 * Fields describing starting or resuming a conversation, prompt, print,
 * outputFormat, noAltScreen, open, continueLast, resume, session, fork,
 * strict, are not here. This binary does not start or resume conversations,
 * so those flags are parsed, stored, and read by nothing. See
 * REJECTED_TERMINAL_FLAGS in ./command-catalog.ts for the refusal that
 * replaced them.
 */
export interface DaemonCliFlags {
  readonly daemonHome: string | undefined;
  readonly workingDir: string | undefined;
  readonly help: boolean;
  readonly version: boolean;
  /** `--json`: print one JSON document instead of prose. */
  readonly json: boolean;
  /** `-y` / `--yes` / `--non-interactive`: consent to a destructive confirmation. */
  readonly yes: boolean;
  /** `update --check`: ask for an update check now. */
  readonly check: boolean;
  /** `sessions list --all`: include sessions that have already ended. */
  readonly all: boolean;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  /** `serve` only: the address to BIND. */
  readonly hostname: string | undefined;
  /** `serve`: the port to bind. Remote commands: the port to CALL. */
  readonly port: number | undefined;
  /** Remote commands only: the machine to call. */
  readonly host: string | undefined;
  /** Remote commands only: the operator token to authenticate with. */
  readonly token: string | undefined;
  readonly configOverrides: readonly string[];
  readonly enableFeatures: readonly string[];
  readonly disableFeatures: readonly string[];
}

export interface DaemonCliParseResult {
  readonly binary: string;
  /** Always resolved. A bare invocation is `serve`; an unrecognized word is an error. */
  readonly command: DaemonCommand;
  /** The word the operator actually typed, when they typed one. */
  readonly rawCommand: string | undefined;
  /**
   * Everything after the command word that is not a flag this parser owns. For
   * a passthrough command (`send`, `cluster`, `webui`, `provision-wake-model`)
   * it is every remaining token verbatim, flags included.
   */
  readonly commandArgs: readonly string[];
  readonly flags: DaemonCliFlags;
  /** Usage refusals. A non-empty list means exit 2 with these lines and the help. */
  readonly errors: readonly string[];
  /** Non-fatal notices. Printed, then the command runs. */
  readonly warnings: readonly string[];
}
