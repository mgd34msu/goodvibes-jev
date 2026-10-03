import { appendFileSync } from 'node:fs';
import { NETWORK_VIOLATIONS_ENV } from './test-isolation.js';
import { installTestNetworkGuard } from './test-network-guard.js';

const path = process.env[NETWORK_VIOLATIONS_ENV];
installTestNetworkGuard((diagnostic) => {
  // The runner checks this even when production code caught the request error.
  if (path !== undefined) appendFileSync(path, `${diagnostic}\n`, 'utf8');
});
