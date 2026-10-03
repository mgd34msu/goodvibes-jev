#!/usr/bin/env bun
import { metadataCliResult } from './cli/metadata.ts';
import { writeExitingStdoutLine, writeFatalLine } from './utils/fatal-boot-write.ts';

// Informational CLI commands need no runtime, profile, provider, or terminal.
// Load the interactive and management graph only after parsing those commands.
const result = metadataCliResult(process.argv.slice(2));
if (result) {
  if (result.stdout) writeExitingStdoutLine(result.stdout);
  if (result.stderr) writeFatalLine(result.stderr);
  process.exit(result.exitCode);
}
await import('./interactive.ts');
