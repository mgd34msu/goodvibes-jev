import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { channelApprovalReply, channelApprovalTarget } from './batteries/approval-reply.js';
import { surfaceControl } from './batteries/surface-control.js';

/** Channel-owner replies and surface control semantics, calibrated independently. */
export const registry = new BatteryRegistry();
registry.register(channelApprovalReply);
registry.register(channelApprovalTarget);

registry.register(surfaceControl);
