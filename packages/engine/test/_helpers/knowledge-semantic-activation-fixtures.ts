import { beforeEach } from 'bun:test';
import type { KnowledgeStore } from '../../sdk/src/platform/knowledge/store.js';
import type { KnowledgeNodeUpsertInput } from '../../sdk/src/platform/knowledge/types.js';
import { upsertObservedKnowledgeNode } from '../../sdk/src/platform/knowledge/store-node-observation.js';
import type { useKnowledgeAnswerReadings } from './knowledge-answer-readings.js';

/** Explicit plumbing for the authored synthetic manuals/provider outputs in the four semantic suites. */
export function useSemanticActivationFixtures(readings: ReturnType<typeof useKnowledgeAnswerReadings>): void {
  beforeEach(() => readings.setActivation([
    ['Device', 0.99], ['Device knowledge page', 0.99], ['Living Room TV knowledge page', 0.99],
    ['Dolby Vision support', 0.99], ['HDMI inputs', 0.99], ['HDMI support', 0.99], ['NanoCell 4K feature set', 0.99],
    ['Display and picture specifications', 0.99], ['Input and output ports', 0.99], ['Smart TV platform and integrations', 0.99],
    ['Network and wireless capabilities', 0.99], ['Gaming and HDMI features', 0.99], ['Audio capabilities', 0.99],
    ['Tuner and broadcast support', 0.99], ['Native refresh rate', 0.99], ['TV feature', 0.99], ['Display features', 0.99],
    // Exact source-backed sentence/entity/page outputs of these synthetic fixtures.
    ["Clean the TV with a dry cloth", 0.99],
    ["Deterministic manual", 0.99],
    ["Deterministic manual knowledge page", 0.99],
    ["External Devices Supported USB to Serial SERVICE ONLY", 0.99],
    ["Fasten the stand screws to prevent the TV from overturning during setup", 0.99],
    ["Features include energy monitoring, Matter support, scheduling, and away mode", 0.99],
    ["Features include energy monitoring, Matter support, scheduling, and away mode.", 0.99],
    ["Kasa Smart Wi-Fi Plug Slim with Energy Monitoring", 0.99],
    ["Kasa Smart Wi-Fi Plug Slim with Energy Monitoring knowledge page", 0.99],
    ["Kasa plug manual", 0.99],
    ["Kasa plug manual knowledge page", 0.99],
    ["LG 86NANO90UNA TV has 4K NanoCell display, HDR10, Dolby Vision, HDMI eARC, and webOS smart TV f\u2026", 0.99],
    ["LG 86NANO90UNA has webOS smart TV features and a 4K NanoCell display", 0.99],
    ["LG 86NANO90UNA manual", 0.99],
    ["LG 86NANO90UNA manual knowledge page", 0.99],
    ["LG 86NANO90UNA official specifications", 0.99],
    ["LG 86NANO90UNA official specifications knowledge page", 0.99],
    ["LG 86NANO90UNA product specifications knowledge page", 0.99],
    ["LG 86NANO90UNA specifications include a 4K UHD NanoCell display, 120 Hz refresh rate, HDR10, Do\u2026", 0.99],
    ["LG 86NANO90UNA supports HDMI eARC, HDR10, Dolby Vision, and webOS smart TV features", 0.99],
    ["LG TV feature sheet", 0.99],
    ["LG TV feature sheet knowledge page", 0.99],
    ["LG TV manual", 0.99],
    ["LG TV manual knowledge page", 0.99],
    ["LG TV setup note", 0.99],
    ["LG TV setup note knowledge page", 0.99],
    ["LG TV supports HDR10, HDMI eARC, Filmmaker Mode, Game Optimizer, and Magic Remote voice control", 0.99],
    ["LG source", 0.99],
    ["LG source knowledge page", 0.99],
    ["Manual 4 knowledge page", 0.99],
    ["REFER TO QUALIFIED SERVICE PERSONNEL", 0.99],
    ["Refer all servicing to qualified personnel and contact customer service for repair", 0.99],
    ["Router network notes", 0.99],
    ["Router network notes knowledge page", 0.99],
    ["Smart TV users can stream Plex from this NAS, but the GL.iNet MT6000 has Wi-Fi 6 routing, NAS storage shares, WireGuard VPN, firewall rules, and Ethernet services.", 0.99],
    ["Superseded display page", 0.99],
    ["Superseded display page knowledge page", 0.99],
    ["TV supports Dolby Vision", 0.99],
    ["The LG 86NANO90UNA TV has 4K NanoCell display, HDR10, Dolby Vision, HDMI eARC, and webOS smart TV features.", 0.99],
    ["The LG TV supports HDR10, HDMI eARC, Filmmaker Mode, Game Optimizer, and Magic Remote voice control. Ultra High Speed HDMI cables are optional extras and may be purchased separately. Fasten the stand screws to prevent the TV from overturning during setup. Recommended HDMI cable types (3 m (9. New features may be added to this TV in the future. Magic Remote Control buttons \u25b2 \u25bc \u25c4 \u25ba may vary depending upon model. The Magic Remote batteries may be low. REFER TO QUALIFIED SERVICE PERSONNEL. This remote uses infrared light and must be pointed toward the remote control sensor on the TV. Crutchfield SpeakerCompare gives you a sense of equal-power and equal-volume speaker differences. Shake the Magic Remote to make the pointer appear on the screen. However, if the device does not support it, it may not work properly. In that case, change the TV HDMI Ultra HD Deep Color setting to off. Refer all servicing to qualified personnel and contact customer service for repair. Clean the TV with a dry cloth.", 0.99],
    ["The LG webOS Smart TV is installed in Home Assistant.", 0.99],
    ["Warning: do not use uncertified HDMI cables", 0.99],
    ["controller has USB-C power", 0.99],
    ["controller includes local control mode", 0.99],
    ["controller supports Wi-Fi configuration", 0.99],
    ["display", 0.99],
    ["home-graph", 0.99],
    ["homeassistant", 0.99],
    ["manual", 0.99],
    ["note", 0.99],
    ["plug", 0.99],
    ["semantic-gap-repair", 0.99],
    ["smart plug features energy monitoring and scheduling", 0.99],
    ["tv", 0.99],
    ['Manual 0 knowledge page', 0.99],
    ['Manual 1 knowledge page', 0.99],
    ['Manual 2 knowledge page', 0.99],
    ['Manual 3 knowledge page', 0.99],
  ]));
}

/** A synthetic pending research question is task bookkeeping, never a served factual claim. */
export function seedKnowledgeResearchTask(store: KnowledgeStore, input: KnowledgeNodeUpsertInput) {
  if (input.kind !== 'knowledge_gap') throw new Error('Research-task fixture requires a knowledge gap');
  const evidence = structuredClone(input);
  return upsertObservedKnowledgeNode(store, input, 'research-task', evidence, () => evidence);
}
