import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { entityAlias } from '../batteries/entity-alias.js';

export const registry = new BatteryRegistry();
registry.register(entityAlias);
