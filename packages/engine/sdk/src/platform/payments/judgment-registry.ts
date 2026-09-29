import { BatteryRegistry } from '@goodvibes-jev/judgment';
import { merchantReading } from './batteries/merchant.js';
import { recurringCharge } from './batteries/recurring-charge.js';
import { cartLine } from './batteries/cart-line.js';
import { shippingFast, shippingFastest, shippingStandard } from './batteries/shipping-tier.js';
import { approvalReply, vetoReply } from './batteries/payment-reply.js';
import { orderMail, orderNumber, shipDate, trackingReference } from './batteries/confirmation.js';
import { securityCodeReply } from './batteries/security-code-reply.js';

/**
 * Every named decision the payments capability makes, for calibration:
 *
 *   bun run --cwd packages/judgment calibrate --registry ../engine/sdk/src/platform/payments/judgment-registry.ts
 *
 * The purchase taint check reads through the security registry's
 * `engine.security.content-derivation`, and card details on a remote channel
 * through its `engine.security.card-talk`; both are calibrated there.
 */
export const registry = new BatteryRegistry();

registry.register(merchantReading);
registry.register(recurringCharge);
registry.register(cartLine);
registry.register(shippingStandard);
registry.register(shippingFast);
registry.register(shippingFastest);
registry.register(approvalReply);
registry.register(vetoReply);
registry.register(orderMail);
registry.register(orderNumber);
registry.register(trackingReference);
registry.register(shipDate);
registry.register(securityCodeReply);
