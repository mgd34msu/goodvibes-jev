// Compatibility wrapper for older imports. New CLI code lives in src/cli.
export type { GoodVibesCliFlags as CliFlags } from '@goodvibes-jev/engine/terminal-shell';
export {
  applyRuntimeConfigDefault,
  applyRuntimeConfigOverrides,
  applyRuntimeConfigValue,
  applyRuntimeCommandEndpointFlagOverrides,
  applyRuntimeEndpointFlagOverrides,
  applyRuntimeFeatureFlagOverrides,
  handleGoodVibesCliCommand,
  parseGoodVibesCli,
  renderGoodVibesCommandHelp,
  renderGoodVibesHelp,
  renderGoodVibesVersion,
} from './cli/index.ts';

import { parseGoodVibesCli } from '@goodvibes-jev/engine/terminal-shell';
import type { GoodVibesCliFlags } from '@goodvibes-jev/engine/terminal-shell';

export function parseCliFlags(argv: readonly string[], binary = 'goodvibes'): GoodVibesCliFlags {
  return parseGoodVibesCli(argv, binary).flags;
}
