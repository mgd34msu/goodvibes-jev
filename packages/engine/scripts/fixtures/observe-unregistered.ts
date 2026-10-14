import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** Deliberately unregistered negative fixture: observe must report this call. */
export const unregisteredProbe = defineBattery({
  name: 'proof.unregistered-probe',
  version: 1,
  description: 'A decision outside every registry, to prove observe reports unregistered calls.',
  accuracyFloor: 0.5,
  items: { question: yesNo('Does this message ask for help?', STAKES_BANDS.low.yesNo) },
  fixtures: [{ name: 'asks', state: 'Can you help me reset my password?', expect: { question: 'yes' } }],
});
