import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { channelApprovalReply, channelApprovalTarget } from './batteries/approval-reply.js';
import { surfaceControl } from './batteries/surface-control.js';
import { inboundIntent, workProposalReply } from './batteries/conversation-gate.js';

/** Independent named batteries for channel replies, work start and surface control. */
export const registry = new BatteryRegistry();
registry.register(channelApprovalReply);
registry.register(channelApprovalTarget);

registry.register(surfaceControl);

registry.register(inboundIntent);
registry.register(workProposalReply);
