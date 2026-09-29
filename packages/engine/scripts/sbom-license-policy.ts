// sbom-license-policy.ts: fails (exit 1) when a component in the SBOM carries
// an AGPL, GPL, LGPL or SSPL license. The policy and how each kind of license
// entry is checked live in scripts/ci-readings/license-names.ts; free-text
// license names are checked against stored Jev readings, offline.
//
//   bun packages/engine/scripts/sbom-license-policy.ts [sbom.cdx.json]

import { readFileSync } from 'node:fs';
import { copyleftLicense } from './ci-readings/copyleft-license.ts';
import { licenseOffenders, READINGS_PATH, type Sbom } from './ci-readings/license-names.ts';
import { currentReadings } from './ci-readings/stored-readings.ts';

const sbomPath = process.argv[2] ?? 'sbom.cdx.json';
const sbom = JSON.parse(readFileSync(sbomPath, 'utf8')) as Sbom;

const offenders = licenseOffenders(sbom, currentReadings(READINGS_PATH, copyleftLicense));
if (offenders.length > 0) {
  console.error(`Blocked license(s):\n${offenders.join('\n')}`);
  process.exit(1);
}

console.log('License policy OK');
