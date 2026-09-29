#!/usr/bin/env node
/**
 * Dispatcher bin, `goodvibes-toolchain <tool> [flags]`: runs one toolchain
 * tool by name.
 *
 * It began as the route for `bunx <toolchain package> <tool>`, when the
 * toolchain was its own package: bunx resolves the bin named after the
 * package's final path segment, and without this dispatcher it silently fell
 * back to the FIRST bin in the map (sdk-pin-gate) with the intended tool name
 * as a stray argument. The toolchain now ships inside @goodvibes-jev/engine,
 * whose bins include this one; every tool also stays directly invocable by
 * its own `goodvibes-*` bin name.
 *
 * The tool argument accepts both the bare tool name (`per-job-green`) and the
 * bin-prefixed form (`goodvibes-per-job-green`) so existing invocation
 * strings work unchanged.
 */
const TOOLS: Record<string, string> = {
  'sdk-pin-gate': './sdk-pin-gate.js',
  'build-binaries': './build-binaries.js',
  'release-cut': './release-cut.js',
  'coverage-gate': './coverage-gate.js',
  'verification-ledger': './verification-ledger.js',
  'post-build-smoke': './post-build-smoke.js',
  'package-install-check': './package-install-check.js',
  'publish-package': './publish-package.js',
  'per-job-green': './per-job-green.js',
  'changelog-gate': './changelog-gate.js',
  'sha256sums': './sha256sums.js',
  'train-status': './train-status.js',
};

const [tool, ...rest] = process.argv.slice(2);
const key = tool?.replace(/^goodvibes-/, '') ?? '';
const target = TOOLS[key];

if (!target) {
  const usage = [
    `goodvibes-toolchain: ${tool ? `unknown tool '${tool}'` : 'a tool name is required'}.`,
    'Usage: goodvibes-toolchain <tool> [flags]',
    `Tools: ${Object.keys(TOOLS).join(', ')}`,
  ].join('\n');
  console.error(usage);
  process.exit(2);
}

// Tool bins read flags positionally from process.argv; splice the dispatcher
// hop out so their view is identical to a direct bin invocation.
process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
await import(target);
