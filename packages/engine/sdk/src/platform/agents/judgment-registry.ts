import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { inboundIntent, proposalReply } from './conversation-reading.js';
export const registry = new BatteryRegistry();
registry.register(inboundIntent);
registry.register(proposalReply);


import { connectorCapability } from './connector-reading.js';
registry.register(connectorCapability);
