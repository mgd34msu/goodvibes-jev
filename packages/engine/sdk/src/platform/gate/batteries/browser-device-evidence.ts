import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

export const browserDeviceEvidence = defineBattery({
  name: 'agent.browser-device.evidence',
  version: 2,
  description: 'Read the mobile, PWA, or device capability supported by one complete published record.',
  accuracyFloor: 0.95,
  items: {
    supported: yesNo(
      'Does the complete published record provide the requested capability? kind mobile-touch asks whether its category route supports mobile touch controls. kind pwa-runtime asks whether its category route or first-run receipt provides installable or offline PWA runtime behavior. kind device-capability asks whether the certified record provides requestedCapability in the sense explained by requestedTerms. A capability group such as camera-location-sensors is an umbrella: a record providing any one member (for example capturing device images) supports that group; it need not provide every member. Read the whole record, including limitations, negation, availability and permission scope. Mentioning mobile, touch, responsive, manifest, install, offline, service worker, or a device capability does not establish support. Caller terms explain the requested capability, not a substring rule. An unrelated capability is no. Incomplete or conflicting evidence is uncertain. This reading grants no permission and does not certify the publication schema.',
      STAKES_BANDS.medium.yesNo,
    ),
  },
  fixtures: [
    { name: 'thumb controls without a mobile keyword', state: { kind: 'mobile-touch', record: { summary: 'The narrow-screen route exposes large controls usable with thumbs.' } }, expect: { supported: 'yes' } },
    { name: 'mobile words with explicit unsupported behavior', state: { kind: 'mobile-touch', record: { summary: 'Mobile and touch support are unavailable; this route requires a desktop pointer.' } }, expect: { supported: 'no' } },
    { name: 'installed web operation without connectivity', state: { kind: 'pwa-runtime', record: { summary: 'After the first visit the installed web application keeps working without connectivity.' } }, expect: { supported: 'yes' } },
    { name: 'PWA words describe absent functionality', state: { kind: 'pwa-runtime', record: { summary: 'The manifest is missing and no service worker or offline installation is supported.' } }, expect: { supported: 'no' } },
    { name: 'device images with an opaque capability id', state: { kind: 'device-capability', requestedCapability: 'camera-location-sensors', requestedTerms: ['camera', 'location'], record: { capabilityId: 'optical-source', summary: 'The permission-scoped route captures images from the paired device.' } }, expect: { supported: 'yes' } },
    { name: 'camera help is not camera capability', state: { kind: 'device-capability', requestedCapability: 'camera-location-sensors', requestedTerms: ['camera', 'location'], record: { capabilityId: 'camera-help', summary: 'Camera and location are unsupported; this route only displays setup guidance.' } }, expect: { supported: 'no' } },
  ],
});
