import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { cardField } from './batteries/card-field.js';
import { cardTalk } from './batteries/card-talk.js';
import { contentDerivation } from './batteries/content-derivation.js';
import { linkHost } from './batteries/link-host.js';

/**
 * Every named decision the security layer makes, for calibration:
 *
 *   bun run --cwd packages/judgment calibrate --registry ../engine/sdk/src/platform/security/judgment-registry.ts
 */
export const registry = new BatteryRegistry();

registry.register(contentDerivation);
registry.register(cardField);
registry.register(cardTalk);
registry.register(linkHost);
