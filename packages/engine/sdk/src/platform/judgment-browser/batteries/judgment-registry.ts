import { speechSeamsBattery } from './speech-seams.js';
import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { catalogProviderMatchBattery, cardMaterialKeyBattery, commandRankBattery, daemonRefusalBattery, statusToneBattery, mailReplySubjectBattery, installPlatformBattery, credentialProviderBattery, codeLanguageBattery } from './webui-specs.js';

/** Calibration and lint discovery; HTTP admission remains a separate registry. */
export const registry = new BatteryRegistry();
registry.register(daemonRefusalBattery);
registry.register(statusToneBattery);
registry.register(commandRankBattery);
registry.register(mailReplySubjectBattery);
registry.register(installPlatformBattery);
registry.register(credentialProviderBattery);
registry.register(codeLanguageBattery);
registry.register(speechSeamsBattery);
registry.register(cardMaterialKeyBattery);
registry.register(catalogProviderMatchBattery);
