/**
 * `engine.gates.copyleft-license`: whether a free-text license name in the
 * SBOM denotes an AGPL, GPL, LGPL or SSPL license. It replaces the anchored
 * prefix test scripts/sbom-license-policy.ts applied to `license.name`, which
 * only matched a name spelled like an SPDX id: "GNU General Public License v3"
 * passed it.
 *
 * `license.id` stays the prefix test (an SPDX id is a fixed format), and an
 * `expression` is parsed as an SPDX expression with every id tested; only the
 * free-text name is read here.
 *
 * Read by `bun run license-names:read` for every distinct license name in the
 * SBOM; the readings are stored by content hash in
 * etc/copyleft-license-readings.json, and the offline policy passes a name
 * only on a stored, settled no.
 *
 * State: `{ license }`, the license name text. The component carrying it is
 * not part of the state: what a license name denotes does not depend on which
 * package declares it, and keying by the name alone keeps a reading valid
 * across version bumps.
 *
 * Band: high stakes. A wrong no lets a copyleft dependency ship to
 * closed-source consumers, a legal exposure; a wrong yes only blocks a release
 * for a person to review.
 */
import { defineBattery, PINNED_MODEL, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** A type alias rather than an interface, so it is assignable to the port's JSON state type. */
export type CopyleftLicenseState = {
  readonly license: string;
};

export const copyleftLicense = defineBattery({
  name: 'engine.gates.copyleft-license',
  version: 1,
  description: 'Whether a free-text SBOM license name denotes an AGPL, GPL, LGPL or SSPL license.',
  accuracyFloor: 0.9,
  // Pinned: the stored readings and the band were read and tuned on this model.
  model: PINNED_MODEL,
  items: {
    copyleft: yesNo(
      'Does the license name `license` denote a GNU Affero General Public License (AGPL), GNU General Public License (GPL), GNU Lesser or Library General Public License (LGPL), or Server Side Public License (SSPL), of any version? A permissive license (MIT, BSD, Apache, ISC), a file-level copyleft license (MPL, EPL, CDDL), or a public-domain dedication is not.',
      STAKES_BANDS.high.yesNo,
    ),
  },
  fixtures: [
    { name: 'GPL full name', state: { license: 'GNU General Public License v3.0' }, expect: { copyleft: 'yes' } },
    { name: 'GPL short spelling', state: { license: 'GPLv2 or later' }, expect: { copyleft: 'yes' } },
    { name: 'LGPL full name', state: { license: 'GNU Lesser General Public License, version 2.1' }, expect: { copyleft: 'yes' } },
    { name: 'AGPL', state: { license: 'Affero GPL 3' }, expect: { copyleft: 'yes' } },
    { name: 'SSPL', state: { license: 'Server Side Public License, v 1' }, expect: { copyleft: 'yes' } },
    { name: 'MIT', state: { license: 'The MIT License' }, expect: { copyleft: 'no' } },
    { name: 'Apache', state: { license: 'Apache License, Version 2.0' }, expect: { copyleft: 'no' } },
    { name: 'BSD', state: { license: 'BSD 3-Clause "New" or "Revised" License' }, expect: { copyleft: 'no' } },
    { name: 'MPL is file-level', state: { license: 'Mozilla Public License 2.0' }, expect: { copyleft: 'no' } },
    { name: 'public domain', state: { license: 'Public Domain (Unlicense)' }, expect: { copyleft: 'no' } },
  ],
});
