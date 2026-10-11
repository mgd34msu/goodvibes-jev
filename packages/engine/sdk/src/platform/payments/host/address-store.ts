import { PostalAddressHeldError, type PostalReadOptions, type PreparedPostalAddress } from '../../config/postal-address.js';
/**
 * address-store.ts, the stored shipping and billing addresses, read from
 * config.
 *
 * The SDK's `platform/config/schema-domain-payments.ts` already declares flat
 * `payments.shippingAddress.*` / `payments.billingAddress.*` keys (name,
 * line1, line2, city, region, postalCode, country each), settable through the
 * owner profile and the settings surfaces; address.ts's own header names the
 * defect this closes: "nothing in the checkout path read either." This is
 * that read path, the daemon-owned counterpart to `DaemonCardStore` for the
 * OTHER thing a checkout needs supplied rather than typed by the model.
 *
 * A field that is present but blank reads as absent (`''` is not a value any
 * of these fields can honestly hold), so a half-set address is reported the
 * same way a wholly-unset one is: `AddressStore.read` returns the address with
 * whatever is there, and `checkAddress` (address.ts) is what decides whether
 * that is complete enough to ship to, exactly as it already does for the SDK's
 * own test doubles. Nothing here validates completeness; this module only
 * reads what config holds.
 */
import type { AddressKind, AddressStore } from '../address.js';
import type { PaymentsConfigReader } from '../payments-config.js';
import type { PostalAddress } from '../types.js';

function readAddressField(config: PaymentsConfigReader, kind: AddressKind, field: string): string {
  const value = config.get(`payments.${kind}Address.${field}`);
  return typeof value === 'string' ? value.trim() : '';
}

/** Every field blank means "nothing stored", read back as `null` rather than an all-empty address. */
function isEntirelyBlank(address: PostalAddress): boolean {
  return address.name === ''
    && address.line1 === ''
    && address.line2 === ''
    && address.city === ''
    && address.region === ''
    && address.postalCode === ''
    && address.country === '';
}

export function configBackedAddressStore(
  config: PaymentsConfigReader,
  preparePostalAddress?: ((kind: AddressKind, options?: PostalReadOptions) => Promise<PreparedPostalAddress>) | undefined,
): AddressStore {
  if (preparePostalAddress) return {
    async read(kind, options) { const prepared = await preparePostalAddress(kind, options); prepared.assertCurrent(); return prepared.value; },
    async prepare(kinds, options = {}) {
      const captured = new Map<AddressKind, PreparedPostalAddress>();
      for (const kind of new Set(kinds)) {
        for (const value of captured.values()) value.assertCurrent();
        captured.set(kind, await preparePostalAddress(kind, options));
      }
      const assertCurrent = () => { options.signal?.throwIfAborted(); for (const value of captured.values()) value.assertCurrent(); };
      assertCurrent();
      return Object.freeze({ assertCurrent, async read(kind: AddressKind) {
        assertCurrent(); const value = captured.get(kind);
        if (!value) throw new PostalAddressHeldError();
        return value.value;
      } });
    },
  };
  // Compatibility for explicitly supplied config-only stores. Real daemon
  // composition supplies the prepared reader; a profile-backed get holds.

  return {
    async read(kind: AddressKind): Promise<PostalAddress | null> {
      const address: PostalAddress = {
        name: readAddressField(config, kind, 'name'),
        line1: readAddressField(config, kind, 'line1'),
        line2: readAddressField(config, kind, 'line2'),
        city: readAddressField(config, kind, 'city'),
        region: readAddressField(config, kind, 'region'),
        postalCode: readAddressField(config, kind, 'postalCode'),
        country: readAddressField(config, kind, 'country'),
      };
      return isEntirelyBlank(address) ? null : address;
    },
  };
}
