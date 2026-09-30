/** Authored readings for exact synthetic source spans, never a semantic classifier. */
export type RepairProfileFixtureValues = ReadonlyArray<readonly [string, string]>;
export type RepairUsefulFixtureValues = ReadonlyArray<readonly [string, string, string]>;
const display = 'Display and picture specifications';
const ports = 'Input and output ports';
const smart = 'Smart TV platform and integrations';
const network = 'Network and wireless capabilities';
const gaming = 'Gaming and HDMI features';
const audio = 'Audio capabilities';
const tuner = 'Tuner and broadcast support';

function values(fixtures: ReadonlyArray<readonly [string, readonly string[]]>): RepairProfileFixtureValues {
  return fixtures.flatMap(([text, categories]) => categories.map((category) => [category, text] as const));
}

export function repairProfileFixtureReading(name: string, state: unknown, fixtures: RepairProfileFixtureValues = []): number | undefined {
  if (name !== 'wanted' && name !== 'selected' && name !== 'profileSupported') return undefined;
  const input = state as { category: { title: string }; text: string; candidate?: { text: string } };
  const matches = fixtures.filter(([category]) => category === input.category.title);
  const yes = name === 'wanted'
    ? matches.some(([, text]) => input.text.includes(text))
    : matches.some(([, text]) => input.candidate?.text === text);
  return yes ? 0.99 : 0.01;
}

export function repairUsefulFixtureReading(state: unknown, profiles: RepairProfileFixtureValues = [], claims: RepairUsefulFixtureValues = []): number {
  const input = state as { fact: { title: string; summary?: string; value?: string }; evidence: readonly { text: string }[] };
  const supported = (text: string) => input.evidence.some((entry) => entry.text.includes(text));
  const profile = profiles.some(([title, text]) => input.fact.title === title && input.fact.summary === `${title}: ${text}`
    && input.fact.value === text && supported(text));
  const claim = claims.some(([title, summary, text]) => input.fact.title === title && input.fact.summary === summary && supported(text));
  return profile || claim ? 0.99 : 0.01;
}

export const semanticRepairProfileValues = values([
  ['The Living Room TV supports Dolby Vision and includes four HDMI ports.', [display, ports]],
  ['LG 86NANO90UNA features include NanoCell 4K display, HDR10, Dolby Vision, HDMI eARC, webOS, and Game Optimizer.', [display, ports, smart, gaming]],
  ['LG 86NANO90UNA specifications include a 4K UHD NanoCell display, 120 Hz refresh rate, HDR10, Dolby Vision, HDMI eARC, webOS smart TV features, Wi-Fi, Bluetooth, 2 x 10W speakers, and Game Optimizer.', [display, ports, smart, network, gaming, audio]],
  ['LG 86NANO90UNA specifications include a 4K UHD NanoCell display, 120 Hz refresh rate, HDR10 and Dolby Vision support, HDMI eARC, webOS smart TV features, Wi-Fi, Bluetooth, and USB connectivity.', [display, ports, smart, network]],
  ['The LG 86NANO90UNA supports HDMI eARC, HDR10, Dolby Vision, and webOS smart TV features.', [display, ports, smart]],
  ['LG 86NANO90UNA specifications include a 4K UHD NanoCell display, 120 Hz refresh rate, HDR10, Dolby Vision, HDMI eARC, webOS, Wi-Fi, and Bluetooth.', [display, ports, smart, network]],
  ['LG 86NANO90UNA specifications include NanoCell 4K display, 120 Hz refresh rate, HDR10, Dolby Vision, HDMI eARC, webOS, Wi-Fi, and Bluetooth.', [display, ports, smart, network]],
  ['LG 86NANO90UNA specifications include a NanoCell 4K display, Dolby Vision, HDR10, HDMI eARC, webOS smart TV features, Wi-Fi, Bluetooth, and Game Optimizer.', [display, ports, smart, network, gaming]],
  ['LG 86NANO90UNA specifications include an 86-inch 4K UHD NanoCell display, 120 Hz refresh rate, HDR10, Dolby Vision, HLG, HDMI eARC, USB ports, Ethernet, Wi-Fi, Bluetooth, webOS smart TV features, Apple AirPlay 2, HomeKit, FreeSync VRR, Game Optimizer, ATSC tuner support, and 2 x 10W speakers.', [display, ports, smart, network, gaming, audio, tuner]],
  ['LG 86NANO90UNA specifications include an 86-inch 4K NanoCell display, Dolby Vision HDR, HDR10, 120 Hz refresh rate, webOS smart TV features, Wi-Fi, Bluetooth, HDMI eARC, FreeSync VRR, ATSC tuner support, and 2 x 10W speakers.', [display, ports, smart, network, gaming, audio, tuner]],
]);

export const semanticRepairUsefulValues: RepairUsefulFixtureValues = [
  [display, 'Display and picture specifications: 4K UHD resolution, HDR10, Dolby Vision, and 120 Hz refresh rate.',
    'LG 86NANO90UNA specifications: Display and picture specifications: 4K UHD resolution, HDR10, Dolby Vision, and 120 Hz refresh rate.'],
  [ports, 'Input and output ports: HDMI inputs, HDMI eARC, USB ports, Ethernet, optical audio output, RF antenna input, and RS-232C/external control.',
    'Input and output ports: HDMI inputs, HDMI eARC, USB ports, Ethernet, optical audio output, RF antenna input, and RS-232C/external control.'],
  [audio, 'Audio capabilities: 2 x 10W speakers.', 'Audio capabilities: 2 x 10W speakers.'],
  [display, 'Display and picture specifications: 4K UHD resolution, 100/120 Hz refresh rate, HDR10, and Dolby Vision.',
    'LG 86NANO90UNA official specifications list 4K UHD resolution, 100/120 Hz refresh rate, HDR10, and Dolby Vision.'],
  [display, 'Display and picture specifications: 4K UHD resolution and 100/120 Hz refresh rate.',
    'LG 86NANO90UNA specifications include 4K UHD resolution and 100/120 Hz refresh rate.'],
];

export const homeGraphRepairProfileValues = values([
  ['LG 86NANO90UNA TV features include Dolby Vision IQ, HDR10,\nHDMI eARC, Filmmaker Mode, Game Optimizer, and Magic Remote voice control.', [display, ports, gaming]],
  ['The LG 86NANO90UNA supports Dolby Vision HDR, HDMI eARC, and Game Optimizer.', [display, ports, gaming]],
  ['DTV Audio Supported Codec: MPEG and Dolby Digital.', [audio]],
  ['The reference device supports Wi-Fi wireless connectivity for its network connection.', [network]],
  ['The reference device has 4K UHD 3840 x 2160 resolution, 120 Hz, HDMI 2.1, USB, Ethernet, Bluetooth, Wi-Fi, and 2 x 10W speakers.', [display, ports, network, audio]],
  ['LG 86NANO90UNA has 4K UHD 3840 x 2160, HDR10, Dolby Vision, 120 Hz, HDMI 2.1, USB, Ethernet, Bluetooth, Wi-Fi, and 2 x 10W speakers.', [display, ports, network, audio]],
]);
