import { parseGoodVibesCli } from './parser.ts';
import { renderCompletion } from './completion.ts';
import { renderGoodVibesCommandHelp, renderGoodVibesHelp, renderGoodVibesVersion } from './help.ts';

export type MetadataCliResult = { readonly stdout?: string; readonly stderr?: string; readonly exitCode: number };

/** Preserve the normal CLI parser and help precedence without runtime setup. */
export function metadataCliResult(argv: readonly string[], binary = 'goodvibes-agent'): MetadataCliResult | null {
  const cli = parseGoodVibesCli(argv, binary);
  if (cli.errors.length > 0) return { stderr: `${cli.errors.join('\n')}\n\n${renderGoodVibesHelp(binary)}`, exitCode: 2 };
  if (cli.flags.help || cli.command === 'help') {
    const topic = cli.command === 'help' ? cli.commandArgs[0] : cli.rawCommand ?? undefined;
    return { stdout: topic ? renderGoodVibesCommandHelp(topic, binary) : renderGoodVibesHelp(binary), exitCode: 0 };
  }
  if (cli.flags.version || cli.command === 'version') return { stdout: renderGoodVibesVersion(binary), exitCode: 0 };
  if (cli.command === 'completion') return { stdout: renderCompletion(cli.commandArgs[0], binary), exitCode: 0 };
  return null;
}
