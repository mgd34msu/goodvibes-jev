/** Verify the installed account's Jev connection before declaring setup complete. */
import { resolve } from 'node:path';
import { JudgmentError } from '../packages/judgment/dist/index.js';
import { ConfigManager } from '../packages/engine/sdk/dist/platform/config/manager.js';
import { createRuntimeSecretsManager } from '../packages/engine/sdk/dist/platform/runtime/secrets-composition.js';
import { createSettingsJudgmentPort } from '../packages/engine/sdk/dist/platform/runtime/judgment-services.js';

try {
  const homeDirectory = resolve(process.argv[2]!);
  const config = new ConfigManager({ homeDir: homeDirectory, workingDir: homeDirectory, surfaceRoot: 'tui', readOnly: true });
  const secrets = createRuntimeSecretsManager({ projectRoot: homeDirectory, globalHome: homeDirectory, surfaceRoot: 'tui',
    configManager: config, daemonHome: resolve(homeDirectory, '.goodvibes/daemon') });
  const port = createSettingsJudgmentPort({ config, secrets, env: process.env });
  await port.ask({ state: 'The GoodVibes installation is checking its connection to Jev.',
    questions: { connected: { type: 'noul', instructions: 'Does the state describe an installation checking its connection?' } },
    signal: AbortSignal.timeout(30_000) });
  console.log('Jev connection verified (jev-latest).');
} catch (error) {
  const next = error instanceof JudgmentError && error.status === 402
    ? 'Add credits or update billing for the TypeSafe account at https://console.typesafe.ai/settings/billing.'
    : 'Check the Jev endpoint and TYPESAFE_API_KEY in the installation environment file.';
  console.error(`Jev setup failed: ${error instanceof Error ? error.message : String(error)}. ${next}`);
  process.exitCode = 1;
}
