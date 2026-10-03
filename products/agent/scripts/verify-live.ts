#!/usr/bin/env bun
import {
  buildLiveVerificationReport,
  renderLiveVerificationReportMarkdown,
  writeLiveVerificationReportFiles,
} from '../src/verification/live-verifier.ts';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function readArgValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

const args = process.argv.slice(2);
const connectedHostBaseUrl = readArgValue(args, '--connected-host-url')
  ?? readArgValue(args, '--runtime-url')
  ?? readArgValue(args, '--daemon-url');

if (args.includes('--help') || args.includes('-h')) {
  console.log([
    'Usage: bun run scripts/verify-live.ts [options]',
    '',
    'Options:',
    '  --home <path>        GoodVibes home directory. Defaults to ~/.goodvibes.',
    '  --binary <path>      Compiled goodvibes-agent binary. Defaults to dist/goodvibes-agent.',
    '  --connected-host-url <url>',
    '                      Connected host base URL. Defaults to configured control-plane port on 127.0.0.1.',
    '  --runtime-url <url> Alias for --connected-host-url.',
    '  --strict            Treat warnings as failures.',
    '  --json              Print JSON instead of Markdown.',
    '  --out <dir>         Write live-verification.{json,md} to a directory.',
    '  --help              Show this help.',
  ].join('\n'));
  process.exit(0);
}

const report = await buildLiveVerificationReport({
  homeDir: readArgValue(args, '--home') ?? process.env.GOODVIBES_HOME ?? join(homedir(), '.goodvibes'),
  binaryPath: readArgValue(args, '--binary') ?? join(resolve(join(import.meta.dir, '..')), 'dist', 'goodvibes-agent'),
  projectRoot: resolve(join(import.meta.dir, '..')),
  connectedHostBaseUrl,
  strict: args.includes('--strict'),
});

const outputDir = readArgValue(args, '--out');
if (outputDir) {
  writeLiveVerificationReportFiles(report, outputDir);
}

console.log(args.includes('--json')
  ? JSON.stringify(report, null, 2)
  : renderLiveVerificationReportMarkdown(report));

process.exit(report.ok ? 0 : 1);
