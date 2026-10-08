import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { commandRankBattery, daemonRefusalBattery, statusToneBattery, mailReplySubjectBattery } from './webui-specs.js';

/** Calibration and lint discovery; HTTP admission remains a separate registry. */
export const registry = new BatteryRegistry();
registry.register(daemonRefusalBattery);
registry.register(statusToneBattery);
registry.register(commandRankBattery);
registry.register(mailReplySubjectBattery);
