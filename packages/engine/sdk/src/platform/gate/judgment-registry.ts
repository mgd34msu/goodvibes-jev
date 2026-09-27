import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { riskFamily } from './batteries/risk-family.js';
import { sandboxAdvisory } from './batteries/sandbox-advisory.js';
import { sideEffect } from './batteries/side-effect.js';

/**
 * Every named decision the gate makes, for calibration:
 *
 *   bun run --cwd packages/judgment calibrate --registry ../engine/sdk/src/platform/gate/judgment-registry.ts
 */
export const registry = new BatteryRegistry();

registry.register(riskFamily);
registry.register(sideEffect);
registry.register(sandboxAdvisory);

import { editTarget } from '../tools/batteries/edit-target.js';
import { contentRank } from '../tools/batteries/content-rank.js';
import { registryRank } from '../tools/batteries/registry-rank.js';

registry.register(editTarget);
registry.register(contentRank);
registry.register(registryRank);
