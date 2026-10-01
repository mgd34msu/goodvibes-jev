import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { channelApprovalReply, channelApprovalTarget } from './batteries/approval-reply.js';

/** Channel-owner approval semantics and target selection, calibrated independently. */
export const registry = new BatteryRegistry();
registry.register(channelApprovalReply);
registry.register(channelApprovalTarget);
